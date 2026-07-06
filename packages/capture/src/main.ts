import { loadConfig } from "@discord-agent/shared";
import { createAgentLoop } from "./agentAdapter.js";
import { createLogger } from "./logger.js";
import { startCapture } from "./index.js";

/**
 * CLI entrypoint for the capture service. Loads config from the environment,
 * starts the bot, and wires graceful shutdown so an in-progress recording is
 * finalized and enqueued on SIGINT/SIGTERM.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const agent = createAgentLoop(config);

  const handle = await startCapture(config, { agent, logger });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    handle
      .shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error("error during shutdown", err);
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("capture service failed to start:", err);
  process.exit(1);
});
