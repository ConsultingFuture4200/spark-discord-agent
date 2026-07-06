import type { LogLevel } from "@discord-agent/shared";
import type { Logger } from "./ports.js";

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Minimal leveled console logger. Messages below `level` are dropped. */
export function createLogger(level: LogLevel): Logger {
  const threshold = RANK[level];
  const at = (l: LogLevel) => RANK[l] >= threshold;
  return {
    debug: (m, ...a) => at("debug") && console.debug(`[debug] ${m}`, ...a),
    info: (m, ...a) => at("info") && console.info(`[info] ${m}`, ...a),
    warn: (m, ...a) => at("warn") && console.warn(`[warn] ${m}`, ...a),
    error: (m, ...a) => at("error") && console.error(`[error] ${m}`, ...a),
  };
}
