import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "./chat.js";

/**
 * Typed tool registry.
 *
 * A tool is authored with {@link defineTool}: a zod schema is the single source
 * of truth for both the JSON Schema advertised to the model and the runtime
 * validation of the arguments the model sends back. Authoring is fully typed
 * (the `execute` callback receives parsed args), but the registry stores the
 * type-erased {@link RegisteredTool} so heterogeneous tools live in one map.
 *
 * The registry is the extension seam: the processing service registers the
 * email tools; the capture service can register a Discord-reply tool later, and
 * the reasoning loop consumes whatever is present.
 */

/** A tool after type erasure — args validated internally against its schema. */
export interface RegisteredTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, handed to the model. */
  parameters: Record<string, unknown>;
  /** Validate `rawArgs` against the tool schema and run it; returns model-visible text. */
  execute(rawArgs: unknown): Promise<string>;
}

export class UnknownToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`unknown tool: ${toolName}`);
    this.name = "UnknownToolError";
  }
}

export class ToolArgumentError extends Error {
  constructor(
    public readonly toolName: string,
    detail: string,
  ) {
    super(`invalid arguments for ${toolName}: ${detail}`);
    this.name = "ToolArgumentError";
  }
}

/**
 * Author a typed tool. `Args` is inferred from the zod `schema`, so `execute`
 * is fully typed while the returned tool is erased for storage.
 */
export function defineTool<S extends z.ZodTypeAny>(spec: {
  name: string;
  description: string;
  schema: S;
  execute: (args: z.infer<S>) => Promise<string>;
}): RegisteredTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: toParametersSchema(spec.schema),
    async execute(rawArgs: unknown): Promise<string> {
      const result = spec.schema.safeParse(rawArgs);
      if (!result.success) {
        throw new ToolArgumentError(spec.name, formatIssues(result.error));
      }
      return spec.execute(result.data as z.infer<S>);
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Iterable<RegisteredTool>): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** Tool definitions in OpenAI `tools` shape, for a chat completion request. */
  definitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Look up a tool, parse its raw JSON argument string, validate, and execute.
   * Throws {@link UnknownToolError} / {@link ToolArgumentError}; the reasoning
   * loop catches these and feeds the message back to the model.
   */
  async invoke(name: string, rawArgsJson: string): Promise<string> {
    const tool = this.get(name);
    if (!tool) throw new UnknownToolError(name);

    let args: unknown;
    const trimmed = rawArgsJson.trim();
    try {
      args = trimmed.length > 0 ? JSON.parse(trimmed) : {};
    } catch {
      throw new ToolArgumentError(name, "arguments were not valid JSON");
    }
    return tool.execute(args);
  }
}

function toParametersSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
