/**
 * Port for the agent reasoning loop.
 *
 * The real implementation lives in `@discord-agent/agent-tools` (email + DM
 * reasoning loop + tool set, per DECISIONS.md). That package is out of this
 * package's scope, so capture depends only on this narrow interface and the
 * integration layer injects the concrete loop into {@link startCapture}.
 *
 * When agent-tools lands, its exported loop is expected to satisfy
 * {@link AgentLoop} (adapt at the injection site if names differ). Until then,
 * {@link nullAgentLoop} lets the capture service run standalone.
 */

/** A text message arriving from Discord that the agent may respond to. */
export interface IncomingMessage {
  /** Where the message came from — a direct message or a guild channel. */
  source: "dm" | "channel";
  /** Discord message snowflake. */
  messageId: string;
  /** Author's user ID. */
  userId: string;
  /** Author's display name (guild nickname when available, else username). */
  username: string;
  /** Guild ID, or null for DMs. */
  guildId: string | null;
  /** Channel the message was sent in (DM channel or guild channel). */
  channelId: string;
  /** Raw message text. */
  content: string;
}

/** The agent's response. `null` from the loop means "stay silent". */
export interface AgentReply {
  content: string;
}

/** The reasoning-loop contract capture forwards text events into. */
export interface AgentLoop {
  handleMessage(msg: IncomingMessage): Promise<AgentReply | null>;
}

/**
 * Fallback loop used when no agent-tools implementation is injected. It never
 * replies, so the presence/voice-capture side of the service works on its own.
 */
export const nullAgentLoop: AgentLoop = {
  async handleMessage(): Promise<AgentReply | null> {
    return null;
  },
};
