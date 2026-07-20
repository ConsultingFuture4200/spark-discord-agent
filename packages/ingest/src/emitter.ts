import type { Segment } from "@discord-agent/shared";
import { channelAllowed, memberOptedOut, type ConsentConfig } from "./consent.js";
import type { GbrainClient } from "./client.js";
import type {
  AttachmentInfo,
  CallOutputEvent,
  EmitResult,
  MessageDeleteEvent,
  MessageEvent,
} from "./events.js";
import type { IdMap } from "./idmap.js";
import {
  actionItemUri,
  attachmentUri,
  callUri,
  channelUri,
  decisionUri,
  memberUri,
  messageUri,
  threadUri,
  tombstoneUri,
  transcriptChunkUri,
} from "./uris.js";

/**
 * The ingest emitter — converts bot events into gBrain memory nodes + typed
 * graph edges (PRD §3) over the gBrain HTTP surface (`POST /memory`,
 * `POST /edge`). Consent (PRD D8) is checked here, at emit time.
 *
 * Node kinds emitted: `message`, `member`, `transcript_chunk`,
 * `call_summary`, `decision`, `action_item` (per PRD §3), plus three
 * pragmatic extensions:
 * - `channel` / `thread` — anchor nodes so `in_channel` / `in_thread` edges
 *   have a destination (the PRD edge list requires them but names no node).
 * - `tombstone_request` — a Discord deletion recorded as a queued removal
 *   request; the engine's delete surface is upstream work (PRD D6), so gBrain
 *   stores the request until tombstones are exposed.
 * - `media_ingest_request` — a video/image attachment pointer (URL +
 *   metadata); the media pipeline (download/transcribe/caption) lives in
 *   gBrain, not in the bot.
 *
 * Edge directions: `authored` member→message, `in_channel` message→channel,
 * `in_thread` message→thread, `replies_to` reply→original, `mentions`
 * message→member, `spoke_in` member→chunk, `part_of_call` chunk→call,
 * `decided_in` decision/action_item→call, `assigned_to` action_item→member,
 * `attached_to` media_request→message. `supersedes` edges are written by
 * gBrain itself via the `supersedes` field on `POST /memory`.
 *
 * Idempotency: every node's source URI is recorded in the {@link IdMap};
 * re-emitting an event whose primary URI is already mapped is a no-op skip,
 * so crash-replays never double-store.
 */

export interface IngestEmitterDeps {
  client: GbrainClient;
  idMap: IdMap;
  consent: ConsentConfig;
  /** gBrain region column for every stored node (defaults to "discord"). */
  region?: string;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

/** Max characters of transcript text per `transcript_chunk` node. */
const MAX_CHUNK_CHARS = 1200;

/** Attachment content types (or extensions) treated as media to ingest. */
const MEDIA_EXTENSIONS = /\.(mp4|mov|mkv|webm|avi|png|jpe?g|gif|webp)$/i;

function isMediaAttachment(a: AttachmentInfo): boolean {
  if (a.contentType) {
    return a.contentType.startsWith("image/") || a.contentType.startsWith("video/");
  }
  return MEDIA_EXTENSIONS.test(a.filename);
}

export class IngestEmitter {
  private readonly region: string;

  constructor(private readonly deps: IngestEmitterDeps) {
    this.region = deps.region ?? "discord";
  }

  /**
   * Ingest a created message: member/channel/thread anchors, the message
   * node, and its authored/in_channel/in_thread/replies_to/mentions edges.
   * Media attachments each emit a `media_ingest_request` node.
   */
  async handleMessage(ev: MessageEvent): Promise<EmitResult> {
    const gate = this.gateMessage(ev);
    if (gate) return gate;
    const uri = messageUri(ev.guildId, ev.channelId, ev.messageId);
    if (this.deps.idMap.has(uri)) {
      return { memories: 0, edges: 0, skipped: "already ingested" };
    }
    return this.storeMessage(ev, uri, undefined);
  }

  /**
   * Ingest an edited message: a NEW node superseding the original (append-only,
   * PRD D6 — gBrain writes the `supersedes` edge and excludes the stale
   * version from recall). The id map is repointed at the new node so later
   * replies/mentions edge against the live version.
   */
  async handleMessageEdit(ev: MessageEvent): Promise<EmitResult> {
    const gate = this.gateMessage(ev);
    if (gate) return gate;
    const uri = messageUri(ev.guildId, ev.channelId, ev.messageId);
    const supersedes = this.deps.idMap.get(uri);
    return this.storeMessage(ev, uri, supersedes);
  }

