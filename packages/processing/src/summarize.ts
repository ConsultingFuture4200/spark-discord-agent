import {
  FullCallSummarySchema,
  parseCallSummary,
  renderTranscriptText,
  SpeakerSummarySchema,
  type CallSummary,
  type FullCallSummary,
  type MergedTranscript,
  type Segment,
  type SpeakerSummary,
} from "@discord-agent/shared";
import { safeJsonParse, zodErrorToString } from "./json.js";
import type { ChatClient, ChatMessage, ValidationResult } from "./ports.js";
import {
  intermediateReduceMessages,
  joinPartialNotes,
  partialNotesMessages,
  reduceFullCallMessages,
  reduceSpeakerMessages,
  singlePassMessages,
  singleSpeakerMessages,
} from "./prompts.js";

/**
 * Adaptive dual summarization (FR-17, FR-18) per DECISIONS open-question #2.
 *
 * Short transcripts (under the token threshold) get one structured JSON call.
 * Long transcripts use map-reduce: chunk → partial notes → reduce into the
 * whole-call section, then a separate per-speaker pass. Every model call that
 * must return JSON is validated against the shared schema with exactly one
 * repair retry. All inference is the local Ollama endpoint (NFR-1).
 */

/** Rough token estimate (~4 chars/token) — enough to pick a strategy. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Above this estimated token count, switch from single-pass to map-reduce. */
export const SINGLE_PASS_TOKEN_THRESHOLD = 8000;

/** Target size of each map-reduce chunk, in estimated tokens. */
export const CHUNK_TOKEN_BUDGET = 4000;

/**
 * Cap for a single partial/intermediate note, in estimated tokens. Bounds each
 * reduce input so the hierarchical fold always makes progress and no note can
 * single-handedly overflow the reduce budget.
 */
export const PARTIAL_NOTE_TOKEN_CAP = 200;

/** Defensively truncate model output to at most `maxTokens` (~4 chars/token). */
function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/** Temperature for summarization — low, for stable structured output. */
const SUMMARY_TEMPERATURE = 0.2;

export type SummaryStrategy = "single" | "map-reduce";

export function chooseSummaryStrategy(
  transcriptText: string,
  threshold = SINGLE_PASS_TOKEN_THRESHOLD,
): SummaryStrategy {
  return estimateTokens(transcriptText) <= threshold ? "single" : "map-reduce";
}

/** Render one segment as a transcript line, matching `renderTranscriptText`. */
function segmentLine(s: Segment): string {
  return `${s.speaker}: ${s.text}`;
}

/**
 * Greedily pack segments into chunks whose rendered text stays under
 * `maxTokens`. Segment boundaries are never split; a single segment larger than
 * the budget becomes its own chunk. Pure and deterministic.
 */
