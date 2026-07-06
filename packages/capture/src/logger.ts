import type { LogLevel } from "@discord-agent/shared";

/**
 * Minimal leveled logger. Capture is latency-sensitive and always-on, so we
 * avoid a logging dependency and just gate `console` on the configured level.
 */

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(level: LogLevel, scope = "capture"): Logger {
  const threshold = ORDER[level];
  const emit =
    (lvl: LogLevel, sink: (...a: unknown[]) => void) =>
    (msg: string, ...args: unknown[]): void => {
      if (ORDER[lvl] < threshold) return;
      sink(`[${scope}] ${lvl}: ${msg}`, ...args);
    };

  return {
    debug: emit("debug", console.debug.bind(console)),
    info: emit("info", console.info.bind(console)),
    warn: emit("warn", console.warn.bind(console)),
    error: emit("error", console.error.bind(console)),
  };
}
