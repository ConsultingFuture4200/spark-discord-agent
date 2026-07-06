import type { SpeakerSummary } from "@discord-agent/shared";
import type { ChatMessage } from "./ports.js";

/**
 * Prompt builders for the four summarization stages. The system prompts embed
 * the exact JSON shape the shared zod schemas validate, so the model's output
 * maps 1:1 onto {@link CallSummary} / {@link FullCallSummary} / {@link SpeakerSummary}.
 */

const CALL_SUMMARY_SHAPE = `{
  "fullCall": {
    "overview": string,
    "keyTopics": string[],
    "decisions": string[],
    "openQuestions": string[],
    "actionItems": [{ "owner": string, "item": string }]
  },
  "perSpeaker": [
    {
      "displayName": string,
      "contributions": string[],
      "positionsConcerns": string[],
      "actionItems": [{ "owner": string, "item": string }]
    }
  ]
}`;

const FULL_CALL_SHAPE = `{
  "overview": string,
  "keyTopics": string[],
  "decisions": string[],
  "openQuestions": string[],
  "actionItems": [{ "owner": string, "item": string }]
}`;

const SPEAKER_SHAPE = `{
  "displayName": string,
  "contributions": string[],
  "positionsConcerns": string[],
  "actionItems": [{ "owner": string, "item": string }]
}`;

const JSON_RULES =
  "Return ONLY a single JSON object. No prose, no markdown, no code fences. " +
  'For action items, set "owner" to the speaker\'s display name, or "unassigned" ' +
  "if no owner is stated. Use the participants' real display names exactly as they " +
  "appear in the transcript.";

/** Single-pass (short transcript): produce the whole dual summary in one call. */
export function singlePassMessages(transcriptText: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a meeting summarizer. Read a speaker-labeled call transcript and " +
        "produce a structured dual summary: a whole-call section and a per-speaker " +
        `section. ${JSON_RULES}\n\nSchema:\n${CALL_SUMMARY_SHAPE}`,
    },
    {
      role: "user",
      content: `Transcript:\n\n${transcriptText}`,
    },
  ];
}

/** Join ordered partial notes into one prompt body, numbered for the model. */
export function joinPartialNotes(partials: readonly string[]): string {
  return partials.map((p, i) => `--- Notes ${i + 1} ---\n${p}`).join("\n\n");
}

/** Map stage: summarize one chunk of a long transcript to concise plain-text notes. */
export function partialNotesMessages(chunkText: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are summarizing one portion of a longer call transcript. Produce " +
        "concise plain-text notes (no more than ~200 tokens) capturing topics " +
        "discussed, decisions made, open questions raised, and any action items " +
        "with their owners. Do not invent content beyond this portion.",
    },
    { role: "user", content: `Transcript portion:\n\n${chunkText}` },
  ];
}

/**
 * Intermediate reduce stage: fold a batch of ordered partial notes into ONE
 * shorter combined note (plain text, still ~200 tokens). Used to make the
 * whole-call reduce hierarchical so its final prompt is always context-bounded,
 * however many chunks a very long call produced.
 */
export function intermediateReduceMessages(
  partials: readonly string[],
): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are condensing several ordered partial notes from a single call " +
        "into one shorter combined note of no more than ~200 tokens. Preserve " +
        "topics discussed, decisions made, open questions, and action items with " +
        "their owners. Plain text only; do not invent content.",
    },
    { role: "user", content: `Partial notes in order:\n\n${joinPartialNotes(partials)}` },
  ];
}

/** Reduce stage: combine partial notes into the whole-call section (JSON). */
export function reduceFullCallMessages(partials: readonly string[]): ChatMessage[] {
  const joined = joinPartialNotes(partials);
  return [
    {
      role: "system",
      content:
        "You are combining ordered partial notes from a single call into one " +
        `whole-call summary. ${JSON_RULES}\n\nSchema:\n${FULL_CALL_SHAPE}`,
    },
    { role: "user", content: `Partial notes in order:\n\n${joined}` },
  ];
}

/**
 * Per-speaker stage: summarize ONE participant into a single object. Each speaker
 * is summarized independently so a dominant speaker's lines can never overflow
 * the context (LIOTTA-4) and so the model only sees the speaker it must describe.
 */
export function singleSpeakerMessages(
  displayName: string,
  speakerText: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `You are summarizing a single participant, "${displayName}", from a call. ` +
        "Capture their contributions, their positions/concerns, and their own action " +
        `items. Set "displayName" to exactly "${displayName}". ${JSON_RULES}\n\n` +
        `Schema:\n${SPEAKER_SHAPE}`,
    },
    { role: "user", content: `${displayName}'s lines:\n\n${speakerText}` },
  ];
}

/**
 * Per-speaker reduce stage: fold ordered partial notes for one long-winded
 * participant (whose lines were chunked) into a single speaker summary object.
 */
export function reduceSpeakerMessages(
  displayName: string,
  partials: readonly string[],
): ChatMessage[] {
  const joined = joinPartialNotes(partials);
  return [
    {
      role: "system",
      content:
        `You are combining ordered partial notes about a single participant, ` +
        `"${displayName}", into one summary. Set "displayName" to exactly ` +
        `"${displayName}". ${JSON_RULES}\n\nSchema:\n${SPEAKER_SHAPE}`,
    },
    { role: "user", content: `Partial notes in order:\n\n${joined}` },
  ];
}

/** Type re-export convenience for callers assembling the array result. */
export type { SpeakerSummary };
