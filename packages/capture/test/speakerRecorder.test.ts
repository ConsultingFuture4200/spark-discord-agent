import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PCM_BYTES_PER_MS,
  PCM_CHANNELS,
  PCM_FRAME_BYTES,
  PCM_SAMPLE_RATE,
  SpeakerRecorder,
} from "../src/recorder/speakerRecorder.js";
import { WAV_HEADER_BYTES } from "../src/recorder/wav.js";

/** A sink that just counts the bytes written to it. */
class ByteCounter extends Writable {
  bytes = 0;
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.bytes += chunk.length;
    cb();
  }
}

/** PCM bytes for `ms` of audio (frame-aligned, as the real decoder emits). */
const pcm = (ms: number): Buffer => Buffer.alloc(ms * PCM_BYTES_PER_MS);

interface Harness {
  recorder: SpeakerRecorder;
  sink: ByteCounter;
  setClock: (ms: number) => void;
}

const makeRecorder = (callStartedAtMs: number, startClock: number): Harness => {
  const sink = new ByteCounter();
  let clock = startClock;
  const recorder = new SpeakerRecorder({
    userId: "u1",
    displayName: "Ada",
    filePath: "/dev/null",
    manifestPath: "audio/u1.pcm",
    callStartedAtMs,
    now: () => clock,
    sink,
  });
  return { recorder, sink, setClock: (ms) => (clock = ms) };
};

describe("SpeakerRecorder offset bookkeeping", () => {
  it("has no audio and a zero offset before the speaker talks", async () => {
    const { recorder } = makeRecorder(1_000, 1_000);
    expect(recorder.hasAudio).toBe(false);
    expect(recorder.startOffsetMs).toBe(0);
    const track = await recorder.finalize();
    expect(track).toEqual({
      userId: "u1",
      displayName: "Ada",
      path: "audio/u1.pcm",
      startOffsetMs: 0,
    });
  });

  it("sets startOffsetMs from the first utterance relative to call start", () => {
    const { recorder } = makeRecorder(1_000, 1_500);
    recorder.beginUtterance();
    expect(recorder.hasAudio).toBe(true);
    expect(recorder.startOffsetMs).toBe(500);
  });

  it("does not pad before the first utterance", () => {
    const { recorder, sink } = makeRecorder(1_000, 1_500);
    recorder.beginUtterance();
    recorder.writePcm(pcm(20));
    expect(sink.bytes).toBe(20 * PCM_BYTES_PER_MS);
    expect(recorder.durationMs).toBe(20);
  });

  it("pads the inter-utterance gap with silence to stay wall-clock aligned", () => {
    const h = makeRecorder(1_000, 1_500);
    // First utterance: 20 ms of speech at t=1500.
    h.recorder.beginUtterance();
    h.recorder.writePcm(pcm(20));
    // Second utterance starts 1000 ms after the first (t=2500): 980 ms silence.
    h.setClock(2_500);
    h.recorder.beginUtterance();
    h.recorder.writePcm(pcm(20));

    // 20 ms speech + 980 ms silence + 20 ms speech = 1020 ms on the timeline.
    expect(h.recorder.durationMs).toBe(1_020);
    expect(h.sink.bytes).toBe(1_020 * PCM_BYTES_PER_MS);
    // startOffsetMs stays anchored to the first utterance.
    expect(h.recorder.startOffsetMs).toBe(500);
  });

  it("keeps silence padding frame-aligned", () => {
    const h = makeRecorder(0, 0);
    h.recorder.beginUtterance();
    h.recorder.writePcm(pcm(10));
    // Gap of 7 ms -> 7 * 192 = 1344 bytes, already a multiple of the frame.
    h.setClock(17);
    h.recorder.beginUtterance();
    expect(h.sink.bytes % PCM_FRAME_BYTES).toBe(0);
  });

  it("ignores writes after finalize", async () => {
    const h = makeRecorder(0, 0);
    h.recorder.beginUtterance();
    h.recorder.writePcm(pcm(20));
    const track = await h.recorder.finalize();
    const bytesAtFinalize = h.sink.bytes;
    h.recorder.writePcm(pcm(20));
    expect(h.sink.bytes).toBe(bytesAtFinalize);
    expect(track.startOffsetMs).toBe(0);
    expect(track.displayName).toBe("Ada");
  });

  it("adopts an updated display name in the finalized track", async () => {
    const h = makeRecorder(0, 0);
    h.recorder.beginUtterance();
    h.recorder.writePcm(pcm(5));
    h.recorder.updateDisplayName("Ada Lovelace");
    const track = await h.recorder.finalize();
    expect(track.displayName).toBe("Ada Lovelace");
  });
});

describe("SpeakerRecorder sink error resilience", () => {
  it("does not throw on a mid-recording sink error; marks failed and stops writing", () => {
    const sink = new ByteCounter();
    const onError = vi.fn();
    const recorder = new SpeakerRecorder({
      userId: "u1",
      displayName: "Ada",
      filePath: "/dev/null",
      manifestPath: "audio/u1.wav",
      callStartedAtMs: 0,
      now: () => 0,
      sink,
      onError,
    });

    recorder.beginUtterance();
    recorder.writePcm(pcm(20));
    const bytesBefore = sink.bytes;

    // The underlying fd errors (full disk, EBADF, ...). With a listener attached
    // at construction this must be handled, not thrown as an uncaught exception.
    expect(() => sink.emit("error", new Error("ENOSPC"))).not.toThrow();

    expect(recorder.failed).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    // Further writes are suppressed once failed.
    recorder.writePcm(pcm(20));
    expect(sink.bytes).toBe(bytesBefore);
  });
});

describe("SpeakerRecorder WAV output", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wav-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a real 48kHz/stereo/16-bit WAV with a patched data length", async () => {
    const filePath = path.join(dir, "u1.wav");
    const recorder = new SpeakerRecorder({
      userId: "u1",
      displayName: "Ada",
      filePath,
      manifestPath: "audio/u1.wav",
      callStartedAtMs: 0,
      now: () => 0,
    });
    recorder.beginUtterance();
    recorder.writePcm(pcm(20));
    await recorder.finalize();

    const buf = await readFile(filePath);
    const dataBytes = 20 * PCM_BYTES_PER_MS;
    expect(buf.length).toBe(WAV_HEADER_BYTES + dataBytes);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.toString("ascii", 36, 40)).toBe("data");
    expect(buf.readUInt32LE(4)).toBe(36 + dataBytes); // RIFF chunk size
    expect(buf.readUInt16LE(22)).toBe(PCM_CHANNELS);
    expect(buf.readUInt32LE(24)).toBe(PCM_SAMPLE_RATE);
    expect(buf.readUInt16LE(34)).toBe(16); // bits per sample
    expect(buf.readUInt32LE(40)).toBe(dataBytes); // data chunk size
  });
});
