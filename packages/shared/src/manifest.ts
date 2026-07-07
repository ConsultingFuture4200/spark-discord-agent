import { z } from "zod";

/**
 * Call manifest + per-speaker track descriptor + status state machine.
 *
 * These are the on-disk contracts the capture service writes and the
 * processing service reads. All timestamps are ISO-8601 strings that the
 * caller supplies — nothing in this module reads the clock, so the types stay
 * pure and testable.
 */

/** State machine for a call's `status.json`, in normal progression order. */
export const CallStatusSchema = z.enum([
  "recording",
  "ready-to-process",
  "transcribing",
  "summarizing",
  "delivered",
  "failed",
]);
export type CallStatus = z.infer<typeof CallStatusSchema>;

/** Ordered list of the non-terminal → terminal states, for reference/validation. */
export const CALL_STATUS_ORDER: readonly CallStatus[] = [
  "recording",
  "ready-to-process",
  "transcribing",
  "summarizing",
  "delivered",
] as const;

/**
 * One recorded audio track for a single speaker.
 * `startOffsetMs` is the track's start relative to the call's `startedAt`,
 * so per-speaker transcripts can be merged onto a common timeline.
 */
export const SpeakerTrackSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  /** Filesystem path to the raw audio track (relative to the call dir or absolute). */
  path: z.string().min(1),
  startOffsetMs: z.number().int().nonnegative(),
});
export type SpeakerTrack = z.infer<typeof SpeakerTrackSchema>;

/**
 * An aligned video recording of the call (OBS). Present only when video was
 * captured. `startOffsetMs` is the SIGNED difference wallclock(video start) −
 * wallclock(call start): positive when OBS started after the call began. Used by
 * {@link videoTimeForSegmentMs} to map transcript segments onto the video.
 */
export const VideoDescriptorSchema = z.object({
  /** Path in the call dir (e.g. "video.mp4") or the OBS path if not copyable. */
  path: z.string().min(1),
  /** ISO-8601 wall-clock of the video's first frame (OBS start). */
  startedAt: z.string().datetime(),
  /** Signed ms = wallclock(video start) − wallclock(call start). */
  startOffsetMs: z.number().int(),
});
export type VideoDescriptor = z.infer<typeof VideoDescriptorSchema>;

/**
 * The manifest written once per call. `endedAt` is null while recording is
 * still in progress and set to an ISO string when the call ends.
 */
export const CallManifestSchema = z.object({
  callId: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  /** ISO-8601 start timestamp, supplied by the caller. */
  startedAt: z.string().datetime(),
  /** ISO-8601 end timestamp, or null while still recording. */
  endedAt: z.string().datetime().nullable(),
  tracks: z.array(SpeakerTrackSchema),
  /** Aligned video recording, absent when no video was captured. */
  video: VideoDescriptorSchema.optional(),
});
export type CallManifest = z.infer<typeof CallManifestSchema>;

/** The full `status.json` document: current state + the timestamps of transitions. */
export const CallStatusFileSchema = z.object({
  callId: z.string().min(1),
  status: CallStatusSchema,
  /** ISO-8601 timestamp of the last status write, supplied by the caller. */
  updatedAt: z.string().datetime(),
  /** Populated when `status === "failed"`. */
  error: z.string().optional(),
  /**
   * The Discord thread a summary was posted to. Set once the post succeeds and
   * carried across a crash-recovery reclaim so a re-run never double-posts
   * (post-leg delivery idempotency).
   */
  threadId: z.string().optional(),
  /**
   * ISO-8601 timestamp the summary email was sent. Tracked independently of
   * `threadId` so a reclaim re-attempts only the unfinished delivery leg — a
   * crash after the Discord post but before the email re-sends only the email.
   */
  emailedAt: z.string().datetime().optional(),
});
export type CallStatusFile = z.infer<typeof CallStatusFileSchema>;

/**
 * Build a manifest. Pure — the caller passes ISO timestamps; this never calls
 * `Date.now()`. Validates via zod so an invalid manifest fails at construction.
 */
export function createCallManifest(input: {
  callId: string;
  guildId: string;
  channelId: string;
  startedAt: string;
  endedAt?: string | null;
  tracks?: SpeakerTrack[];
  video?: VideoDescriptor;
}): CallManifest {
  return CallManifestSchema.parse({
    callId: input.callId,
    guildId: input.guildId,
    channelId: input.channelId,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    tracks: input.tracks ?? [],
    ...(input.video ? { video: input.video } : {}),
  });
}

/**
 * Map a transcript segment's call-relative start (`segmentStartMs`, ms from call
 * start) onto its position in the aligned video: `max(0, segmentStartMs −
 * video.startOffsetMs)`. Clamped at 0 so a segment that predates the video's
 * first frame maps to the video's start. Pure — no clock reads.
 */
export function videoTimeForSegmentMs(
  segmentStartMs: number,
  video: { startOffsetMs: number },
): number {
  return Math.max(0, segmentStartMs - video.startOffsetMs);
}
