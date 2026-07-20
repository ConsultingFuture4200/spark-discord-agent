import type { Interaction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createInteractionHandler, type InteractionHandlerDeps } from "../src/commands.js";
import type { ArmState } from "../src/armState.js";
import type { VoiceCoordinator } from "../src/voiceState.js";

/** A minimal chat-input interaction fake for the /ask branch. */
function fakeAskInteraction(question = "what did we decide?") {
  const state = { deferred: false, replied: false };
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "ask",
    options: { getString: (_name: string, _required?: boolean) => question },
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    deferReply: vi.fn(async () => {
      state.deferred = true;
    }),
    editReply: vi.fn(async (_content: string) => {}),
    reply: vi.fn(async (_opts: unknown) => {
      state.replied = true;
    }),
  };
  return interaction;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeHandler(overrides: Partial<InteractionHandlerDeps> = {}) {
  return createInteractionHandler({
    armState: {} as ArmState,
    coordinator: {} as VoiceCoordinator,
    logger: noopLogger,
    ...overrides,
  });
}

describe("/ask slash command", () => {
  it("defers, asks gBrain, and edits the reply with the rendered answer", async () => {
    const ask = vi.fn(async () => "**Q:** what did we decide?\nanswer\n-# mode=fused");
    const handler = makeHandler({ ask });
    const interaction = fakeAskInteraction();

    await handler(interaction as unknown as Interaction);

    expect(ask).toHaveBeenCalledWith("what did we decide?");
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Q:** what did we decide?\nanswer\n-# mode=fused",
    );
  });

  it("replies that memory is not configured when ingest is disabled", async () => {
    const handler = makeHandler(); // no ask dep
    const interaction = fakeAskInteraction();

    await handler(interaction as unknown as Interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain("not configured");
  });

  it("reports a recall failure instead of throwing", async () => {
    const ask = vi.fn(async () => {
      throw new Error("gbrain down");
    });
    const handler = makeHandler({ ask });
    const interaction = fakeAskInteraction();

    await handler(interaction as unknown as Interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "Recall failed — is gBrain reachable?",
    );
  });
});
