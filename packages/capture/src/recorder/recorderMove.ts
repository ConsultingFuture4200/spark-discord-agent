/**
 * Recorder-account move decision + a thin mover (SPEC M7 §4). The bot may not
 * originate a user account's voice connection (self-botting / ToS), but moving
 * an **already-connected** member between channels is a normal `Move Members`
 * capability. So the decision helper is pure and unit-tested; the mover only
 * calls `member.voice.setChannel` when the member is already connected.
 */
import type { Logger } from "../logger.js";

/** The slice of a discord.js `GuildMember` the mover needs. */
export interface RecorderMember {
  readonly voice: {
    /** Channel the member is currently connected to, or null if disconnected. */
    readonly channelId: string | null;
    setChannel(channel: string): Promise<unknown>;
  };
}

export interface ShouldMoveRecorderInput {
  /** Configured recorder account; undefined = feature off, never move. */
  recorderUserId: string | undefined;
  /** Whether that member is currently connected to a voice channel. */
  memberIsConnected: boolean;
}

/**
 * Decide whether to move the recorder account. Only an already-connected member
 * with a configured id is movable — a bot cannot originate their connection.
 */
export function shouldMoveRecorder(input: ShouldMoveRecorderInput): boolean {
  if (!input.recorderUserId) return false;
  return input.memberIsConnected;
}

export interface MoveRecorderInput {
  recorderUserId: string | undefined;
  /** Resolved guild member, or null if not found in the guild. */
  member: RecorderMember | null;
  targetChannelId: string;
  logger: Logger;
  /** Human-readable context for logs, e.g. "into call" / "back to lobby". */
  context: string;
}

/**
 * Move the recorder account to `targetChannelId` when {@link shouldMoveRecorder}
 * allows it; otherwise log and skip. Best-effort — the discord call is wrapped
 * so a move failure never propagates into the call lifecycle.
 */
export async function moveRecorder(input: MoveRecorderInput): Promise<void> {
  const memberIsConnected = input.member?.voice.channelId != null;
  if (
    !shouldMoveRecorder({
      recorderUserId: input.recorderUserId,
      memberIsConnected,
    })
  ) {
    input.logger.info(
      `recorder move skipped (${input.context}): recorder ${input.recorderUserId ?? "unset"} not connected`,
    );
    return;
  }
  try {
    // Guarded by shouldMoveRecorder: member is non-null and connected here.
    await input.member?.voice.setChannel(input.targetChannelId);
    input.logger.info(
      `recorder ${input.recorderUserId} moved ${input.context} (${input.targetChannelId})`,
    );
  } catch (err) {
    input.logger.warn(
      `failed moving recorder ${input.recorderUserId} ${input.context}`,
      err,
    );
  }
}
