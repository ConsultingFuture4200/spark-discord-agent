import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { SpeakerTrack } from "@discord-agent/shared";
import { WAV_HEADER_BYTES, buildWavHeader, type WavFormat } from "./wav.js";

/**
 * One continuous audio track for a single speaker, written as a 48 kHz stereo,
 * signed-16-bit PCM WAV file at Discord's decoded receive format.
 *
 * Discord delivers speech in bursts: a receive stream ends after a silence gap
 * and a new one starts on the next utterance. If we merely concatenated the
 * bursts, the track would be shorter than wall-clock time and Whisper's segment
 * timestamps would drift out of alignment with the other speakers. To keep the
 * track on the call timeline, each new utterance first pads the inter-utterance
 * gap with silence, so `t` seconds into the file always maps to
 * `startOffsetMs + t` on the call clock.
 *
 * The file is a real WAV, not raw PCM, because the STT service decodes uploads
 * through libav, which cannot autodetect format-less PCM. When this recorder owns
 * its sink it reserves a 44-byte header up front and patches in the true data
 * length at {@link finalize}; when a sink is injected (tests) it writes only the
 * PCM payload so the offset/padding math stays trivially assertable.
 *
 * `startOffsetMs` is the offset of this speaker's *first* audio relative to the
 * call start; the processing service adds it to per-track segment timestamps to
 * merge all speakers onto one timeline.
 *
 * Pure bookkeeping otherwise: the clock and the write sink are injectable so the
 * offset/padding math is testable without Discord or the filesystem.
 */

export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 2;
export const PCM_BYTES_PER_SAMPLE = 2;
/** One full stereo sample frame in bytes (used to keep silence frame-aligned). */
export const PCM_FRAME_BYTES = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
/** Bytes of PCM per millisecond of audio: 48000 * 2ch * 2B / 1000 = 192. */
export const PCM_BYTES_PER_MS =
  (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE) / 1000;

/** WAV format of every speaker track: 48 kHz, stereo, signed 16-bit. */
const TRACK_FORMAT: WavFormat = {
  sampleRate: PCM_SAMPLE_RATE,
  channels: PCM_CHANNELS,
  bytesPerSample: PCM_BYTES_PER_SAMPLE,
};

export interface SpeakerRecorderOptions {
  userId: string;
  displayName: string;
  /** Absolute path the WAV track is written to. */
  filePath: string;
  /** Path stored in the manifest (relative to the call dir). */
  manifestPath: string;
  /** Wall-clock ms at which the call started (manifest `startedAt`). */
  callStartedAtMs: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sink; defaults to a file write stream at `filePath`. */
  sink?: Writable;
  /**
   * Called if the write sink errors mid-recording (full disk, fd exhaustion, a
   * disappearing volume). The recorder marks itself {@link failed} and stops
   * writing; the callback lets the owner log and exclude the track instead of
   * letting an unhandled `'error'` crash the always-on process (NFR-2/NFR-3).
   */
  onError?: (err: Error) => void;
}

export class SpeakerRecorder {
  readonly userId: string;
  private displayName: string;
  private readonly manifestRelPath: string;
  private readonly filePath: string;
  private readonly callStartedAtMs: number;
  private readonly now: () => number;
  private readonly sink: Writable;
  /** True when this recorder created its own file sink (vs. an injected one). */
  private readonly ownsSink: boolean;
  private readonly onError?: (err: Error) => void;

  /** Wall-clock ms of the first byte of audio; null until the speaker talks. */
  private firstAudioAtMs: number | null = null;
  /** Milliseconds of audio (real + silence padding) written so far. */
  private writtenMs = 0;
  /** Bytes of PCM payload written so far (excludes the WAV header). */
  private dataBytes = 0;
  private finalized = false;
  /** Set once the sink errors; further writes are suppressed. */
  private errored = false;

  constructor(opts: SpeakerRecorderOptions) {
    this.userId = opts.userId;
    this.displayName = opts.displayName;
    this.manifestRelPath = opts.manifestPath;
    this.filePath = opts.filePath;
    this.callStartedAtMs = opts.callStartedAtMs;
    this.now = opts.now ?? Date.now;
    this.ownsSink = opts.sink === undefined;
    if (opts.onError) this.onError = opts.onError;
    this.sink = opts.sink ?? createWriteStream(opts.filePath);
    // Attach the error listener at construction, not at finalize: on an always-on
    // service the sink can error at any point during a multi-hour recording, and
    // an unhandled 'error' would crash the whole process (killing every other
    // in-flight track), not just this one.
    this.sink.on("error", (err: Error) => this.handleSinkError(err));
    // Reserve space for the WAV header; patched with real sizes at finalize.
    if (this.ownsSink) this.sink.write(Buffer.alloc(WAV_HEADER_BYTES));
  }

