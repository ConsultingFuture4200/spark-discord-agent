/**
 * @discord-agent/agent-tools — the reasoning loop and the tools it drives.
 *
 * Shared by the capture service (DM / channel text) and the processing service
 * (email handling / delivery). Import from the package root:
 * `import { runReasoningLoop, ToolRegistry } from "@discord-agent/agent-tools"`.
 */
export * from "./chat.js";
export * from "./tools.js";
export * from "./email.js";
export * from "./loop.js";
