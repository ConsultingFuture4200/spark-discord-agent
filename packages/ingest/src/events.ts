/**
 * Ingest event contracts — plain, Discord-library-free shapes.
 *
 * The capture service adapts discord.js objects into these; the processing
 * service passes its existing shared-contract outputs (manifest, transcript,
 * summary) straight through. Keeping the shapes library-free means every
 * emitter path is fixture-testable with no Discord client or token.
 */
import type {
  CallManifest,
  CallSummary,
  MergedTranscript,
} from "@discord-agent/shared";

/** One message attachment, as captured at emit time. */
export interface AttachmentInfo {
  id: string;
  url: string;
  filename: string;
  /** MIME type as reported by Discord (e.g. "image/png"), when known. */
  contentType?: string;
}

/** A created (or edited — same shape) guild message. */
export interface MessageEvent {
  guildId: string;
  /** The parent text channel. For thread messages this is the thread's parent. */
  channelId: string;
  /** Set when the message was posted inside a thread. */
  threadId?: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  /** ISO-8601 creation (or edit) timestamp. */
  timestamp: string;
  /** The message this one replies to, when it is a reply. */
  replyToMessageId?: string;
  mentionUserIds: readonly string[];
  attachments: readonly AttachmentInfo[];
}

/** A deleted guild message (Discord delivers only ids on delete). */
export interface MessageDeleteEvent {
  guildId: string;
  channelId: string;
  messageId: string;
}

/**
 * The finished output of one processed call, exactly as the processing
 * pipeline already produces it (shared contracts). Participant identity
 * (userId + displayName) comes from `manifest.tracks`.
 */
export interface CallOutputEvent {
  manifest: CallManifest;
  transcript: MergedTranscript;
  summary: CallSummary;
}

/** What one emit handled: memories/edges written, or why it was skipped. */
export interface EmitResult {
  memories: number;
  edges: number;
  /** Set when the consent gate (or dedupe) stopped the emit; nothing was sent. */
  skipped?: string;
}
