import type { ChatClient, ChatMessage } from "./chat.js";
import type { ToolRegistry } from "./tools.js";

/**
 * The shared reasoning loop (FR-7..FR-8).
 *
 * Takes one inbound message (a DM, a channel mention, or an email), runs a
 * tool-calling chat loop against the interactive model, and returns the agent's
 * reply. Both the capture service (DMs / channel text) and the processing
 * service (email handling) call this with the same tool registry, so behaviour
 * is identical across surfaces — only the registered tools differ.
 */

export type InboundKind = "dm" | "channel" | "email";

export interface InboundMessage {
  kind: InboundKind;
  /** Sender identity: a Discord display name, or an email address. */
  from: string;
  /** Subject line — email only. */
  subject?: string;
  /** The message body. */
  text: string;
}

export interface ReasoningOptions {
  client: ChatClient;
  /** Model name (the interactive model from config). */
  model: string;
  tools: ToolRegistry;
  /** Overrides the default system prompt. */
  systemPrompt?: string;
  /** Max model turns before giving up. Default 8. */
  maxSteps?: number;
  temperature?: number;
}

export interface ToolInvocationRecord {
  name: string;
  arguments: string;
  result: string;
}

export interface ReasoningResult {
  /** The agent's final text reply (may be empty if the model only ran tools). */
  reply: string;
  /** Number of model turns taken. */
  steps: number;
  /** Every tool the model invoked, in order, with its result. */
  toolCalls: ToolInvocationRecord[];
}

const DEFAULT_MAX_STEPS = 8;

const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful assistant that lives inside a private Discord server and also",
  "handles the owner's email inbox. You run entirely on local hardware; no data",
  "leaves the owner's machine except what the messaging/email transports require.",
  "Answer concisely. Use the provided tools when they help — for example, read or",
  "send email — and only then. When you have nothing left to do, reply directly to",
  "the user with your final answer.",
].join(" ");

/**
 * Run the tool-calling loop for one inbound message. Returns once the model
 * produces a turn with no tool calls, or after `maxSteps` turns.
 */
export async function runReasoningLoop(
  inbound: InboundMessage,
  options: ReasoningOptions,
): Promise<ReasoningResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: renderInbound(inbound) },
  ];

  const toolCalls: ToolInvocationRecord[] = [];
  const definitions = options.tools.definitions();
  let lastContent = "";

  for (let step = 1; step <= maxSteps; step++) {
    const response = await options.client.complete({
      model: options.model,
      messages,
      ...(definitions.length > 0 ? { tools: definitions } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    const choice = response.choices[0];
    if (!choice) {
      return { reply: lastContent, steps: step, toolCalls };
    }
    const assistant = choice.message;
    messages.push(assistant);
    if (typeof assistant.content === "string") lastContent = assistant.content;

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return { reply: assistant.content ?? "", steps: step, toolCalls };
    }

    for (const call of calls) {
      const result = await runToolCall(options.tools, call.function.name, call.function.arguments);
      toolCalls.push({
        name: call.function.name,
        arguments: call.function.arguments,
        result,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Exhausted the step budget while still calling tools.
  return { reply: lastContent, steps: maxSteps, toolCalls };
}

/** Invoke a tool, converting any failure into a message the model can recover from. */
async function runToolCall(
  tools: ToolRegistry,
  name: string,
  rawArgs: string,
): Promise<string> {
  try {
    return await tools.invoke(name, rawArgs);
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
}

/** Render an inbound message into the user-turn content. */
export function renderInbound(inbound: InboundMessage): string {
  switch (inbound.kind) {
    case "email":
      return [
        `New email from ${inbound.from}.`,
        `Subject: ${inbound.subject ?? "(no subject)"}`,
        "",
        inbound.text,
      ].join("\n");
    case "channel":
      return `${inbound.from} (in a channel): ${inbound.text}`;
    case "dm":
      return `${inbound.from} (direct message): ${inbound.text}`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
