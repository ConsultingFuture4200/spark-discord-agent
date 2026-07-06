/**
 * @discord-agent/capture — the Discord capture/presence service.
 *
 * Public surface: {@link startCapture} boots the bot, plus re-exports of the
 * pure decision logic and the agent-loop port so the integration layer and
 * tests can consume them without reaching into subpaths.
 */
import {
  ActivityType,
  Events,
  type Client,
  type Interaction,
  type Message,
  type VoiceState,
} from "discord.js";
import { reclaimStrandedRecordings, type Config } from "@discord-agent/shared";
import { nullAgentLoop, type AgentLoop } from "./agent.js";
import { ArmState } from "./armState.js";
import { buildClient } from "./client.js";
import { createInteractionHandler, registerCommands } from "./commands.js";
import { createLogger, type Logger } from "./logger.js";
import { createMessageHandler } from "./text.js";
import { VoiceCoordinator } from "./voiceState.js";

export * from "./agent.js";
export * from "./autojoin.js";
export { ArmState } from "./armState.js";
export { chunkMessage } from "./text.js";
export {
  PCM_BYTES_PER_MS,
  PCM_CHANNELS,
  PCM_FRAME_BYTES,
  PCM_SAMPLE_RATE,
  SpeakerRecorder,
} from "./recorder/speakerRecorder.js";

export interface StartCaptureOptions {
  /**
   * The agent reasoning loop (from `@discord-agent/agent-tools`). Defaults to
   * {@link nullAgentLoop} so capture runs standalone until integration injects
   * the real loop.
   */
  agent?: AgentLoop;
  /** Override the logger (defaults to one derived from `config.logLevel`). */
  logger?: Logger;
}

export interface CaptureHandle {
  client: Client;
  coordinator: VoiceCoordinator;
  armState: ArmState;
  /** Log out of Discord and stop all active recordings. */
  shutdown(): Promise<void>;
}

/**
 * Boot the capture service: build the client, wire presence, text, slash
 * commands, and voice-state auto-join, register commands, and log in. Resolves
 * once the client is ready.
 */
export async function startCapture(
  config: Config,
  options: StartCaptureOptions = {},
): Promise<CaptureHandle> {
  const logger = options.logger ?? createLogger(config.logLevel);
  const agent = options.agent ?? nullAgentLoop;

  // Crash recovery (NFR-2): no recorder is live at startup, so any call still
  // marked `recording` was stranded by a previous crash/restart. Fail it so it
  // never sits non-terminal forever.
  const stranded = await reclaimStrandedRecordings(
    config.storage.dir,
    new Date().toISOString(),
  ).catch((err) => {
    logger.error("failed reclaiming stranded recordings", err);
    return [] as string[];
  });
  if (stranded.length > 0) {
    logger.warn(`reclaimed ${stranded.length} stranded recording(s): ${stranded.join(", ")}`);
  }

  const client = buildClient();
  const armState = new ArmState(config.discord.autoRecordChannelIds);
  const coordinator = new VoiceCoordinator({
    config: config.discord,
    armState,
    storageDir: config.storage.dir,
    logger,
  });

  const onMessage = createMessageHandler({ client, agent, logger });
  const onInteraction = createInteractionHandler({
    armState,
    coordinator,
    logger,
  });

  client.on(Events.MessageCreate, (message: Message) => {
    void onMessage(message);
  });
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void onInteraction(interaction);
  });
  client.on(
    Events.VoiceStateUpdate,
    (oldState: VoiceState, newState: VoiceState) => {
      coordinator.handleVoiceStateUpdate(oldState, newState);
    },
  );
  client.on(Events.Error, (err) => logger.error("discord client error", err));

  client.once(Events.ClientReady, (ready) => {
    ready.user.setPresence({
      status: "online",
      activities: [
        { name: "for voice calls", type: ActivityType.Listening },
      ],
    });
    logger.info(`logged in as ${ready.user.tag}`);
  });

  await registerCommands(config.discord, logger);
  await client.login(config.discord.token);
  await waitForReady(client);

  return {
    client,
    coordinator,
    armState,
    async shutdown(): Promise<void> {
      await coordinator.stopAll();
      await client.destroy();
    },
  };
}

function waitForReady(client: Client): Promise<void> {
  if (client.isReady()) return Promise.resolve();
  return new Promise((resolve) => client.once(Events.ClientReady, () => resolve()));
}
