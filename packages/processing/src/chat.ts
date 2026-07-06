import { z } from "zod";
import type { ChatClient, ChatRequest } from "./ports.js";

/**
 * OpenAI-compatible chat client for the local Ollama endpoint on the Spark
 * (`POST {baseUrl}/chat/completions`). `baseUrl` already includes the `/v1`
 * suffix (see config). No third-party API is ever contacted (NFR-1).
 */

const ChatCompletion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
});

export interface OllamaChatOptions {
  /** e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** Optional bearer token (Ollama ignores it; vLLM may require it). */
  apiKey?: string;
  /** Injectable fetch, for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class OllamaChatClient implements ChatClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OllamaChatOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async chat(request: ChatRequest): Promise<string> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
    };
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.jsonMode) body["response_format"] = { type: "json_object" };

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers["authorization"] = `Bearer ${this.opts.apiKey}`;

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Chat request failed (${res.status} ${res.statusText}): ${errBody.slice(0, 500)}`,
      );
    }

    const parsed = ChatCompletion.parse(await res.json());
    // `.min(1)` guarantees an element; assert for noUncheckedIndexedAccess.
    return parsed.choices[0]!.message.content;
  }
}
