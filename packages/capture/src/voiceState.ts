import type { VoiceBasedChannel, VoiceState } from "discord.js";
import {
  writeStatus,
  type DiscordConfig,
  type ObsConfig,
} from "@discord-agent/shared";
import type { ArmState } from "./armState.js";
import { shouldAutoJoin, shouldLeave, type VoiceMember } from "./autojoin.js";
import type { Logger } from "./logger.js";
import { NoopVideoRecorder, ObsVideoRecorder, type VideoRecorder } from "./obs.js";
import { CallRecorder } from "./recorder/callRecorder.js";
import { moveRecorder, type RecorderMember } from "./recorder/recorderMove.js";

export interface VoiceCoordinatorDeps {
  config: DiscordConfig;
  armState: ArmState;
  storageDir: string;
  logger: Logger;
  /**
   * OBS video-recording config; present only when the feature is enabled. When
   * undefined, video and recorder-move are off and behavior is identical to
   * pre-M7 (audio-only).
   */
  obs?: ObsConfig;
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
  private readonly obs: ObsConfig | undefined;
  private readonly now: () => number;
  private readonly active = new Map<string, CallRecorder>();
  /** Channel objects for active recordings, kept for the recorder move-back. */
  private readonly activeChannels = new Map<string, VoiceBasedChannel>();

  constructor(deps: VoiceCoordinatorDeps) {
    this.config = deps.config;
    this.armState = deps.armState;
    this.storageDir = deps.storageDir;
    this.log = deps.logger;
    this.obs = deps.obs;
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
      videoRecorder: this.makeVideoRecorder(),
      videoEnabled: this.obs !== undefined,
      ...(this.obs?.outputDir ? { obsOutputDir: this.obs.outputDir } : {}),
      ...(this.obs?.recorderUserId
        ? { recorderUserId: this.obs.recorderUserId }
        : {}),
    });
    // Register before awaiting so a concurrent event can't start a second join.
    this.active.set(channel.id, recorder);
    this.activeChannels.set(channel.id, channel);
    try {
      await recorder.start();
    } catch (err) {
      this.active.delete(channel.id);
      this.activeChannels.delete(channel.id);
      this.log.error(`failed to start recording ${channel.id}`, err);
      // Mark the half-opened call dir failed so it never enters the queue.
      await writeStatus(
        this.storageDir,
        recorder.callId,
        "failed",
        new Date(this.now()).toISOString(),
        err instanceof Error ? err.message : String(err),
      ).catch(() => undefined);
      return;
    }
    // The recorder account is pulled into the call inside CallRecorder.start(),
    // before OBS StartRecord, so the first frames capture the call not the lobby.
  }

  /** Build a per-call video recorder — OBS when enabled, else a no-op. */
  private makeVideoRecorder(): VideoRecorder {
    if (!this.obs) return new NoopVideoRecorder();
    return new ObsVideoRecorder({
      websocketUrl: this.obs.websocketUrl,
      websocketPassword: this.obs.websocketPassword,
      logger: this.log,
      now: this.now,
    });
  }

  /** Move the recorder account back to its lobby channel (best-effort). */
  private async moveRecorderToLobby(channel: VoiceBasedChannel): Promise<void> {
    const recorderUserId = this.obs?.recorderUserId;
    const lobbyId = this.obs?.recorderLobbyChannelId;
    if (!recorderUserId || !lobbyId) return;
    await moveRecorder({
      recorderUserId,
      member: resolveRecorderMember(channel, recorderUserId),
      targetChannelId: lobbyId,
      logger: this.log,
      context: "back to lobby",
    });
  }

  /** Stop and enqueue a channel's recording (channel emptied or manual). */
  async stopChannel(channelId: string): Promise<void> {
    const recorder = this.active.get(channelId);
    if (!recorder) return;
    const channel = this.activeChannels.get(channelId);
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
      this.activeChannels.delete(channelId);
    }
    // Best-effort: return the recorder account to its lobby.
    if (channel) await this.moveRecorderToLobby(channel);
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

/**
 * Resolve the recorder account's guild member from cache. Returns null when the
 * account isn't cached (e.g. offline) so the mover logs and skips — a bot cannot
 * originate the recorder's voice connection.
 */
function resolveRecorderMember(
  channel: VoiceBasedChannel,
  recorderUserId: string,
): RecorderMember | null {
  return channel.guild.members.cache.get(recorderUserId) ?? null;
}
