/**
 * @discord-agent/processing — the post-call batch service.
 *
 * Watches the filesystem queue for `ready-to-process` calls and runs each
 * through: faster-whisper STT per track → timestamp merge → adaptive dual JSON
 * summary via the local Ollama endpoint → post to a Discord thread (+ optional
 * email) → persist artifacts → audio retention. All ports are injectable; the
 * runnable composition lives in `main.ts`.
 */
export * from "./ports.js";
export * from "./logger.js";
export * from "./json.js";
export * from "./merge.js";
export * from "./stt.js";
export * from "./chat.js";
export * from "./summarize.js";
export * from "./render.js";
export * from "./poster.js";
export * from "./retention.js";
export * from "./pipeline.js";
export * from "./watcher.js";
