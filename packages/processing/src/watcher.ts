import { listReadyCalls, reclaimStaleCalls } from "@discord-agent/shared";
import { processCall, type PipelineDeps, type PipelineResult } from "./pipeline.js";
import { purgeExpiredAudio, purgeExpiredVideo } from "./retention.js";

/**
 * The filesystem-queue watcher (PRD §7): polls the storage base dir for calls in
 * `ready-to-process` and runs each through the pipeline, then applies audio
 * retention. Single-host, single-process, sequential — no external broker, and
 * one call at a time keeps GPU pressure predictable on the Spark.
 */

export interface WatcherDeps extends PipelineDeps {
  /** Days to retain raw audio before purge; < 0 disables purging. */
  retentionDays: number;
  /** Days to retain the aligned `video.mp4` before purge; < 0 disables purging. */
  videoRetentionDays: number;
  /**
   * A call left `transcribing`/`summarizing` for longer than this (ms) is
   * assumed to be from a crashed run and re-enqueued (NFR-2/NFR-3). Must exceed
   * the worst-case processing time so a slow-but-live call is never stolen.
   */
  staleLeaseMs: number;
}

export interface WatcherOptions {
  /** Poll interval in ms. */
  intervalMs: number;
}

/**
 * Run one poll cycle: reclaim any call stranded in an in-progress state by a
 * crashed run, process every ready call, then purge expired audio.
 */
export async function pollOnce(deps: WatcherDeps): Promise<PipelineResult[]> {
  const reclaimed = await reclaimStaleCalls(
    deps.baseDir,
    deps.staleLeaseMs,
    deps.now().toISOString(),
  );
  if (reclaimed.length > 0) {
    deps.logger?.warn(
      `Reclaimed ${reclaimed.length} stale in-progress call(s): ${reclaimed.join(", ")}`,
    );
  }

  const ready = await listReadyCalls(deps.baseDir);
  const results: PipelineResult[] = [];
  for (const callId of ready) {
    results.push(await processCall(callId, deps));
  }
  const purgeOptions = deps.logger ? { logger: deps.logger } : {};
  await purgeExpiredAudio(deps.baseDir, deps.retentionDays, deps.now(), purgeOptions);
  await purgeExpiredVideo(
    deps.baseDir,
    deps.videoRetentionDays,
    deps.now(),
    purgeOptions,
  );
  return results;
}

/**
 * Start the polling loop. Returns a stop function that halts scheduling and
 * waits for any in-flight cycle to finish (graceful shutdown, NFR-2).
 */
export function startWatcher(
  deps: WatcherDeps,
  options: WatcherOptions,
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let activeCycle: Promise<unknown> = Promise.resolve();

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    activeCycle = pollOnce(deps).catch((err: unknown) =>
      deps.logger?.error(
        `Watcher cycle error: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    await activeCycle;
    if (!stopped) timer = setTimeout(() => void cycle(), options.intervalMs);
  };

  deps.logger?.info(
    `Watcher started (base=${deps.baseDir}, interval=${options.intervalMs}ms).`,
  );
  void cycle();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await activeCycle;
    deps.logger?.info("Watcher stopped.");
  };
}
