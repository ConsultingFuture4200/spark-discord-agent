import { describe, expect, it } from "vitest";
import {
  humanMembers,
  shouldAutoJoin,
  shouldLeave,
  type VoiceMember,
} from "../src/autojoin.js";

const human = (userId: string, roleIds: string[] = []): VoiceMember => ({
  userId,
  bot: false,
  roleIds,
});
const bot = (userId: string): VoiceMember => ({ userId, bot: true, roleIds: [] });

const armed = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe("humanMembers", () => {
  it("filters out bots", () => {
    expect(humanMembers([human("a"), bot("agent"), human("b")])).toEqual([
      human("a"),
      human("b"),
    ]);
  });
});

describe("shouldAutoJoin", () => {
  const base = {
    channelId: "vc1",
    armedChannelIds: armed("vc1"),
    triggerUserIds: [] as string[],
    triggerRoleIds: [] as string[],
    alreadyRecording: false,
  };

  it("does not join an un-armed channel", () => {
    expect(
      shouldAutoJoin({ ...base, armedChannelIds: armed("other"), members: [human("a")] }),
    ).toBe(false);
  });

  it("does not join when no non-bot humans are present", () => {
    expect(shouldAutoJoin({ ...base, members: [bot("agent")] })).toBe(false);
    expect(shouldAutoJoin({ ...base, members: [] })).toBe(false);
  });

  it("joins an armed channel with any human when no triggers are configured", () => {
    expect(shouldAutoJoin({ ...base, members: [human("a")] })).toBe(true);
  });

  it("does not join if it is already recording the channel", () => {
    expect(
      shouldAutoJoin({ ...base, members: [human("a")], alreadyRecording: true }),
    ).toBe(false);
  });

  it("requires a configured trigger user to be present when triggers are set", () => {
    const withUserTrigger = { ...base, triggerUserIds: ["boss"] };
    expect(shouldAutoJoin({ ...withUserTrigger, members: [human("a")] })).toBe(false);
    expect(
      shouldAutoJoin({ ...withUserTrigger, members: [human("a"), human("boss")] }),
    ).toBe(true);
  });

  it("requires a configured trigger role to be present when triggers are set", () => {
    const withRoleTrigger = { ...base, triggerRoleIds: ["vip"] };
    expect(
      shouldAutoJoin({ ...withRoleTrigger, members: [human("a", ["member"])] }),
    ).toBe(false);
    expect(
      shouldAutoJoin({ ...withRoleTrigger, members: [human("a", ["vip"])] }),
    ).toBe(true);
  });

  it("a bot carrying a trigger role does not itself qualify", () => {
    expect(
      shouldAutoJoin({
        ...base,
        triggerRoleIds: ["vip"],
        members: [{ userId: "agent", bot: true, roleIds: ["vip"] }],
      }),
    ).toBe(false);
  });
});

describe("shouldLeave", () => {
  it("leaves a recorded channel once no humans remain", () => {
    expect(shouldLeave({ members: [bot("agent")], isRecording: true })).toBe(true);
    expect(shouldLeave({ members: [], isRecording: true })).toBe(true);
  });

  it("stays while a human is still present", () => {
    expect(
      shouldLeave({ members: [human("a"), bot("agent")], isRecording: true }),
    ).toBe(false);
  });

  it("never leaves a channel it is not recording", () => {
    expect(shouldLeave({ members: [], isRecording: false })).toBe(false);
  });
});
