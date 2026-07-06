import { ChannelType, type Client, type Message } from "discord.js";
import type { AgentLoop, IncomingMessage } from "./agent.js";
import type { Logger } from "./logger.js";

/** Discord's hard per-message character limit. */
const MAX_MESSAGE_LEN = 2_000;

export interface MessageHandlerDeps {
  client: Client;
  agent: AgentLoop;
  logger: Logger;
}

/**
 * `messageCreate` handler. Forwards DMs (always) and guild messages that
 * @-mention the bot into the agent reasoning loop, then posts any reply.
 * Guild messages without a mention are ignored so the agent doesn't answer
 * every line of channel chatter.
 */
export function createMessageHandler(
  deps: MessageHandlerDeps,
): (message: Message) => Promise<void> {
  const { client, agent, logger } = deps;

  return async (message: Message): Promise<void> => {
    if (message.author.bot) return;
    if (message.system) return;

    const isDm = message.channel.type === ChannelType.DM;
    const botId = client.user?.id;
    const mentioned = botId ? message.mentions.users.has(botId) : false;
    if (!isDm && !mentioned) return;

    const incoming: IncomingMessage = {
      source: isDm ? "dm" : "channel",
      messageId: message.id,
      userId: message.author.id,
      username: message.member?.displayName ?? message.author.username,
      guildId: message.guildId,
      channelId: message.channelId,
      content: message.content,
    };

    try {
      const reply = await agent.handleMessage(incoming);
      if (!reply || !reply.content.trim()) return;
      for (const chunk of chunkMessage(reply.content)) {
        await message.reply(chunk);
      }
    } catch (err) {
      logger.error(`agent loop failed for message ${message.id}`, err);
    }
  };
}

/** Split text into Discord-sized chunks, preferring line boundaries. */
export function chunkMessage(text: string, max = MAX_MESSAGE_LEN): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A single over-long line is hard-split.
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += max) {
        chunks.push(line.slice(i, i + max));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
