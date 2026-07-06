/**
 * Runtime arm/disarm state for auto-record channels.
 *
 * Seeded from the configured allowlist (`DISCORD_AUTORECORD_CHANNEL_IDS`) and
 * mutated by the `/arm` and `/disarm` slash commands. In-memory only: arming is
 * intentionally ephemeral so a restart falls back to the configured allowlist.
 */
export class ArmState {
  private readonly armed: Set<string>;

  constructor(initialChannelIds: Iterable<string> = []) {
    this.armed = new Set(initialChannelIds);
  }

  /** Arm a channel. Returns false if it was already armed. */
  arm(channelId: string): boolean {
    if (this.armed.has(channelId)) return false;
    this.armed.add(channelId);
    return true;
  }

  /** Disarm a channel. Returns false if it was not armed. */
  disarm(channelId: string): boolean {
    return this.armed.delete(channelId);
  }

  isArmed(channelId: string): boolean {
    return this.armed.has(channelId);
  }

  /** Live view of the armed set, for passing to the trigger decision. */
  get channelIds(): ReadonlySet<string> {
    return this.armed;
  }
}
