import { describe, expect, it, vi } from "vitest";
import { ObsVideoRecorder, type ObsWsClient } from "../src/obs.js";

const makeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const makeClient = (): ObsWsClient => ({
  connect: vi.fn().mockResolvedValue(undefined),
  startRecord: vi.fn().mockResolvedValue(undefined),
  stopRecord: vi.fn().mockResolvedValue({ outputPath: "/rec/out.mp4" }),
  disconnect: vi.fn().mockResolvedValue(undefined),
});

describe("ObsVideoRecorder", () => {
  it("connects lazily, records, and reports the output path", async () => {
    const client = makeClient();
    const rec = new ObsVideoRecorder({
      websocketUrl: "ws://obs:4455",
      websocketPassword: "secret",
      logger: makeLogger(),
      now: () => 5_000,
      client,
    });

    const started = await rec.startRecording();
    expect(started.startedAtMs).toBe(5_000);
    expect(client.connect).toHaveBeenCalledWith("ws://obs:4455", "secret");
    expect(client.startRecord).toHaveBeenCalledTimes(1);

    const stopped = await rec.stopRecording();
    expect(stopped.outputPath).toBe("/rec/out.mp4");

    await rec.dispose();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("connects only once across start/stop", async () => {
    const client = makeClient();
    const rec = new ObsVideoRecorder({
      websocketUrl: "ws://obs:4455",
      websocketPassword: undefined,
      logger: makeLogger(),
      client,
    });
    await rec.startRecording();
    await rec.startRecording();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith("ws://obs:4455", undefined);
  });

  it("degrades to audio-only when OBS is unreachable", async () => {
    const client = makeClient();
    client.connect = vi.fn().mockRejectedValue(new Error("no obs"));
    const log = makeLogger();
    const rec = new ObsVideoRecorder({
      websocketUrl: "ws://obs:4455",
      websocketPassword: undefined,
      logger: log,
      client,
    });

    // startRecording must not throw; StartRecord is never issued.
    await expect(rec.startRecording()).resolves.toMatchObject({});
    expect(client.startRecord).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();

    // With no recording in flight, stop reports no path → manifest.video unset.
    const stopped = await rec.stopRecording();
    expect(stopped.outputPath).toBeNull();

    // dispose is safe even though we never connected.
    await expect(rec.dispose()).resolves.toBeUndefined();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("degrades to audio-only when StartRecord fails", async () => {
    const client = makeClient();
    client.startRecord = vi.fn().mockRejectedValue(new Error("record boom"));
    const rec = new ObsVideoRecorder({
      websocketUrl: "ws://obs:4455",
      websocketPassword: undefined,
      logger: makeLogger(),
      client,
    });
    await rec.startRecording();
    const stopped = await rec.stopRecording();
    // recording never actually started → StopRecord is not issued.
    expect(client.stopRecord).not.toHaveBeenCalled();
    expect(stopped.outputPath).toBeNull();
  });

  it("returns a null path when StopRecord fails", async () => {
    const client = makeClient();
    client.stopRecord = vi.fn().mockRejectedValue(new Error("stop boom"));
    const rec = new ObsVideoRecorder({
      websocketUrl: "ws://obs:4455",
      websocketPassword: undefined,
      logger: makeLogger(),
      client,
    });
    await rec.startRecording();
    const stopped = await rec.stopRecording();
    expect(client.stopRecord).toHaveBeenCalledTimes(1);
    expect(stopped.outputPath).toBeNull();
  });
});
