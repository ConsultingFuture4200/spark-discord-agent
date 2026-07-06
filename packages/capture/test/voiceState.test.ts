import { describe, expect, it, vi } from "vitest";
import type { DiscordConfig } from "@discord-agent/shared";

/**
 * Regression for the stop/restart race (LINUS-2): stopChannel must keep the
 * channel marked busy until recorder.stop() fully resolves, so a fast
 * leave-then-rejoin during teardown does not start a second recorder against the
 * old, still-alive voice connection.
 */

const hoisted = vi.hoisted(() => ({
  constructCount: 0,
  stopResolvers: [] as Array<() => void>,
}));

vi.mock("../src/recorder/callRecorder.js", () => ({
  CallRecorder: class {
    readonly callId = "call-1";
    readonly channelId: string;
    constructor(deps: { channel: { id: string } }) {
      this.channelId = deps.channel.id;
      hoisted.constructCount++;
    }
    async start(): Promise<void> {}
    stop(): Promise<void> {
      return new Promise<void>((resolve) => hoisted.stopResolvers.push(resolve));
    }
  },
}));

const { VoiceCoordinator } = await import("../src/voiceState.js");
const { ArmState } = await import("../src/armState.js");

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function humanChannel(id: string) {
  const member = { id: "human", user: { bot: false }, roles: { cache: new Map() } };
  return {
    id,
    guild: { id: "g1", voiceAdapterCreator: {}, members: { cache: new Map() } },
    members: new Map([["human", member]]),
    isTextBased: () => false,
    send: async () => {},
  } as never;
}

const config: DiscordConfig = {
  token: "t",
  appId: "a",
  guildId: "g1",
  autoRecordChannelIds: ["chan-1"],
  triggerRoleIds: [],
  triggerUserIds: [],
};

describe("VoiceCoordinator stop/restart race", () => {
  it("does not start a second recorder while the first is still stopping", async () => {
    hoisted.constructCount = 0;
    hoisted.stopResolvers = [];

    const coord = new VoiceCoordinator({
      config,
      armState: new ArmState(config.autoRecordChannelIds),
      storageDir: "/tmp/does-not-matter",
      logger: noopLogger,
      now: () => 0,
    });
    const channel = humanChannel("chan-1");

    await coord.evaluateChannel(channel);
    expect(hoisted.constructCount).toBe(1);
    expect(coord.isRecording("chan-1")).toBe(true);

    // Begin a stop but do NOT await it; the recorder is mid-teardown.
    const stopping = coord.stopChannel("chan-1");

    // A rapid rejoin fires evaluateChannel again while teardown is in flight.
    await coord.evaluateChannel(channel);
    // The channel is still busy, so no second recorder / joinVoiceChannel.
    expect(hoisted.constructCount).toBe(1);

    // Teardown completes; only now is the channel free again.
    hoisted.stopResolvers.forEach((r) => r());
    await stopping;
    expect(coord.isRecording("chan-1")).toBe(false);
  });
});
