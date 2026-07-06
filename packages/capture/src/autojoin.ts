/**
 * Auto-join trigger decision — pure logic, no discord.js dependency, so it is
 * exhaustively unit-testable.
 *
 * Policy (DECISIONS.md Q4 / PRD FR-9, FR-13):
 *   - A channel must be *armed* (in the allowlist, or armed at runtime).
 *   - Join when at least one non-bot human is present AND either no trigger
 *     roles/users are configured (default: any human), or a configured trigger
 *     user/role is among the humans present.
 *   - Never join a channel that is already being recorded.
 *   - Leave a recorded channel once no non-bot humans remain.
 */

/** A member currently connected to a voice channel. */
export interface VoiceMember {
  userId: string;
  bot: boolean;
  roleIds: string[];
}

export interface AutoJoinInput {
  channelId: string;
  /** Channels currently armed for auto-record (allowlist + runtime arms). */
  armedChannelIds: ReadonlySet<string>;
  /** Everyone connected to the channel right now, including bots. */
  members: readonly VoiceMember[];
  /** Configured trigger user IDs; empty = trigger on any human. */
  triggerUserIds: readonly string[];
  /** Configured trigger role IDs; empty = trigger on any human. */
  triggerRoleIds: readonly string[];
  /** True if this channel already has an active recording. */
  alreadyRecording: boolean;
}

/** Non-bot members of a voice channel. */
export function humanMembers(
  members: readonly VoiceMember[],
): VoiceMember[] {
  return members.filter((m) => !m.bot);
}

/** Whether a member matches any configured trigger user or role. */
function matchesTrigger(
  member: VoiceMember,
  triggerUserIds: readonly string[],
  triggerRoleIds: readonly string[],
): boolean {
  if (triggerUserIds.includes(member.userId)) return true;
  return member.roleIds.some((r) => triggerRoleIds.includes(r));
}

/** Decide whether the agent should auto-join and start recording `channelId`. */
export function shouldAutoJoin(input: AutoJoinInput): boolean {
  if (input.alreadyRecording) return false;
  if (!input.armedChannelIds.has(input.channelId)) return false;

  const humans = humanMembers(input.members);
  if (humans.length === 0) return false;

  const hasTriggers =
    input.triggerUserIds.length > 0 || input.triggerRoleIds.length > 0;
  if (!hasTriggers) return true;

  return humans.some((h) =>
    matchesTrigger(h, input.triggerUserIds, input.triggerRoleIds),
  );
}

/**
 * Decide whether the agent should stop recording and leave. The stop condition
 * (PRD FR-13) is the channel emptying of non-bot humans.
 */
export function shouldLeave(input: {
  members: readonly VoiceMember[];
  isRecording: boolean;
}): boolean {
  if (!input.isRecording) return false;
  return humanMembers(input.members).length === 0;
}
