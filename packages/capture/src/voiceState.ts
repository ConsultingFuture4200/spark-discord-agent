import type { VoiceBasedChannel, VoiceState } from "discord.js";
import { writeStatus, type DiscordConfig } from "@discord-agent/shared";
import type { ArmState } from "./armState.js";
import { shouldAutoJoin, shouldLeave, type VoiceMember } from "./autojoin.js";
import type { Logger } from "./logger.js";
import { CallRecorder } from "./recorder/callRecorder.js";

export interface VoiceCoordinatorDeps {
  config: DiscordConfig;
  armState: ArmState;
  storageDir: string;
  logger: Logger;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Bridges Discord `voiceStateUpdate` events to {@link CallRecorder} lifecycle.
 * Keeps at most one recorder per channel and applies the arm/trigger policy
 * from {@link shouldAutoJoin} / {@link shouldLeave}.
 */
export class VoiceCoordinator {
  private readonly config: DiscordConfig;
  private readonly armState: ArmState;
  private readonly storageDir: string;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly active = new Map<string, CallRecorder>();

  constructor(deps: VoiceCoordinatorDeps) {
    this.config = deps.config;
    this.armState = deps.armState;
    this.storageDir = deps.storageDir;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  /** Discord event handler: re-evaluate every channel touched by the change. */
  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const channels = new Map<string, VoiceBasedChannel>();
    if (oldState.channel) channels.set(oldState.channel.id, oldState.channel);
    if (newState.channel) channels.set(newState.channel.id, newState.channel);
    for (const channel of channels.values()) {
      void this.evaluateChannel(channel);
    }
  }

  isRecording(channelId: string): boolean {
    return this.active.has(channelId);
  }

  /** Apply the join/leave policy to a channel's current occupancy. */
  async evaluateChannel(channel: VoiceBasedChannel): Promise<void> {
    const members = toVoiceMembers(channel);
    const recording = this.active.has(channel.id);

    if (recording) {
      if (shouldLeave({ members, isRecording: true })) {
        await this.stopChannel(channel.id);
      }
      return;
    }

    const join = shouldAutoJoin({
      channelId: channel.id,
      armedChannelIds: this.armState.channelIds,
      members,
      triggerUserIds: this.config.triggerUserIds,
      triggerRoleIds: this.config.triggerRoleIds,
      alreadyRecording: false,
    });
    if (join) await this.startChannel(channel);
  }

  private async startChannel(channel: VoiceBasedChannel): Promise<void> {
    if (this.active.has(channel.id)) return;
    const recorder = new CallRecorder({
      channel,
      storageDir: this.storageDir,
      logger: this.log,
      now: this.now,
    });
    // Register before awaiting so a concurrent event can't start a second join.
    this.active.set(channel.id, recorder);
    try {
      await recorder.start();
    } catch (err) {
      this.active.delete(channel.id);
      this.log.error(`failed to start recording ${channel.id}`, err);
      // Mark the half-opened call dir failed so it never enters the queue.
      await writeStatus(
        this.storageDir,
        recorder.callId,
        "failed",
        new Date(this.now()).toISOString(),
        err instanceof Error ? err.message : String(err),
      ).catch(() => undefined);
    }
  }

  /** Stop and enqueue a channel's recording (channel emptied or manual). */
  async stopChannel(channelId: string): Promise<void> {
    const recorder = this.active.get(channelId);
    if (!recorder) return;
    // Keep the channel marked busy until teardown fully completes. Deleting
    // before `stop()` resolves opens a window where a fast leave-then-rejoin
    // passes shouldAutoJoin and calls joinVoiceChannel for the same guild while
    // the old connection is still alive — @discordjs/voice returns that SAME
    // connection object, which the old recorder's stop() then destroys out from
    // under the new recording. Deleting in `finally` makes the rejoin wait.
    try {
      await recorder.stop();
    } finally {
      this.active.delete(channelId);
    }
  }

  /** Stop every active recording — used on graceful shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.active.keys()].map((id) => this.stopChannel(id)),
    );
  }
}

/** Map a channel's connected members to the pure {@link VoiceMember} shape. */
function toVoiceMembers(channel: VoiceBasedChannel): VoiceMember[] {
  return [...channel.members.values()].map((m) => ({
    userId: m.id,
    bot: m.user.bot,
    roleIds: [...m.roles.cache.keys()],
  }));
}
