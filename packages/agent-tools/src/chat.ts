/**
 * OpenAI-compatible chat client.
 *
 * The Spark serves its interactive model behind an OpenAI-compatible endpoint
 * (Ollama's `/v1`), so a chat completion is a standard POST to
 * `<baseUrl>/chat/completions`. This module defines the wire types, a small
 * {@link ChatClient} interface (so the reasoning loop can be unit-tested against
 * a fake), and {@link OllamaChatClient}, the real fetch-based implementation.
 */

/** A message in an OpenAI-style conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Null when an assistant turn is only tool calls, per the OpenAI contract. */
  content: string | null;
  /** Present on assistant turns that call tools. */
  tool_calls?: ToolCall[];
  /** Present on `tool` messages; ties the result to the originating call. */
  tool_call_id?: string;
  /** Optional function/tool name label. */
  name?: string;
}

/** A tool call emitted by the model. `arguments` is a JSON string. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A tool advertised to the model (JSON Schema parameters). */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface ChatCompletionChoice {
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

/**
 * Minimal chat interface the reasoning loop depends on. Tests supply a fake;
 * production supplies {@link OllamaChatClient}.
 */
export interface ChatClient {
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

/** Thrown when the endpoint returns a non-2xx response or unusable body. */
export class ChatCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatCompletionError";
  }
}

export interface OllamaChatClientOptions {
  /** Base URL including the OpenAI-compatible prefix, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** Optional bearer token; Ollama ignores it, but vLLM/others may require it. */
  apiKey?: string;
  /** Inject a fetch implementation for testing; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Real OpenAI-compatible client, pointed at the Spark's Ollama endpoint. */
export class OllamaChatClient implements ChatClient {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaChatClientOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new ChatCompletionError(
        `chat completion failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      );
    }

    const json = (await res.json()) as ChatCompletionResponse;
    if (!json || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new ChatCompletionError("chat completion returned no choices");
    }
    return json;
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
