import { Client, GatewayIntentBits, Partials } from "discord.js";

/**
 * Build the Discord client with exactly the intents the capture service needs:
 *   - Guilds / GuildVoiceStates: presence in the guild + voice-state auto-join.
 *   - GuildMessages + MessageContent: read channel text to forward to the agent.
 *   - GuildMembers: resolve real display names for speaker labels (FR-16).
 *   - DirectMessages (+ Channel partial): receive and reply to DMs (FR-7).
 *
 * MessageContent and GuildMembers are privileged intents and must be enabled in
 * the Discord Developer Portal for the bot application.
 */
export function buildClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
}
