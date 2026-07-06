/**
 * @discord-agent/shared — the contracts every other package imports.
 *
 * Re-exports config, manifest/status, transcript, summary, and filesystem-queue
 * helpers. Import from the package root: `import { loadConfig } from "@discord-agent/shared"`.
 */
export * from "./config.js";
export * from "./manifest.js";
export * from "./transcript.js";
export * from "./summary.js";
export * from "./queue.js";