export function chunkSegments(
  segments: readonly Segment[],
  maxTokens = CHUNK_TOKEN_BUDGET,
): Segment[][] {
  const chunks: Segment[][] = [];
  let current: Segment[] = [];
  let currentTokens = 0;

  for (const seg of segments) {
    const segTokens = estimateTokens(segmentLine(seg));
    if (current.length > 0 && currentTokens + segTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(seg);
    currentTokens += segTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Group segments by speaker, preserving first-appearance order, concatenating
 * each speaker's lines.
 */
export function groupBySpeaker(
  segments: readonly Segment[],
): { displayName: string; text: string }[] {
  return groupSegmentsBySpeaker(segments).map((g) => ({
    displayName: g.displayName,
    text: g.segments.map((s) => s.text).join("\n"),
  }));
}

/**
 * Group segments by speaker (first-appearance order), keeping each speaker's
 * segments intact so a long-winded speaker can be chunked independently. Feeds
 * the per-speaker summarization stage.
 */
export function groupSegmentsBySpeaker(
  segments: readonly Segment[],
): { displayName: string; segments: Segment[] }[] {
  const order: string[] = [];
  const bySpeaker = new Map<string, Segment[]>();
  for (const s of segments) {
    let segs = bySpeaker.get(s.speaker);
    if (!segs) {
      segs = [];
      bySpeaker.set(s.speaker, segs);
      order.push(s.speaker);
    }
    segs.push(s);
  }
  return order.map((name) => ({
    displayName: name,
    segments: bySpeaker.get(name) ?? [],
  }));
}

/**
 * Issue a JSON-returning chat call, parse and validate it, and retry once with
 * a corrective message if the first response is invalid (FR-18). Returns the
 * validated value or a human-readable error after the retry.
 */
export async function requestValidatedJson<T>(
  chat: ChatClient,
  model: string,
  messages: ChatMessage[],
  validate: (raw: unknown) => ValidationResult<T>,
): Promise<ValidationResult<T>> {
  const attempt = async (
    msgs: ChatMessage[],
  ): Promise<{ content: string; result: ValidationResult<T> }> => {
    const content = await chat.chat({
      model,
      messages: msgs,
      jsonMode: true,
      temperature: SUMMARY_TEMPERATURE,
    });
    const parsed = safeJsonParse(content);
    if (!parsed.ok) {
      return {
        content,
        result: { ok: false, error: `response was not valid JSON: ${parsed.error}` },
      };
    }
    return { content, result: validate(parsed.value) };
  };

  const first = await attempt(messages);
  if (first.result.ok) return first.result;

  const repair: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: first.content },
    {
      role: "user",
      content:
        `Your previous response was invalid: ${first.result.error}. ` +
        "Respond again with ONLY valid JSON matching the required schema. " +
        "No prose, no code fences.",
    },
  ];
  return (await attempt(repair)).result;
}

const validateCallSummary = (raw: unknown): ValidationResult<CallSummary> => {
  const r = parseCallSummary(raw);
  return r.ok
    ? { ok: true, value: r.summary }
    : { ok: false, error: zodErrorToString(r.error) };
};

const validateFullCall = (raw: unknown): ValidationResult<FullCallSummary> => {
  const r = FullCallSummarySchema.safeParse(raw);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: zodErrorToString(r.error) };
};

const validateSpeaker = (raw: unknown): ValidationResult<SpeakerSummary> => {
  const r = SpeakerSummarySchema.safeParse(raw);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: zodErrorToString(r.error) };
};

export interface SummarizeOptions {
  /** Override the single-pass vs map-reduce token threshold (for tests). */
  thresholdTokens?: number;
  /** Override the map-reduce chunk token budget (for tests). */
  chunkTokens?: number;
  /**
   * Override the per-speaker chunk token budget: above it a single speaker's
   * lines are chunked-then-reduced rather than sent in one call (for tests).
   */
  speakerChunkTokens?: number;
  /**
   * Override the whole-call reduce context budget. When the joined partial notes
   * exceed it, they are folded hierarchically (batched intermediate reduces)
   * until they fit, so the final reduce prompt is always bounded. Defaults to
   * {@link CHUNK_TOKEN_BUDGET}.
   */
  reduceTokens?: number;
}

/**
 * Produce the dual {@link CallSummary} for a merged transcript, choosing the
 * strategy adaptively. Returns the validated summary or an error string.
 */
export async function summarizeCall(
  chat: ChatClient,
  model: string,
  transcript: MergedTranscript,
  options: SummarizeOptions = {},
): Promise<ValidationResult<CallSummary>> {
  const text = renderTranscriptText(transcript);
  const strategy = chooseSummaryStrategy(text, options.thresholdTokens);

  if (strategy === "single") {
    return requestValidatedJson(
      chat,
      model,
      singlePassMessages(text),
      validateCallSummary,
    );
  }

  return mapReduceSummarize(chat, model, transcript, options);
}

async function mapReduceSummarize(
  chat: ChatClient,
  model: string,
  transcript: MergedTranscript,
  options: SummarizeOptions,
): Promise<ValidationResult<CallSummary>> {
  const chunks = chunkSegments(transcript.segments, options.chunkTokens);

  const partials: string[] = [];
  for (const chunk of chunks) {
    const chunkText = chunk.map(segmentLine).join("\n");
    const notes = await chat.chat({
      model,
      messages: partialNotesMessages(chunkText),
      temperature: SUMMARY_TEMPERATURE,
    });
    // Cap each partial (FIX 4a) so the reduce input can never balloon past the
    // ~200-token/chunk contract even if the model ignores the prompt cap.
    partials.push(truncateToTokens(notes, PARTIAL_NOTE_TOKEN_CAP));
  }

  // FIX 4b: fold partials hierarchically so the final reduce prompt is always
  // within the reduce budget, however many chunks a very long call produced.
  const folded = await foldPartialsToBudget(
    chat,
    model,
    partials,
    options.reduceTokens ?? CHUNK_TOKEN_BUDGET,
  );

  const fullCall = await requestValidatedJson(
    chat,
    model,
    reduceFullCallMessages(folded),
    validateFullCall,
  );
  if (!fullCall.ok) return fullCall;

  const perSpeaker = await summarizePerSpeaker(
    chat,
    model,
    transcript,
    options.speakerChunkTokens,
  );
  if (!perSpeaker.ok) return perSpeaker;

  // Re-validate the assembled object against the full contract before returning.
  return validateCallSummary({
    fullCall: fullCall.value,
    perSpeaker: perSpeaker.value,
  });
}

