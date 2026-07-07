import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoRecorder } from "../src/obs.js";

/**
 * FIX 3 regression: the recorder account must be moved INTO the call channel
 * BEFORE OBS StartRecord, otherwise OBS captures the lobby for the first frames.
 * We stub @discordjs/voice so start() resolves without a real gateway and assert
 * the ordering of member.voice.setChannel vs videoRecorder.startRecording.
 */

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

vi.mock("@discordjs/voice", () => ({
  EndBehaviorType: { AfterSilence: 1 },
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Signalling: "signalling",
    Connecting: "connecting",
  },
  entersState: vi.fn().mockResolvedValue(undefined),
  joinVoiceChannel: vi.fn(() => ({
    on: vi.fn(),
    receiver: { speaking: { removeAllListeners: vi.fn(), on: vi.fn() } },
    destroy: vi.fn(),
  })),
}));

const { CallRecorder } = await import("../src/recorder/callRecorder.js");

const makeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "callrec-start-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("CallRecorder.start recorder-move ordering", () => {
  it("moves the recorder into the call BEFORE OBS StartRecord", async () => {
    const order: string[] = [];
    const setChannel = vi.fn(async () => {
      order.push("move");
    });
    // Recorder account, already connected to the lobby (movable).
    const recorderMember = { voice: { channelId: "lobby-1", setChannel } };

    const videoRecorder: VideoRecorder = {
      startRecording: vi.fn(async () => {
        order.push("startRecording");
        return { startedAtMs: 4_000 };
      }),
      stopRecording: vi.fn().mockResolvedValue({ outputPath: null }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const channel = {
      id: "chan-1",
      guild: {
        id: "g1",
        voiceAdapterCreator: {},
        members: { cache: new Map([["rec-user", recorderMember]]) },
      },
      members: new Map(),
      isTextBased: () => false,
    } as never;

    const recorder = new CallRecorder({
      channel,
      storageDir: dir,
      logger: makeLogger(),
      now: () => 1_000,
      videoRecorder,
      recorderUserId: "rec-user",
    });

    await recorder.start();

    expect(setChannel).toHaveBeenCalledWith("chan-1");
    expect(videoRecorder.startRecording).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["move", "startRecording"]);
  });

  it("skips the move when no recorder account is configured", async () => {
    const videoRecorder: VideoRecorder = {
      startRecording: vi.fn().mockResolvedValue({ startedAtMs: 4_000 }),
      stopRecording: vi.fn().mockResolvedValue({ outputPath: null }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: "chan-1",
      guild: {
        id: "g1",
        voiceAdapterCreator: {},
        members: { cache: new Map() },
      },
      members: new Map(),
      isTextBased: () => false,
    } as never;

    const recorder = new CallRecorder({
      channel,
      storageDir: dir,
      logger: makeLogger(),
      now: () => 1_000,
      videoRecorder,
    });

    await expect(recorder.start()).resolves.toBeUndefined();
    expect(videoRecorder.startRecording).toHaveBeenCalledTimes(1);
  });
});