  private handleSinkError(err: Error): void {
    if (this.errored) return;
    this.errored = true;
    this.onError?.(err);
  }

  /** True once the write sink has errored; the track is incomplete. */
  get failed(): boolean {
    return this.errored;
  }

  /** Later utterances may resolve a better display name; keep the latest. */
  updateDisplayName(displayName: string): void {
    if (displayName) this.displayName = displayName;
  }

  /**
   * Mark the start of an utterance. Sets `startOffsetMs` on the first call and,
   * on later calls, pads the silent gap since the previous utterance so the
   * track stays wall-clock aligned. Must be called before the utterance's PCM
   * is written via {@link writePcm}.
   */
  beginUtterance(): void {
    if (this.finalized) return;
    const nowMs = this.now();

    if (this.firstAudioAtMs === null) {
      this.firstAudioAtMs = nowMs;
      return;
    }

    const targetMs = nowMs - this.firstAudioAtMs;
    const gapMs = targetMs - this.writtenMs;
    if (gapMs > 0) this.writeSilence(gapMs);
  }

  /**
   * Append a decoded PCM chunk and advance the written-audio clock.
   *
   * Backpressure note (accepted limitation): the sink's `write()` boolean is not
   * awaited. At Opus frame sizes (~3.8 KB / 20 ms) against local disk throughput
   * the internal buffer never grows unboundedly in practice; if that assumption
   * ever breaks, gate on a `'drain'` event here.
   */
  writePcm(chunk: Buffer): void {
    if (this.finalized || this.errored || chunk.length === 0) return;
    if (this.firstAudioAtMs === null) this.firstAudioAtMs = this.now();
    this.sink.write(chunk);
    this.writtenMs += chunk.length / PCM_BYTES_PER_MS;
    this.dataBytes += chunk.length;
  }

  /** Write `ms` of silence (zeroed PCM), rounded to a whole sample frame. */
  private writeSilence(ms: number): void {
    if (this.finalized || this.errored) return;
    let bytes = Math.round(ms * PCM_BYTES_PER_MS);
    bytes -= bytes % PCM_FRAME_BYTES;
    if (bytes <= 0) return;
    this.sink.write(Buffer.alloc(bytes));
    this.writtenMs += bytes / PCM_BYTES_PER_MS;
    this.dataBytes += bytes;
  }

  /** True once any audio has been recorded for this speaker. */
  get hasAudio(): boolean {
    return this.firstAudioAtMs !== null;
  }

  /** Offset of this speaker's first audio from the call start, in whole ms. */
  get startOffsetMs(): number {
    if (this.firstAudioAtMs === null) return 0;
    return Math.max(0, Math.round(this.firstAudioAtMs - this.callStartedAtMs));
  }

  /** Total audio (real + padding) written so far, in ms. */
  get durationMs(): number {
    return this.writtenMs;
  }

  /**
   * Close the write sink, patch the WAV header with the true data length, and
   * return this speaker's manifest descriptor. Idempotent-safe: further writes
   * are ignored after finalize. If the sink already errored, closing/patching is
   * skipped and the recorder stays {@link failed} so the owner can exclude it.
   */
  async finalize(): Promise<SpeakerTrack> {
    if (!this.finalized) {
      this.finalized = true;
      if (!this.errored) {
        await this.endSink();
        if (this.ownsSink && !this.errored) await this.patchWavHeader();
      }
    }
    return {
      userId: this.userId,
      displayName: this.displayName,
      path: this.manifestRelPath,
      startOffsetMs: this.startOffsetMs,
    };
  }

  /** Flush and close the sink. Resolves even on an end-time error (surfaced
   * separately via the persistent error handler) so finalize never hangs. */
  private endSink(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sink.once("error", () => resolve());
      this.sink.end(() => resolve());
    });
  }

  /** Overwrite the reserved 44-byte placeholder with the real WAV header. */
  private async patchWavHeader(): Promise<void> {
    const header = buildWavHeader(this.dataBytes, TRACK_FORMAT);
    const fh = await open(this.filePath, "r+");
    try {
      await fh.write(header, 0, WAV_HEADER_BYTES, 0);
    } finally {
      await fh.close();
    }
  }
}
