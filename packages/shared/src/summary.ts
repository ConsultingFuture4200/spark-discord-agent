import { z } from "zod";

/**
 * The LLM output contract — the JSON the summarization model must return.
 *
 * The processing service validates raw model output against
 * {@link CallSummarySchema}; anything that does not parse is a failed
 * summarization (retry / repair), never posted as-is.
 */

export const ActionItemSchema = z.object({
  /** Who owns the item — a display name, or "unassigned". */
  owner: z.string().min(1),
  item: z.string().min(1),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

/** Whole-call section: the shared view of the meeting. */
export const FullCallSummarySchema = z.object({
  overview: z.string(),
  keyTopics: z.array(z.string()),
  decisions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  actionItems: z.array(ActionItemSchema),
});
export type FullCallSummary = z.infer<typeof FullCallSummarySchema>;

/** Per-participant section: one entry per speaker. */
export const SpeakerSummarySchema = z.object({
  displayName: z.string().min(1),
  contributions: z.array(z.string()),
  positionsConcerns: z.array(z.string()),
  actionItems: z.array(ActionItemSchema),
});
export type SpeakerSummary = z.infer<typeof SpeakerSummarySchema>;

/** The complete dual summary: full-call + per-speaker. This is the LLM contract. */
export const CallSummarySchema = z.object({
  fullCall: FullCallSummarySchema,
  perSpeaker: z.array(SpeakerSummarySchema),
});
export type CallSummary = z.infer<typeof CallSummarySchema>;

/**
 * Validate raw (already JSON-parsed) model output against the summary contract.
 * Returns a discriminated result so callers can branch on success without a
 * try/catch. Pure.
 */
export function parseCallSummary(
  raw: unknown,
): { ok: true; summary: CallSummary } | { ok: false; error: z.ZodError } {
  const result = CallSummarySchema.safeParse(raw);
  return result.success
    ? { ok: true, summary: result.data }
    : { ok: false, error: result.error };
}
