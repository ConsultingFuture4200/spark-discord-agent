#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "@discord-agent/shared";
import { OllamaChatClient } from "./chat.js";
import { createEmailer } from "./emailer.js";
import { acquireSingleInstanceLock } from "./lock.js";
import { createLogger } from "./logger.js";
import { DiscordRestPoster } from "./poster.js";
import { WhisperHttpBackend } from "./stt.js";
import { startWatcher, type WatcherDeps } from "./watcher.js";

/**
 * Runnable composition root: build the real adapters from config/env and start
 * the watcher. Runs as a managed always-on service (NFR-2). Email delivery is
 * wired via `@discord-agent/agent-tools` when email is configured; the summary
 * recipient is `SUMMARY_EMAIL_TO`, defaulting to the agent's own from-address.
 */

const DEFAULT_WHISPER_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_POLL_INTERVAL_MS = 5000;
/** Default lease before a stuck in-progress call is reclaimed: 15 minutes. */
const DEFAULT_STALE_LEASE_MS = 15 * 60 * 1000;

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const env = process.env;

  // Enforce a single writer before touching the queue (LIOTTA-7).
  mkdirSync(config.storage.dir, { recursive: true });
  const releaseLock = acquireSingleInstanceLock(
    path.join(config.storage.dir, "processing.lock"),
  );

  const whisperBaseUrl = env["WHISPER_BASE_URL"] ?? DEFAULT_WHISPER_BASE_URL;
  const pollIntervalMs = parsePositiveInt(
    env["PROCESSING_POLL_INTERVAL_MS"],
    DEFAULT_POLL_INTERVAL_MS,
  );
  const staleLeaseMs = parsePositiveInt(
    env["PROCESSING_STALE_LEASE_MS"],
    DEFAULT_STALE_LEASE_MS,
  );

  const stt = new WhisperHttpBackend({
    baseUrl: whisperBaseUrl,
    model: config.whisper.model,
    ...(env["WHISPER_API_KEY"] ? { apiKey: env["WHISPER_API_KEY"] } : {}),
    ...(env["WHISPER_LANGUAGE"] ? { language: env["WHISPER_LANGUAGE"] } : {}),
  });

  const chat = new OllamaChatClient({
    baseUrl: config.ollama.baseUrl,
    ...(config.ollama.apiKey ? { apiKey: config.ollama.apiKey } : {}),
  });

  const poster = new DiscordRestPoster({ token: config.discord.token });

  // Optional email delivery (FR-19): only when email is configured. Recipient is
  // SUMMARY_EMAIL_TO, falling back to the agent's own from-address.
  const emailer = config.email
    ? createEmailer(config.email, env["SUMMARY_EMAIL_TO"] || config.email.smtp.from)
    : undefined;

  const deps: WatcherDeps = {
    baseDir: config.storage.dir,
    stt,
    chat,
    batchModel: config.ollama.batchModel,
    poster,
    ...(emailer ? { emailer } : {}),
    retentionDays: config.storage.audioRetentionDays,
    videoRetentionDays: config.storage.videoRetentionDays,
    staleLeaseMs,
    now: () => new Date(),
    logger,
  };

  const stop = startWatcher(deps, { intervalMs: pollIntervalMs });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down.`);
    void stop().finally(() => {
      releaseLock();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
