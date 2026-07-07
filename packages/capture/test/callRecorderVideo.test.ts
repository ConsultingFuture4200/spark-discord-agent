import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCallDir, readStatus, videoPath } from "@discord-agent/shared";
import type { VideoRecorder } from "../src/obs.js";

// Same native-free stubs as callRecorder.test.ts: the video tests exercise
// stop()'s manifest path, not audio capture.
vi.mock("prism-media", async () => {
  const { EventEmitter: EE } = await import("node:events");
  class Decoder extends EE {
    destroy = vi.fn();
  }
  return { default: { opus: { Decoder } } };
});
vi.mock("../src/recorder/speakerRecorder.js", () => ({
  PCM_SAMPLE_RATE: 48_000,
  PCM_CHANNELS: 2,
  SpeakerRecorder: class {},
}));

const { CallRecorder } = await import("../src/recorder/callRecorder.js");

const makeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const makeChannel = () =>
  ({
    id: "chan-1",
    guild: { id: "g1", members: { cache: new Map() } },
    members: new Map(),
    isTextBased: () => false,
  }) as never;

interface RecorderInternals {
  callId: string;
  videoStartedAtMs: number | null;
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "callrec-video-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("CallRecorder video finalize", () => {
  it("attaches an aligned video descriptor and copies the file on success", async () => {
    const src = path.join(dir, "obs-out.mp4");
    await fs.writeFile(src, "fake-mp4-bytes");

    const videoRecorder: VideoRecorder = {
      startRecording: vi.fn().mockResolvedValue({ startedAtMs: 4_000 }),
      stopRecording: vi.fn().mockResolvedValue({ outputPath: src }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const recorder = new CallRecorder({
      channel: makeChannel(),
      storageDir: dir,
      logger: makeLogger(),
      now: () => 1_000,
      videoRecorder,
    });
    const internals = recorder as unknown as RecorderInternals;
    // start() would join a real VC; simulate the StartRecord ack directly.
    internals.videoStartedAtMs = 4_000;
    await ensureCallDir(dir, internals.callId);

    const manifest = await recorder.stop();

    expect(videoRecorder.stopRecording).toHaveBeenCalledTimes(1);
    expect(videoRecorder.dispose).toHaveBeenCalledTimes(1);
    expect(manifest?.video).toEqual({
      path: "video.mp4",
      startedAt: new Date(4_000).toISOString(),
      startOffsetMs: 3_000, // 4000 (video start) − 1000 (call start)
    });
    // The recording was copied into the call dir.
    await expect(
      fs.readFile(videoPath(dir, internals.callId), "utf8"),
    ).resolves.toBe("fake-mp4-bytes");
  });

  it("stays audio-only when the video recorder throws on stop", async () => {
    const videoRecorder: VideoRecorder = {
      startRecording: vi.fn().mockResolvedValue({ startedAtMs: 4_000 }),
      stopRecording: vi.fn().mockRejectedValue(new Error("obs boom")),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const recorder = new CallRecorder({
      channel: makeChannel(),
      storageDir: dir,
      logger: makeLogger(),
      now: () => 1_000,
      videoRecorder,
    });
    const internals = recorder as unknown as RecorderInternals;
    internals.videoStartedAtMs = 4_000;
    await ensureCallDir(dir, internals.callId);

    const manifest = await recorder.stop();

    // Best-effort: a failed video finalize never blocks the manifest/enqueue.
    expect(manifest).not.toBeNull();
    expect(manifest?.video).toBeUndefined();
    // dispose still runs so the OBS connection is torn down.
    expect(videoRecorder.dispose).toHaveBeenCalledTimes(1);
  });

  it("enqueues audio-only when the video copy rejects (unreadable mount)", async () => {
    // stopRecording succeeds but the OBS output file does not exist, so the copy
    // into the call dir rejects. FIX 1: audio is already enqueued, so the call is
    // still ready-to-process; FIX 2: the failure degrades to audio-only.
    const videoRecorder: VideoRecorder = {
      startRecording: vi.fn().mockResolvedValue({ startedAtMs: 4_000 }),
      stopRecording: vi
        .fn()
        .mockResolvedValue({ outputPath: path.join(dir, "does-not-exist.mp4") }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const recorder = new CallRecorder({
      channel: makeChannel(),
      storageDir: dir,
      logger: makeLogger(),
      now: () => 1_000,
      videoRecorder,
    });
    const internals = recorder as unknown as RecorderInternals;
    internals.videoStartedAtMs = 4_000;
    await ensureCallDir(dir, internals.callId);

    const manifest = await recorder.stop();

    expect(manifest).not.toBeNull();
    expect(manifest?.video).toBeUndefined();
    // The call is durably enqueued despite the video failure.
    const status = await readStatus(dir, internals.callId);
    expect(status.status).toBe("ready-to-process");
    // No stray video file left behind.
    await expect(
      fs.access(videoPath(dir, internals.callId)),
    ).rejects.toThrow();
  });

  it("enqueues audio-only when the video copy hangs past the timeout", async () => {
    // A hung mount: copyFile never resolves. FIX 1 bounds it with a timeout so
    // enqueue is never blocked and the call still reaches ready-to-process.
    const copySpy = vi
      .spyOn(fs, "copyFile")
      .mockReturnValue(new Promise<void>(() => {}));
    try {
      const videoRecorder: VideoRecorder = {
        startRecording: vi.fn().mockResolvedValue({ startedAtMs: 4_000 }),
        stopRecording: vi
          .fn()
          .mockResolvedValue({ outputPath: path.join(dir, "obs-out.mp4") }),
        dispose: vi.fn().mockResolvedValue(undefined),
      };

      const recorder = new CallRecorder({
        channel: makeChannel(),
        storageDir: dir,
        logger: makeLogger(),
        now: () => 1_000,
        videoRecorder,
        videoCopyTimeoutMs: 10,
      });
      const internals = recorder as unknown as RecorderInternals;
      internals.videoStartedAtMs = 4_000;
      await ensureCallDir(dir, internals.callId);

      const manifest = await recorder.stop();

      expect(manifest).not.toBeNull();
      expect(manifest?.video).toBeUndefined();
      expect(copySpy).toHaveBeenCalledTimes(1);
      const status = await readStatus(dir, internals.callId);
      expect(status.status).toBe("ready-to-process");
    } finally {
      copySpy.mockRestore();
    }
  });

  it("degrades to audio-only (no throw) when the video descriptor is malformed", async () => {
    // FIX 2: force a bad value into descriptor construction — a NaN video start
    // makes `new Date(NaN).toISOString()` throw / the schema reject. The failure
    // must be swallowed inside buildVideoDescriptor, not thrown out of stop().
    const src = path.join(dir, "obs-out.mp4");
    await fs.writeFile(src, "fake-mp4-bytes");
    const videoRecorder: VideoRecorder = {
      startRecording: vi.fn().mockResolvedValue({ startedAtMs: Number.NaN }),
      stopRecording: vi.fn().mockResolvedValue({ outputPath: src }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const recorder = new CallRecorder({
      channel: makeChannel(),
      storageDir: dir,
      logger: makeLogger(),
      now: () => 1_000,
      videoRecorder,
    });
    const internals = recorder as unknown as RecorderInternals;
    internals.videoStartedAtMs = Number.NaN;
    await ensureCallDir(dir, internals.callId);

    const manifest = await recorder.stop();

    expect(manifest).not.toBeNull();
    expect(manifest?.video).toBeUndefined();
    const status = await readStatus(dir, internals.callId);
    expect(status.status).toBe("ready-to-process");
  });

  it("has no video when using the default (no-op) recorder", async () => {
    const recorder = new CallRecorder({
      channel: makeChannel(),
      storageDir: dir,
      logger: makeLogger(),
      now: () => 1_000,
    });
    const internals = recorder as unknown as RecorderInternals;
    await ensureCallDir(dir, internals.callId);

    const manifest = await recorder.stop();
    expect(manifest?.video).toBeUndefined();
  });
});
