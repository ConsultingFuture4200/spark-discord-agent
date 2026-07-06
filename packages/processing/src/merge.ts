import {
  mergeTranscripts,
  type MergedTranscript,
  type Segment,
  type SpeakerTrack,
} from "@discord-agent/shared";
import type { RawSegment } from "./ports.js";

/**
 * Timestamp merge (FR-15).
 *
 * STT produces per-track segments whose timestamps are relative to the start of
 * that track's audio. Each {@link SpeakerTrack} carries `startOffsetMs` — when
 * the speaker's recording began relative to the call's start. Shifting every
 * segment by that offset and stamping it with the speaker's real display name
 * (FR-16) puts all tracks on one common call timeline; the shared
 * `mergeTranscripts` then interleaves them chronologically.
 *
 * Pure and deterministic: no clock reads, no I/O.
 */

/**
 * Shift one track's raw segments onto the call timeline and label them with the
 * speaker's display name. Segments with empty/whitespace-only text are dropped
 * (Whisper emits blank segments for silence).
 */
export function labelTrackSegments(
  track: SpeakerTrack,
  raw: readonly RawSegment[],
): Segment[] {
  const segments: Segment[] = [];
  for (const s of raw) {
    if (s.text.trim().length === 0) continue;
    segments.push({
      speaker: track.displayName,
      startMs: s.startMs + track.startOffsetMs,
      endMs: s.endMs + track.startOffsetMs,
      text: s.text,
    });
  }
  return segments;
}

/**
 * Merge all per-track transcriptions into one chronological, speaker-labeled
 * {@link MergedTranscript}. Applies each track's `startOffsetMs`, then defers to
 * the shared chronological merge (stable sort by startMs, endMs, speaker).
 */
export function mergeTrackTranscripts(
  callId: string,
  perTrack: readonly { track: SpeakerTrack; segments: readonly RawSegment[] }[],
): MergedTranscript {
  const labeled = perTrack.map(({ track, segments }) =>
    labelTrackSegments(track, segments),
  );
  return mergeTranscripts(callId, labeled);
}
