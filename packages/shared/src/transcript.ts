import { z } from "zod";

/**
 * Transcript contracts.
 *
 * A {@link Segment} is one timestamped utterance attributed to a speaker
 * (`speaker` is a real Discord display name, resolved by capture — never
 * "Speaker 1"). A {@link MergedTranscript} is the chronological merge of all
 * per-speaker segments across a call.
 */

export const SegmentSchema = z.object({
  /** Real display name of the speaker. */
  speaker: z.string().min(1),
  /** Start of the segment in ms from call start. */
  startMs: z.number().int().nonnegative(),
  /** End of the segment in ms from call start; must be >= startMs. */
  endMs: z.number().int().nonnegative(),
  text: z.string(),
}).refine((s) => s.endMs >= s.startMs, {
  message: "endMs must be >= startMs",
  path: ["endMs"],
});
export type Segment = z.infer<typeof SegmentSchema>;

export const MergedTranscriptSchema = z.object({
  callId: z.string().min(1),
  /** Segments sorted ascending by startMs. */
  segments: z.array(SegmentSchema),
});
export type MergedTranscript = z.infer<typeof MergedTranscriptSchema>;

/**
 * Merge per-speaker segment lists into a single chronological transcript.
 * Pure: stable sort by `startMs`, then `endMs`, then `speaker`. Does not read
 * the clock. Validates the result so malformed segments fail fast.
 */
export function mergeTranscripts(
  callId: string,
  perSpeaker: readonly Segment[][],
): MergedTranscript {
  const segments = perSpeaker
    .flat()
    .slice()
    .sort(
      (a, b) =>
        a.startMs - b.startMs ||
        a.endMs - b.endMs ||
        a.speaker.localeCompare(b.speaker),
    );
  return MergedTranscriptSchema.parse({ callId, segments });
}

/** Render a merged transcript as plain, speaker-labeled text for the LLM prompt. */
export function renderTranscriptText(transcript: MergedTranscript): string {
  return transcript.segments
    .map((s) => `${s.speaker}: ${s.text}`)
    .join("\n");
}