  /**
   * Record a deletion as a `tombstone_request` node — gBrain queues the
   * removal request; actually deleting is blocked on the engine's tombstone
   * surface (PRD D6 / §8 dogfood ledger). Emitted regardless of the channel
   * allowlist: a removal request must always be honored, but it is skipped
   * when nothing was ever ingested for the message.
   */
  async handleMessageDelete(ev: MessageDeleteEvent): Promise<EmitResult> {
    const targetUri = messageUri(ev.guildId, ev.channelId, ev.messageId);
    const targetId = this.deps.idMap.get(targetUri);
    if (targetId === undefined) {
      return { memories: 0, edges: 0, skipped: "message was never ingested" };
    }
    const uri = tombstoneUri(ev.guildId, ev.channelId, ev.messageId);
    if (this.deps.idMap.has(uri)) {
      return { memories: 0, edges: 0, skipped: "already ingested" };
    }
    const id = await this.store({
      text: `Tombstone request: delete memory ${targetId} (${targetUri}) — the Discord message was deleted.`,
      kind: "tombstone_request",
      source: uri,
    });
    await this.deps.idMap.set(uri, id);
    await this.deps.client.createEdge(id, targetId, "about");
    return { memories: 1, edges: 1 };
  }

  /** Ingest (or refresh) a member identity node. Respects opt-out. */
  async handleMember(userId: string, displayName: string): Promise<EmitResult> {
    if (memberOptedOut(this.deps.consent, userId)) {
      return { memories: 0, edges: 0, skipped: "member opted out" };
    }
    const { created } = await this.ensureNode(memberUri(userId), {
      text: displayName,
      kind: "member",
    });
    return { memories: created ? 1 : 0, edges: 0 };
  }

