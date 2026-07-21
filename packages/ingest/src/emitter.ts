import type { Segment } from "@discord-agent/shared";
import { channelAllowed, memberOptedOut, type ConsentConfig } from "./consent.js";
import type { IngestEventResult, IngestEventSink } from "./client.js";
import type {
  AttachmentInfo,
  CallOutputEvent,
  EmitResult,
  MessageDeleteEvent,
  MessageEvent,
} from "./events.js";

/**
 * The ingest emitter — translates bot events into gBrain ingest events and
 * POSTs them to `POST /ingest/event` (PRD §5). ALL graph construction —
 * anchor nodes, edges, supersedes handling, media download/transcribe/caption
 * — lives server-side in gBrain's EventIngestor, next to the single writer
 * (PRD D2), where dedupe is DB-backed (keyed on each node's canonical
 * `source` ref). Re-emitting an event is therefore a server-side no-op, with
 * no client-side id map to drift or lose.
 *
 * What stays client-side is consent (PRD D8), checked at emit time:
 * - channel allowlist gates messages and calls (default DENY);
 * - opted-out members' messages are dropped, their mentions filtered, their
 *   speech removed from transcripts/summaries, and their action-item
 *   ownership anonymized before anything leaves the bot.
 */

export interface IngestEmitterDeps {
  /** The direct GbrainClient, or an EventOutbox for durable spooling. */
  client: IngestEventSink;
  consent: ConsentConfig;
  /** gBrain region column for every stored node (defaults to "discord"). */
  region?: string;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

/** Attachment content types (or extensions) treated as media to ingest. */
const MEDIA_EXTENSIONS = /\.(mp4|mov|mkv|webm|avi|png|jpe?g|gif|webp)$/i;

function isMediaAttachment(a: AttachmentInfo): boolean {
  if (a.contentType) {
    return a.contentType.startsWith("image/") || a.contentType.startsWith("video/");
  }
  return MEDIA_EXTENSIONS.test(a.filename);
}

/** gBrain's canonical message source ref (events.ts sourceRefs.message). */
export function messageSourceRef(channelId: string, messageId: string): string {
  return `discord://channel/${channelId}/message/${messageId}`;
}

export class IngestEmitter {
  private readonly region: string;

  constructor(private readonly deps: IngestEmitterDeps) {
    this.region = deps.region ?? "discord";
  }

  /**
   * Ingest a created message: one `message` event (gBrain builds the
   * member/channel/thread anchors and authored/in_channel/in_thread/
   * replies_to/mentions edges), plus one `media` event per video/image
   * attachment (gBrain's pipeline downloads, transcribes and captions it
   * into transcript_chunk/media_caption nodes with attached_to edges).
   */
  async handleMessage(ev: MessageEvent): Promise<EmitResult> {
    const gate = this.gateMessage(ev);
    if (gate) return gate;
    return this.emitMessage(ev, false);
  }

  /**
   * Ingest an edited message: the same `message` event with `edited: true` —
   * gBrain stores a NEW node superseding the stored one (append-only,
   * PRD D6) and excludes the stale version from recall.
   */
  async handleMessageEdit(ev: MessageEvent): Promise<EmitResult> {
    const gate = this.gateMessage(ev);
    if (gate) return gate;
    return this.emitMessage(ev, true);
  }

  /**
   * Record a deletion as a tombstone request — gBrain appends it to its
   * pending-tombstones ledger; actually deleting is blocked on the engine's
   * tombstone surface (PRD D6 / §8 dogfood ledger). Emitted regardless of
   * the channel allowlist: a removal request must never be lost, and gBrain
   * records it even when the target ref resolves to nothing.
   */
  async handleMessageDelete(ev: MessageDeleteEvent): Promise<EmitResult> {
    await this.deps.client.postEvent({
      type: "tombstone-request",
      target: messageSourceRef(ev.channelId, ev.messageId),
      reason: "discord message deleted",
    });
    return { memories: 0, edges: 0 };
  }

  /** Ingest (or refresh) a member identity node. Respects opt-out. */
  async handleMember(userId: string, displayName: string): Promise<EmitResult> {
    if (memberOptedOut(this.deps.consent, userId)) {
      return { memories: 0, edges: 0, skipped: "member opted out" };
    }
    const result = await this.deps.client.postEvent({
      type: "member",
      member_id: userId,
      display_name: displayName,
      region: this.region,
    });
    return this.toEmitResult(result);
  }

