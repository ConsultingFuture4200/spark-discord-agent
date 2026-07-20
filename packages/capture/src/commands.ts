import {
  ChannelType,
  GuildMember,
  type Interaction,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type VoiceBasedChannel,
} from "discord.js";
import type { DiscordConfig } from "@discord-agent/shared";
import type { ArmState } from "./armState.js";
import type { Logger } from "./logger.js";
import type { VoiceCoordinator } from "./voiceState.js";

/**
 * Slash commands for operator control of auto-record (PRD FR-9 manual arm/
 * disarm override) plus community-memory recall. `/arm` and `/disarm` take an
 * optional voice-channel option; when omitted they act on the caller's current
 * voice channel. `/ask` queries gBrain's fused recall (answers include the
 * engine honesty footer) and works only when ingest is configured.
 */
export const commandData = [
  new SlashCommandBuilder()
    .setName("arm")
    .setDescription("Arm a voice channel so the agent auto-records active calls")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Voice channel (defaults to your current one)")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("disarm")
    .setDescription("Disarm a voice channel and stop any active recording")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Voice channel (defaults to your current one)")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the community memory (gBrain fused recall)")
    .addStringOption((o) =>
      o
        .setName("question")
        .setDescription("What do you want to know?")
        .setRequired(true),
    ),
].map((c) => c.toJSON());

/** Register the guild-scoped slash commands (instant, unlike global commands). */
export async function registerCommands(
  config: DiscordConfig,
  logger: Logger,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(
    Routes.applicationGuildCommands(config.appId, config.guildId),
    { body: commandData },
  );
  logger.info(`registered ${commandData.length} slash command(s)`);
}

export interface InteractionHandlerDeps {
  armState: ArmState;
  coordinator: VoiceCoordinator;
  logger: Logger;
  /**
   * The /ask answerer (from the ingest wiring). Absent when ingest is
   * disabled — /ask then replies that the memory service is not configured.
   */
  ask?: (question: string) => Promise<string>;
}

export function createInteractionHandler(
  deps: InteractionHandlerDeps,
): (interaction: Interaction) => Promise<void> {
  const { armState, coordinator, logger, ask } = deps;

  return async (interaction: Interaction): Promise<void> => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ask") {
      const question = interaction.options.getString("question", true);
      if (!ask) {
        await interaction.reply({
          content: "The community memory (gBrain ingest) is not configured.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      try {
        await interaction.deferReply();
        await interaction.editReply(await ask(question));
      } catch (err) {
        logger.error("/ask failed", err);
        const content = "Recall failed — is gBrain reachable?";
        await (interaction.deferred
          ? interaction.editReply(content)
          : interaction.reply({ content, flags: MessageFlags.Ephemeral })
        ).catch(() => undefined);
      }
      return;
    }

    const channel = resolveTargetChannel(interaction);
    if (!channel) {
      await interaction.reply({
        content:
          "Specify a voice channel, or run this while connected to one.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      if (interaction.commandName === "arm") {
        const changed = armState.arm(channel.id);
        await interaction.reply({
          content: changed
            ? `Armed **${channel.name}** for auto-recording.`
            : `**${channel.name}** was already armed.`,
          flags: MessageFlags.Ephemeral,
        });
        // Arming mid-call should start recording if the room already qualifies.
        await coordinator.evaluateChannel(channel);
      } else if (interaction.commandName === "disarm") {
        const changed = armState.disarm(channel.id);
        if (coordinator.isRecording(channel.id)) {
          await coordinator.stopChannel(channel.id);
        }
        await interaction.reply({
          content: changed
            ? `Disarmed **${channel.name}**.`
            : `**${channel.name}** was not armed.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      logger.error(`slash command ${interaction.commandName} failed`, err);
      if (!interaction.replied) {
        await interaction
          .reply({ content: "Command failed.", flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
      }
    }
  };
}

/** The channel option, or the invoker's current voice channel, or null. */
function resolveTargetChannel(
  interaction: Interaction & { options?: unknown },
): VoiceBasedChannel | null {
  if (!interaction.isChatInputCommand()) return null;
  const option = interaction.options.getChannel("channel");
  if (option && "members" in option && option.type === ChannelType.GuildVoice) {
    return option as VoiceBasedChannel;
  }
  const member = interaction.member;
  if (member instanceof GuildMember && member.voice.channel) {
    return member.voice.channel;
  }
  return null;
}
