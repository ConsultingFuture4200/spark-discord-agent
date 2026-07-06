import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ToolArgumentError,
  ToolRegistry,
  UnknownToolError,
  defineTool,
} from "../src/tools.js";

function echoTool() {
  return defineTool({
    name: "echo",
    description: "Echo a message back.",
    schema: z.object({ message: z.string().min(1) }),
    async execute(args) {
      return `echo: ${args.message}`;
    },
  });
}

describe("defineTool", () => {
  it("derives a JSON Schema from the zod schema", () => {
    const tool = echoTool();
    expect(tool.name).toBe("echo");
    expect(tool.parameters.type).toBe("object");
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props.message).toMatchObject({ type: "string" });
    // The internal $schema key is stripped for a clean tool definition.
    expect(tool.parameters.$schema).toBeUndefined();
  });

  it("validates arguments and runs execute with parsed data", async () => {
    const tool = echoTool();
    await expect(tool.execute({ message: "hi" })).resolves.toBe("echo: hi");
  });

  it("throws ToolArgumentError when arguments fail the schema", async () => {
    const tool = echoTool();
    await expect(tool.execute({ message: "" })).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
    await expect(tool.execute({})).rejects.toBeInstanceOf(ToolArgumentError);
  });
});

describe("ToolRegistry", () => {
  it("registers, lists, and exposes model definitions", () => {
    const registry = new ToolRegistry().register(echoTool());
    expect(registry.size).toBe(1);
    expect(registry.get("echo")?.name).toBe("echo");

    const defs = registry.definitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      type: "function",
      function: { name: "echo", description: "Echo a message back." },
    });
  });

  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry().register(echoTool());
    expect(() => registry.register(echoTool())).toThrow(/already registered/);
  });

  it("registerAll adds every tool", () => {
    const other = defineTool({
      name: "ping",
      description: "ping",
      schema: z.object({}),
      async execute() {
        return "pong";
      },
    });
    const registry = new ToolRegistry().registerAll([echoTool(), other]);
    expect(registry.size).toBe(2);
  });

  it("invoke parses JSON args, validates, and runs the tool", async () => {
    const registry = new ToolRegistry().register(echoTool());
    await expect(
      registry.invoke("echo", JSON.stringify({ message: "hello" })),
    ).resolves.toBe("echo: hello");
  });

  it("invoke treats empty argument strings as an empty object", async () => {
    const execute = vi.fn(async () => "ok");
    const registry = new ToolRegistry().register(
      defineTool({ name: "noargs", description: "", schema: z.object({}), execute }),
    );
    await expect(registry.invoke("noargs", "")).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledWith({});
  });

  it("invoke throws UnknownToolError for an unregistered name", async () => {
    const registry = new ToolRegistry();
    await expect(registry.invoke("nope", "{}")).rejects.toBeInstanceOf(
      UnknownToolError,
    );
  });

  it("invoke throws ToolArgumentError for malformed JSON", async () => {
    const registry = new ToolRegistry().register(echoTool());
    await expect(registry.invoke("echo", "{not json")).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
  });

  it("invoke propagates ToolArgumentError for schema-invalid args", async () => {
    const registry = new ToolRegistry().register(echoTool());
    await expect(
      registry.invoke("echo", JSON.stringify({ message: "" })),
    ).rejects.toBeInstanceOf(ToolArgumentError);
  });
});