  /**
   * Ingest a processed call: transcript chunks (`spoke_in`/`part_of_call`),
   * the `call_summary` node, and `decision`/`action_item` nodes with
   * `decided_in`/`assigned_to` edges — all built from the outputs the
   * processing package already produces. The voice channel must be
   * allowlisted; opted-out members' speech is filtered out before chunking.
   */
  async handleCallOutput(ev: CallOutputEvent): Promise<EmitResult> {
    const { manifest, transcript, summary } = ev;
    if (!channelAllowed(this.deps.consent, manifest.channelId)) {
      return { memories: 0, edges: 0, skipped: "channel not allowlisted" };
    }
    const callSourceUri = callUri(manifest.callId);
    if (this.deps.idMap.has(callSourceUri)) {
      return { memories: 0, edges: 0, skipped: "already ingested" };
    }

    let memories = 0;
    let edges = 0;

    // Participant identity: display name → userId from the manifest tracks.
    const userIdByName = new Map<string, string>();
    for (const track of manifest.tracks) {
      userIdByName.set(track.displayName, track.userId);
    }
    const speakerAllowed = (displayName: string): boolean => {
      const userId = userIdByName.get(displayName);
      return userId === undefined || !memberOptedOut(this.deps.consent, userId);
    };

    // Member nodes for consenting participants.
    const memberIdByName = new Map<string, number>();
    for (const track of manifest.tracks) {
      if (memberOptedOut(this.deps.consent, track.userId)) continue;
      const { id, created } = await this.ensureNode(memberUri(track.userId), {
        text: track.displayName,
        kind: "member",
      });
      memberIdByName.set(track.displayName, id);
      if (created) memories += 1;
    }

    // The call node (kind call_summary) anchors every part_of_call/decided_in
    // edge. Its text is the full-call overview.
    const summaryText =
      summary.fullCall.overview.trim() !== ""
        ? summary.fullCall.overview
        : `Call ${manifest.callId}`;
    const callId = await this.store({
      text: summaryText,
      kind: "call_summary",
      source: callSourceUri,
    });
    await this.deps.idMap.set(callSourceUri, callId);
    memories += 1;
    const { id: chanId, created: chanCreated } = await this.ensureNode(
      channelUri(manifest.guildId, manifest.channelId),
      { text: `channel ${manifest.channelId}`, kind: "channel" },
    );
    if (chanCreated) memories += 1;
    await this.deps.client.createEdge(callId, chanId, "in_channel");
    edges += 1;

    // Transcript chunks (consenting speakers only).
    const segments = transcript.segments.filter((s) => speakerAllowed(s.speaker));
    const chunks = chunkSegments(segments, MAX_CHUNK_CHARS);
    for (const [index, chunk] of chunks.entries()) {
      const chunkId = await this.store({
        text: chunk.text,
        kind: "transcript_chunk",
        source: transcriptChunkUri(manifest.callId, index),
      });
      await this.deps.idMap.set(transcriptChunkUri(manifest.callId, index), chunkId);
      memories += 1;
      await this.deps.client.createEdge(chunkId, callId, "part_of_call");
      edges += 1;
      for (const speaker of chunk.speakers) {
        const memberId = memberIdByName.get(speaker);
        if (memberId === undefined) continue;
        await this.deps.client.createEdge(memberId, chunkId, "spoke_in");
        edges += 1;
      }
    }

    // Decisions.
    for (const [index, decision] of summary.fullCall.decisions.entries()) {
      const id = await this.store({
        text: decision,
        kind: "decision",
        source: decisionUri(manifest.callId, index),
      });
      await this.deps.idMap.set(decisionUri(manifest.callId, index), id);
      memories += 1;
      await this.deps.client.createEdge(id, callId, "decided_in");
      edges += 1;
    }

    // Action items: decided_in the call, assigned_to the owner when the owner
    // resolves to a consenting participant.
    for (const [index, item] of summary.fullCall.actionItems.entries()) {
      const id = await this.store({
        text: `${item.item} (owner: ${item.owner})`,
        kind: "action_item",
        source: actionItemUri(manifest.callId, index),
      });
      await this.deps.idMap.set(actionItemUri(manifest.callId, index), id);
      memories += 1;
      await this.deps.client.createEdge(id, callId, "decided_in");
      edges += 1;
      const ownerId = memberIdByName.get(item.owner);
      if (ownerId !== undefined) {
        await this.deps.client.createEdge(id, ownerId, "assigned_to");
        edges += 1;
      }
    }

    this.deps.logger?.info(
      `ingested call ${manifest.callId}: ${memories} memories, ${edges} edges`,
    );
    return { memories, edges };
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

  private async storeMessage(
    ev: MessageEvent,
    uri: string,
    supersedes: number | undefined,
  ): Promise<EmitResult> {
    let memories = 0;
    let edges = 0;

    const author = await this.ensureNode(memberUri(ev.authorId), {
      text: ev.authorName,
      kind: "member",
    });
    if (author.created) memories += 1;

    const channel = await this.ensureNode(channelUri(ev.guildId, ev.channelId), {
      text: `channel ${ev.channelId}`,
      kind: "channel",
    });
    if (channel.created) memories += 1;

    const msgId = await this.store({
      text: ev.content,
      kind: "message",
      source: uri,
      ...(supersedes !== undefined ? { supersedes } : {}),
    });
    await this.deps.idMap.set(uri, msgId);
    memories += 1;

    await this.deps.client.createEdge(author.id, msgId, "authored");
    await this.deps.client.createEdge(msgId, channel.id, "in_channel");
    edges += 2;

    if (ev.threadId !== undefined) {
      const thread = await this.ensureNode(threadUri(ev.guildId, ev.threadId), {
        text: `thread ${ev.threadId}`,
        kind: "thread",
      });
      if (thread.created) memories += 1;
      await this.deps.client.createEdge(msgId, thread.id, "in_thread");
      edges += 1;
    }

    if (ev.replyToMessageId !== undefined) {
      const targetId = this.deps.idMap.get(
        messageUri(ev.guildId, ev.channelId, ev.replyToMessageId),
      );
      if (targetId !== undefined) {
        await this.deps.client.createEdge(msgId, targetId, "replies_to");
        edges += 1;
      }
    }

    for (const mentionedId of ev.mentionUserIds) {
      if (memberOptedOut(this.deps.consent, mentionedId)) continue;
      const mentioned = this.deps.idMap.get(memberUri(mentionedId));
      if (mentioned === undefined) continue;
      await this.deps.client.createEdge(msgId, mentioned, "mentions");
      edges += 1;
    }

    // Media attachments: emit a media-ingest event (URL + metadata) pointing
    // gBrain's media pipeline at the file; the pipeline itself lives in gBrain.
    for (const attachment of ev.attachments) {
      if (!isMediaAttachment(attachment)) continue;
      const aUri = attachmentUri(ev.messageId, attachment.id);
      if (this.deps.idMap.has(aUri)) continue;
      const mediaId = await this.store({
        text: JSON.stringify({
          url: attachment.url,
          filename: attachment.filename,
          contentType: attachment.contentType ?? null,
          messageId: ev.messageId,
          channelId: ev.channelId,
          guildId: ev.guildId,
        }),
        kind: "media_ingest_request",
        source: aUri,
      });
      await this.deps.idMap.set(aUri, mediaId);
      memories += 1;
      await this.deps.client.createEdge(mediaId, msgId, "attached_to");
      edges += 1;
    }

    return { memories, edges };
  }

  /** Store the node for `uri` unless the map already has it. */
  private async ensureNode(
    uri: string,
    input: { text: string; kind: string },
  ): Promise<{ id: number; created: boolean }> {
    const existing = this.deps.idMap.get(uri);
    if (existing !== undefined) return { id: existing, created: false };
    const id = await this.store({ ...input, source: uri });
    await this.deps.idMap.set(uri, id);
    return { id, created: true };
  }

  private store(input: {
    text: string;
    kind: string;
    source: string;
    supersedes?: number;
  }): Promise<number> {
    return this.deps.client.storeMemory({ ...input, region: this.region });
  }
}

interface TranscriptChunk {
  text: string;
  speakers: readonly string[];
}

/**
 * Group consecutive transcript segments into speaker-labeled text chunks of at
 * most `maxChars` (a chunk always takes at least one segment). Pure.
 */
export function chunkSegments(
  segments: readonly Segment[],
  maxChars: number,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let lines: string[] = [];
  let speakers = new Set<string>();
  let length = 0;

  const flush = (): void => {
    if (lines.length === 0) return;
    chunks.push({ text: lines.join("\n"), speakers: [...speakers] });
    lines = [];
    speakers = new Set();
    length = 0;
  };

  for (const segment of segments) {
    const line = `${segment.speaker}: ${segment.text}`;
    if (length > 0 && length + line.length + 1 > maxChars) flush();
    lines.push(line);
    speakers.add(segment.speaker);
    length += line.length + 1;
  }
  flush();
  return chunks;
}
