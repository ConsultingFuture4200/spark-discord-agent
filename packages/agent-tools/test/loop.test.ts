import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ChatClient,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolCall,
} from "../src/chat.js";
import { renderInbound, runReasoningLoop } from "../src/loop.js";
import { ToolRegistry, defineTool } from "../src/tools.js";

/** A ChatClient that replays a scripted list of responses and records requests. */
class ScriptedClient implements ChatClient {
  readonly requests: ChatCompletionRequest[] = [];
  private index = 0;
  constructor(private readonly script: ChatCompletionResponse[]) {}

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    this.requests.push(req);
    const response = this.script[this.index];
    if (!response) throw new Error("ScriptedClient ran out of responses");
    this.index += 1;
    return response;
  }
}

function textReply(content: string): ChatCompletionResponse {
  return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function toolReply(calls: ToolCall[]): ChatCompletionResponse {
  return {
    choices: [
      {
        message: { role: "assistant", content: null, tool_calls: calls },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function call(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function weatherRegistry(record?: (city: string) => void) {
  return new ToolRegistry().register(
    defineTool({
      name: "get_weather",
      description: "Get the weather for a city.",
      schema: z.object({ city: z.string() }),
      async execute(args) {
        record?.(args.city);
        return `sunny in ${args.city}`;
      },
    }),
  );
}

describe("runReasoningLoop", () => {
  it("returns the model's reply directly when no tools are called", async () => {
    const client = new ScriptedClient([textReply("hello there")]);
    const result = await runReasoningLoop(
      { kind: "dm", from: "Ada", text: "hi" },
      { client, model: "m", tools: new ToolRegistry() },
    );
    expect(result.reply).toBe("hello there");
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toEqual([]);
    // No tools registered => the request omits the tools field.
    expect(client.requests[0]?.tools).toBeUndefined();
  });

  it("executes a requested tool, feeds the result back, and returns the final reply", async () => {
    const seen: string[] = [];
    const tools = weatherRegistry((c) => seen.push(c));
    const client = new ScriptedClient([
      toolReply([call("c1", "get_weather", { city: "Paris" })]),
      textReply("It is sunny in Paris."),
    ]);

    const result = await runReasoningLoop(
      { kind: "channel", from: "Ada", text: "weather in Paris?" },
      { client, model: "m", tools },
    );

    expect(seen).toEqual(["Paris"]);
    expect(result.reply).toBe("It is sunny in Paris.");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([
      { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }), result: "sunny in Paris" },
    ]);

    // Second request carries the assistant tool_call turn plus the tool result.
    const second = client.requests[1]!;
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ tool_call_id: "c1", content: "sunny in Paris" });
    // Tools are advertised on every turn.
    expect(second.tools?.[0]?.function.name).toBe("get_weather");
  });

  it("feeds tool errors back to the model instead of throwing", async () => {
    const tools = new ToolRegistry(); // get_weather is NOT registered
    const client = new ScriptedClient([
      toolReply([call("c1", "get_weather", { city: "Paris" })]),
      textReply("Sorry, I could not check the weather."),
    ]);

    const result = await runReasoningLoop(
      { kind: "dm", from: "Ada", text: "weather?" },
      { client, model: "m", tools },
    );

    expect(result.toolCalls[0]?.result).toMatch(/^Error: unknown tool/);
    expect(result.reply).toBe("Sorry, I could not check the weather.");
  });

  it("stops at maxSteps when the model keeps calling tools", async () => {
    const tools = weatherRegistry();
    const client = new ScriptedClient([
      toolReply([call("c1", "get_weather", { city: "A" })]),
      toolReply([call("c2", "get_weather", { city: "B" })]),
      toolReply([call("c3", "get_weather", { city: "C" })]),
    ]);

    const result = await runReasoningLoop(
      { kind: "dm", from: "Ada", text: "loop" },
      { client, model: "m", tools, maxSteps: 2 },
    );

    expect(result.steps).toBe(2);
    expect(result.toolCalls).toHaveLength(2);
    expect(client.requests).toHaveLength(2);
  });

  it("passes temperature and a custom system prompt through", async () => {
    const client = new ScriptedClient([textReply("ok")]);
    await runReasoningLoop(
      { kind: "dm", from: "Ada", text: "hi" },
      { client, model: "m", tools: new ToolRegistry(), systemPrompt: "be terse", temperature: 0.2 },
    );
    const req = client.requests[0]!;
    expect(req.temperature).toBe(0.2);
    expect(req.messages[0]).toEqual({ role: "system", content: "be terse" });
  });
});

describe("renderInbound", () => {
  it("formats an email with sender and subject", () => {
    const out = renderInbound({
      kind: "email",
      from: "boss@example.com",
      subject: "Report",
      text: "Where is it?",
    });
    expect(out).toContain("New email from boss@example.com.");
    expect(out).toContain("Subject: Report");
    expect(out).toContain("Where is it?");
  });

  it("labels DM and channel messages distinctly", () => {
    expect(renderInbound({ kind: "dm", from: "Ada", text: "yo" })).toBe(
      "Ada (direct message): yo",
    );
    expect(renderInbound({ kind: "channel", from: "Ada", text: "yo" })).toBe(
      "Ada (in a channel): yo",
    );
  });
});
