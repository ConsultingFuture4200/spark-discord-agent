import { describe, expect, it, vi } from "vitest";
import {
  moveRecorder,
  shouldMoveRecorder,
  type RecorderMember,
} from "../src/recorder/recorderMove.js";

const makeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/** A recorder member connected to `channelId` (or disconnected when null). */
function member(channelId: string | null): RecorderMember & {
  voice: { setChannel: ReturnType<typeof vi.fn> };
} {
  return {
    voice: {
      channelId,
      setChannel: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("shouldMoveRecorder", () => {
  it("moves a configured, already-connected recorder", () => {
    expect(
      shouldMoveRecorder({ recorderUserId: "r1", memberIsConnected: true }),
    ).toBe(true);
  });

  it("skips a recorder that is not connected", () => {
    expect(
      shouldMoveRecorder({ recorderUserId: "r1", memberIsConnected: false }),
    ).toBe(false);
  });

  it("skips when no recorder id is configured", () => {
    expect(
      shouldMoveRecorder({ recorderUserId: undefined, memberIsConnected: true }),
    ).toBe(false);
  });
});

describe("moveRecorder", () => {
  it("moves an already-connected member into the target channel", async () => {
    const log = makeLogger();
    const m = member("lobby-1");
    await moveRecorder({
      recorderUserId: "r1",
      member: m,
      targetChannelId: "call-1",
      logger: log,
      context: "into call",
    });
    expect(m.voice.setChannel).toHaveBeenCalledWith("call-1");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("skips and logs when the member is not connected", async () => {
    const log = makeLogger();
    const m = member(null);
    await moveRecorder({
      recorderUserId: "r1",
      member: m,
      targetChannelId: "call-1",
      logger: log,
      context: "into call",
    });
    expect(m.voice.setChannel).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it("skips when the member cannot be resolved", async () => {
    const log = makeLogger();
    await moveRecorder({
      recorderUserId: "r1",
      member: null,
      targetChannelId: "call-1",
      logger: log,
      context: "into call",
    });
    expect(log.info).toHaveBeenCalled();
  });

  it("logs (never throws) when setChannel rejects", async () => {
    const log = makeLogger();
    const m = member("lobby-1");
    m.voice.setChannel = vi.fn().mockRejectedValue(new Error("no perms"));
    await expect(
      moveRecorder({
        recorderUserId: "r1",
        member: m,
        targetChannelId: "call-1",
        logger: log,
        context: "into call",
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
