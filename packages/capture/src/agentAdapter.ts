import {
  createEmailTools,
  ImapSmtpEmailGateway,
  OllamaChatClient,
  runReasoningLoop,
  ToolRegistry,
  type InboundMessage,
} from "@discord-agent/agent-tools";
import type { Config } from "@discord-agent/shared";
import type { AgentLoop, AgentReply, IncomingMessage } from "./agent.js";

/**
 * Concrete {@link AgentLoop} backed by `@discord-agent/agent-tools`.
 *
 * This is the capture-side half of the capture ↔ agent-tools seam: it builds the
 * interactive chat client and tool registry from config once, then adapts each
 * Discord text event onto {@link runReasoningLoop}. Email tools are registered
 * only when email is configured, so the model can read/send mail from a DM.
 */
export function createAgentLoop(config: Config): AgentLoop {
  const client = new OllamaChatClient({
    baseUrl: config.ollama.baseUrl,
    ...(config.ollama.apiKey ? { apiKey: config.ollama.apiKey } : {}),
  });

  const tools = new ToolRegistry();
  if (config.email) {
    tools.registerAll(createEmailTools(new ImapSmtpEmailGateway(config.email)));
  }

  return {
    async handleMessage(msg: IncomingMessage): Promise<AgentReply | null> {
      const inbound: InboundMessage = {
        kind: msg.source,
        from: msg.username,
        text: msg.content,
      };
      const result = await runReasoningLoop(inbound, {
        client,
        model: config.ollama.interactiveModel,
        tools,
      });
      const reply = result.reply.trim();
      return reply.length > 0 ? { content: reply } : null;
    },
  };
}