/**
 * Reduce a list of partial notes to a set whose joined text fits `budget`,
 * folding hierarchically: batch the partials into budget-sized groups, condense
 * each group into one intermediate note, and recurse until they fit (or a single
 * note already fills the budget). Every intermediate is truncated to the note
 * cap, so each iteration strictly shrinks the count and the fold terminates.
 */
async function foldPartialsToBudget(
  chat: ChatClient,
  model: string,
  partials: string[],
  budget: number,
): Promise<string[]> {
  let current = partials;
  while (
    current.length > 1 &&
    estimateTokens(joinPartialNotes(current)) > budget
  ) {
    const batches = batchPartials(current, budget);
    // A single note wider than the budget can't be batched down further; stop
    // rather than loop forever (the note cap keeps this from happening in practice).
    if (batches.length >= current.length) break;
    const next: string[] = [];
    for (const batch of batches) {
      const note = await chat.chat({
        model,
        messages: intermediateReduceMessages(batch),
        temperature: SUMMARY_TEMPERATURE,
      });
      next.push(truncateToTokens(note, PARTIAL_NOTE_TOKEN_CAP));
    }
    current = next;
  }
  return current;
}

/**
 * Greedily group partials so each group's joined text stays within `budget`.
 * A single oversized partial becomes its own group (its content is capped
 * upstream, so this only bounds the join overhead).
 */
function batchPartials(partials: readonly string[], budget: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const p of partials) {
    if (
      current.length > 0 &&
      estimateTokens(joinPartialNotes([...current, p])) > budget
    ) {
      batches.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Summarize each participant independently (LIOTTA-4): one validated JSON call
 * per speaker, and for a speaker whose lines exceed the chunk budget, chunk their
 * segments → partial notes → reduce into one speaker summary. This bounds every
 * call's context — the very case (long calls) that triggers map-reduce is also
 * where a single dominant speaker's concatenated lines would otherwise overflow.
 */
async function summarizePerSpeaker(
  chat: ChatClient,
  model: string,
  transcript: MergedTranscript,
  speakerChunkTokens = CHUNK_TOKEN_BUDGET,
): Promise<ValidationResult<SpeakerSummary[]>> {
  const results: SpeakerSummary[] = [];
  for (const { displayName, segments } of groupSegmentsBySpeaker(
    transcript.segments,
  )) {
    const res = await summarizeOneSpeaker(
      chat,
      model,
      displayName,
      segments,
      speakerChunkTokens,
    );
    if (!res.ok) return res;
    results.push(res.value);
  }
  return { ok: true, value: results };
}

async function summarizeOneSpeaker(
  chat: ChatClient,
  model: string,
  displayName: string,
  segments: readonly Segment[],
  speakerChunkTokens: number,
): Promise<ValidationResult<SpeakerSummary>> {
  const chunks = chunkSegments(segments, speakerChunkTokens);
  if (chunks.length <= 1) {
    const text = segments.map((s) => s.text).join("\n");
    return requestValidatedJson(
      chat,
      model,
      singleSpeakerMessages(displayName, text),
      validateSpeaker,
    );
  }

  const partials: string[] = [];
  for (const chunk of chunks) {
    const chunkText = chunk.map((s) => s.text).join("\n");
    const notes = await chat.chat({
      model,
      messages: partialNotesMessages(chunkText),
      temperature: SUMMARY_TEMPERATURE,
    });
    partials.push(notes);
  }
  return requestValidatedJson(
    chat,
    model,
    reduceSpeakerMessages(displayName, partials),
    validateSpeaker,
  );
}
