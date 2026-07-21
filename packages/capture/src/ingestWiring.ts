import {
  Events,
  type Client,
  type Message,
  type PartialMessage,
} from "discord.js";
import type { IngestConfig } from "@discord-agent/shared";
import {
  ask,
  GbrainClient,
  IngestEmitter,
  loadConsentConfig,
  type MessageDeleteEvent,
  type MessageEvent,
} from "@discord-agent/ingest";
import type { Logger } from "./logger.js";

/**
 * Capture-side wiring for gBrain ingest (PRD Phase 2): adapts discord.js
 * message events into the library-free `@discord-agent/ingest` shapes and
 * attaches the create/edit/delete listeners. All consent decisions live in
 * the emitter (channel allowlist + member opt-out, default DENY) — this
 * module only translates shapes.
 */

export interface IngestWiring {
  emitter: IngestEmitter;
  /** The /ask command's answerer: fused gBrain recall, rendered for Discord. */
  ask: (question: string) => Promise<string>;
}

/** Build the emitter + /ask answerer from the validated ingest config. */
export async function buildIngestWiring(
  config: IngestConfig,
  logger: Logger,
): Promise<IngestWiring> {
  const client = new GbrainClient({ baseUrl: config.gbrainBaseUrl });
  const consent = await loadConsentConfig(config.consentPath);
  if (consent.allowChannels.length === 0) {
    logger.warn(
      `ingest consent allowlist is empty (${config.consentPath}); nothing will be ingested`,
    );
  }
  const emitter = new IngestEmitter({
    client,
    consent,
    region: config.region,
    logger,
  });
  return {
    emitter,
    ask: (question: string) => ask(client, question, { region: config.region }),
  };
}

/**
 * Convert a discord.js guild message into an ingest {@link MessageEvent}.
 * Returns null for messages ingest never sees: bots/system messages, DMs,
 * and empty messages with no attachments. Pure apart from reading `message`.
 */
export function messageEventFromDiscord(
  message: Message | PartialMessage,
): MessageEvent | null {
  if (message.partial) return null;
  if (message.author.bot || message.system) return null;
  if (!message.guildId) return null;
  if (message.content.trim() === "" && message.attachments.size === 0) return null;

  const channel = message.channel;
  const inThread = "isThread" in channel && channel.isThread();
  const parentId = inThread ? channel.parentId : null;

  return {
    guildId: message.guildId,
    channelId: parentId ?? message.channelId,
    ...(inThread ? { threadId: message.channelId } : {}),
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    ...(message.reference?.messageId
      ? { replyToMessageId: message.reference.messageId }
      : {}),
    mentionUserIds: [...message.mentions.users.keys()],
    attachments: [...message.attachments.values()].map((a) => ({
      id: a.id,
      url: a.url,
      filename: a.name,
      ...(a.contentType ? { contentType: a.contentType } : {}),
    })),
  };
}

/** Convert a (possibly partial) deleted message into a delete event. */
export function deleteEventFromDiscord(
  message: Message | PartialMessage,
): MessageDeleteEvent | null {
  if (!message.guildId) return null;
  const channel = message.channel;
  const inThread = "isThread" in channel && channel.isThread();
  const parentId = inThread ? channel.parentId : null;
  return {
    guildId: message.guildId,
    channelId: parentId ?? message.channelId,
    messageId: message.id,
  };
}

/**
 * Attach the messageCreate/messageUpdate/messageDelete ingest listeners.
 * Every emit is fire-and-forget with its own error handling — ingest must
 * never break capture's primary duties.
 */
export function attachIngestListeners(
  client: Client,
  wiring: IngestWiring,
  logger: Logger,
): void {
  const emit = (label: string, work: () => Promise<unknown>): void => {
    void work().catch((err) => logger.error(`ingest ${label} failed`, err));
  };

  client.on(Events.MessageCreate, (message: Message) => {
    const event = messageEventFromDiscord(message);
    if (!event) return;
    emit(`message ${message.id}`, () => wiring.emitter.handleMessage(event));
  });

  client.on(
    Events.MessageUpdate,
    (_old: Message | PartialMessage, updated: Message | PartialMessage) => {
      const event = messageEventFromDiscord(updated);
      if (!event) return;
      emit(`edit ${updated.id}`, () => wiring.emitter.handleMessageEdit(event));
    },
  );

  client.on(Events.MessageDelete, (message: Message | PartialMessage) => {
    const event = deleteEventFromDiscord(message);
    if (!event) return;
    emit(`delete ${message.id}`, () => wiring.emitter.handleMessageDelete(event));
  });
}
