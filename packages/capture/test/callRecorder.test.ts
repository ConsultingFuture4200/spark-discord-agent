import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// Mock the opus decoder so no native codec is needed; it only needs to be an
// EventEmitter with a destroy() the recorder can call.
vi.mock("prism-media", async () => {
  // Import inside the (hoisted) factory so it doesn't touch the top-level import.
  const { EventEmitter: EE } = await import("node:events");
  class Decoder extends EE {
    destroy = vi.fn();
  }
  return { default: { opus: { Decoder } } };
});

// Stub the SpeakerRecorder so onSpeakingStart does no filesystem/stream work —
// the test is purely about activeUsers bookkeeping around the opus stream.
vi.mock("../src/recorder/speakerRecorder.js", () => ({
  PCM_SAMPLE_RATE: 48_000,
  PCM_CHANNELS: 2,
  SpeakerRecorder: class {
    beginUtterance = vi.fn();
    writePcm = vi.fn();
    updateDisplayName = vi.fn();
  },
}));

import { CallRecorder } from "../src/recorder/callRecorder.js";

/** Fake per-user receive stream: an EventEmitter with pipe()/destroy(). */
class FakeOpusStream extends EventEmitter {
  destroy = vi.fn();
  pipe = vi.fn().mockReturnThis();
}

const makeChannel = () =>
  ({
    id: "chan-1",
    guild: { id: "g1", members: { cache: new Map() } },
    members: new Map(),
  }) as never;

const makeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

interface RecorderInternals {
  onSpeakingStart(receiver: unknown, userId: string): void;
  activeUsers: Set<string>;
}

describe("CallRecorder onSpeakingStart — stream error cleanup", () => {
  it("removes the user on an opus-stream error so a later speaking-start re-subscribes", () => {
    const opusStream = new FakeOpusStream();
    const receiver = { subscribe: vi.fn(() => opusStream) };
    const recorder = new CallRecorder({
      channel: makeChannel(),
      storageDir: "/tmp/does-not-matter",
      logger: makeLogger(),
    });
    const rec = recorder as unknown as RecorderInternals;

    rec.onSpeakingStart(receiver, "u1");
    expect(rec.activeUsers.has("u1")).toBe(true);
    expect(receiver.subscribe).toHaveBeenCalledTimes(1);

    // The stream errors WITHOUT a following "close"/"end" — the error handler
    // must be the terminal cleanup trigger.
    opusStream.emit("error", new Error("stream boom"));

    expect(rec.activeUsers.has("u1")).toBe(false);
    expect(opusStream.destroy).toHaveBeenCalled();

    // The dedupe guard no longer blocks the user: a new burst re-subscribes.
    const opusStream2 = new FakeOpusStream();
    receiver.subscribe.mockReturnValue(opusStream2);
    rec.onSpeakingStart(receiver, "u1");
    expect(rec.activeUsers.has("u1")).toBe(true);
    expect(receiver.subscribe).toHaveBeenCalledTimes(2);
  });
});
