import { describe, expect, it, vi } from "vitest";
import {
  ChatCompletionError,
  OllamaChatClient,
  type ChatCompletionResponse,
} from "../src/chat.js";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const OK_BODY: ChatCompletionResponse = {
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

describe("OllamaChatClient", () => {
  it("POSTs to <baseUrl>/chat/completions with the model and messages", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
    const client = new OllamaChatClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await client.complete({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res).toEqual(OK_BODY);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "qwen2.5:7b", messages: [{ role: "user", content: "hi" }] });
    // No tools/temperature supplied => omitted from the body.
    expect(body.tools).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("normalises a trailing slash on the base URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
    const client = new OllamaChatClient({
      baseUrl: "http://127.0.0.1:11434/v1/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.complete({ model: "m", messages: [] });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("sends a bearer token only when apiKey is set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
    const client = new OllamaChatClient({
      baseUrl: "http://x/v1",
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.complete({ model: "m", messages: [], tools: [], temperature: 0.5 });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    // Empty tools array is still omitted; temperature is forwarded.
    const body = JSON.parse(init.body as string);
    expect(body.tools).toBeUndefined();
    expect(body.temperature).toBe(0.5);
  });

  it("throws ChatCompletionError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "boom" }, { ok: false, status: 500 }),
    );
    const client = new OllamaChatClient({
      baseUrl: "http://x/v1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(
      ChatCompletionError,
    );
  });

  it("throws ChatCompletionError when the body has no choices", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    const client = new OllamaChatClient({
      baseUrl: "http://x/v1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(
      ChatCompletionError,
    );
  });
});