  /**
   * Ingest a processed call as one `transcript` event (chunks, spoke_in /
   * part_of_call edges) and one `summary` event (call_summary, topic nodes +
   * about edges, decision/action_item nodes, per-speaker speaker_turn nodes)
   * — the graph topology PRD §3 names, built by gBrain's EventIngestor. The
   * voice channel must be allowlisted; opted-out members are filtered out of
   * segments and per-speaker sections, and their action-item ownership is
   * anonymized, before anything is sent.
   */
  async handleCallOutput(ev: CallOutputEvent): Promise<EmitResult> {
    const { manifest, transcript, summary } = ev;
    if (!channelAllowed(this.deps.consent, manifest.channelId)) {
      return { memories: 0, edges: 0, skipped: "channel not allowlisted" };
    }

    // Participant identity: display name → userId from the manifest tracks.
    const userIdByName = new Map<string, string>();
    for (const track of manifest.tracks) {
      userIdByName.set(track.displayName, track.userId);
    }
    const speakerAllowed = (displayName: string): boolean => {
      const userId = userIdByName.get(displayName);
      return userId === undefined || !memberOptedOut(this.deps.consent, userId);
    };
    const anonymizeOwner = (owner: string): string =>
      speakerAllowed(owner) ? owner : "unassigned";

    const segments: Segment[] = transcript.segments.filter((s) => speakerAllowed(s.speaker));
    const transcriptResult = await this.deps.client.postEvent({
      type: "transcript",
      call_id: manifest.callId,
      channel_id: manifest.channelId,
      segments,
      region: this.region,
    });

    const summaryResult = await this.deps.client.postEvent({
      type: "summary",
      call_id: manifest.callId,
      summary: {
        fullCall: {
          // gBrain requires a non-empty overview (the call anchor's text).
          overview:
            summary.fullCall.overview.trim() !== ""
              ? summary.fullCall.overview
              : `Call ${manifest.callId}`,
          keyTopics: summary.fullCall.keyTopics,
          decisions: summary.fullCall.decisions,
          openQuestions: summary.fullCall.openQuestions,
          actionItems: summary.fullCall.actionItems.map((item) => ({
            owner: anonymizeOwner(item.owner),
            item: item.item,
          })),
        },
        perSpeaker: summary.perSpeaker.filter((s) => speakerAllowed(s.displayName)),
      },
      region: this.region,
    });

    const combined = this.combine([transcriptResult, summaryResult]);
    this.deps.logger?.info(
      `ingested call ${manifest.callId}: ${combined.memories} memories, ${combined.edges} edges`,
    );
    return combined;
  }

  // --- internals -------------------------------------------------------------

  /** Consent gate shared by create/edit. Returns a skip result, or null to proceed. */
  private gateMessage(ev: MessageEvent): EmitResult | null {
    if (!channelAllowed(this.deps.consent, ev.channelId)) {
      return { memories: 0, edges: 0, skipped: "channel not allowlisted" };
    }
    if (memberOptedOut(this.deps.consent, ev.authorId)) {
      return { memories: 0, edges: 0, skipped: "author opted out" };
    }
    return null;
  }

  private async emitMessage(ev: MessageEvent, edited: boolean): Promise<EmitResult> {
    const results: IngestEventResult[] = [];

    // Attachment-only messages have no text to store — gBrain rejects empty
    // content — but their media events below still round-trip.
    if (ev.content.trim() !== "") {
      results.push(
        await this.deps.client.postEvent({
          type: "message",
          message_id: ev.messageId,
          channel_id: ev.channelId,
          author_id: ev.authorId,
          author_name: ev.authorName,
          content: ev.content,
          guild_id: ev.guildId,
          ...(ev.threadId !== undefined ? { thread_id: ev.threadId } : {}),
          ...(ev.replyToMessageId !== undefined ? { reply_to: ev.replyToMessageId } : {}),
          mentions: ev.mentionUserIds.filter(
            (id) => !memberOptedOut(this.deps.consent, id),
          ),
          edited,
          timestamp: ev.timestamp,
          region: this.region,
        }),
      );
    }

    for (const attachment of ev.attachments) {
      if (!isMediaAttachment(attachment)) continue;
      results.push(
        await this.deps.client.postEvent({
          type: "media",
          media_id: attachment.id,
          url: attachment.url,
          filename: attachment.filename,
          ...(attachment.contentType !== undefined
            ? { content_type: attachment.contentType }
            : {}),
          channel_id: ev.channelId,
          message_id: ev.messageId,
          region: this.region,
        }),
      );
    }

    return this.combine(results);
  }

  private toEmitResult(result: IngestEventResult): EmitResult {
    return this.combine([result]);
  }

  private combine(results: IngestEventResult[]): EmitResult {
    let memories = 0;
    let edges = 0;
    for (const r of results) {
      memories += r.ids?.length ?? 0;
      edges += r.edges ?? 0;
      for (const warning of r.warnings ?? []) {
        this.deps.logger?.warn(`gBrain ingest: ${warning}`);
      }
    }
    return { memories, edges };
  }
}
