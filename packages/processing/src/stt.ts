import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RawSegment, SttBackend } from "./ports.js";

/**
 * Speech-to-text against a local faster-whisper HTTP service exposing the
 * OpenAI-compatible `POST {baseUrl}/audio/transcriptions` endpoint (e.g.
 * `faster-whisper-server` / `speaches`). All inference stays on the Spark
 * (NFR-1); the base URL is env/config-driven so nothing is hard-coded.
 *
 * We request `verbose_json` with segment granularity to get per-segment
 * timestamps (FR-14). Whisper timestamps are in seconds; we convert to integer
 * milliseconds to match the shared transcript contract.
 */

const SegmentJson = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

const VerboseJson = z.object({
  text: z.string(),
  duration: z.number().optional(),
  segments: z.array(SegmentJson).optional(),
});

export interface WhisperHttpOptions {
  /** Base URL of the OpenAI-compatible STT service, e.g. `http://127.0.0.1:8000/v1`. */
  baseUrl: string;
  /** Whisper model name the service should load, e.g. `large-v3`. */
  model: string;
  /** Optional bearer token if the endpoint is protected. */
  apiKey?: string;
  /** Optional language hint (ISO-639-1). Omit to auto-detect. */
  language?: string;
  /** Injectable fetch, for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class WhisperHttpBackend implements SttBackend {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WhisperHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async transcribeTrack(audioPath: string): Promise<RawSegment[]> {
    const bytes = await readFile(audioPath);
    const form = new FormData();
    // Copy into a fresh ArrayBuffer so the Blob owns a plain ArrayBuffer view.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    form.append("file", new Blob([buffer]), path.basename(audioPath));
    form.append("model", this.opts.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (this.opts.language) form.append("language", this.opts.language);

    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers["authorization"] = `Bearer ${this.opts.apiKey}`;

    const res = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `STT request failed (${res.status} ${res.statusText}) for ${audioPath}: ${body.slice(0, 500)}`,
      );
    }

    const parsed = VerboseJson.parse(await res.json());
    return toRawSegments(parsed);
  }
}

/**
 * Convert a verbose_json transcription into ms-timestamped {@link RawSegment}s.
 * Falls back to a single whole-file segment when the service returns only top-
 * level `text` (some backends omit `segments` for very short clips).
 */
export function toRawSegments(parsed: z.infer<typeof VerboseJson>): RawSegment[] {
  if (parsed.segments && parsed.segments.length > 0) {
    return parsed.segments.map((s) => ({
      startMs: secondsToMs(s.start),
      endMs: secondsToMs(s.end),
      text: s.text.trim(),
    }));
  }
  if (parsed.text.trim().length === 0) return [];
  return [
    {
      startMs: 0,
      endMs: secondsToMs(parsed.duration ?? 0),
      text: parsed.text.trim(),
    },
  ];
}

function secondsToMs(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}
