/**
 * Ports (interfaces) the processing pipeline depends on.
 *
 * Everything the pipeline needs from the outside world — speech-to-text, the
 * LLM, Discord, email — is expressed here as a narrow interface so the pipeline
 * is pure orchestration and every side effect is injectable (and mockable in
 * tests). Concrete adapters live in `stt.ts`, `chat.ts`, `poster.ts`; the email
 * adapter is provided by `@discord-agent/agent-tools` and injected as `Emailer`.
 */

/** One transcribed utterance from a single track, before speaker/offset labeling. */
export interface RawSegment {
  /** Start in ms from the start of *this track's* audio (not the call). */
  startMs: number;
  /** End in ms from the start of this track's audio; must be >= startMs. */
  endMs: number;
  text: string;
}

/** Speech-to-text over one per-speaker audio track. */
export interface SttBackend {
  /**
   * Transcribe a single audio file into timestamped segments. Timestamps are
   * relative to the start of the file; the pipeline shifts them onto the call
   * timeline using the track's `startOffsetMs`.
   */
  transcribeTrack(audioPath: string): Promise<RawSegment[]>;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Sampling temperature; omitted → provider default. */
  temperature?: number;
  /** Ask the endpoint to constrain output to a JSON object (`response_format`). */
  jsonMode?: boolean;
}

/** OpenAI-compatible chat client. Returns the assistant message content. */
export interface ChatClient {
  chat(request: ChatRequest): Promise<string>;
}

/** Posts a rendered summary to Discord and returns the thread it created. */
export interface SummaryPoster {
  postSummary(
    channelId: string,
    callId: string,
    markdown: string,
  ): Promise<{ threadId: string }>;
}

/** Optional email delivery. Concrete impl lives in `@discord-agent/agent-tools`. */
export interface Emailer {
  sendSummary(input: { subject: string; markdown: string }): Promise<void>;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Result of a validated LLM call: parsed value or a human-readable error. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
