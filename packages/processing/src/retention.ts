import { readdir, rm, stat } from "node:fs/promises";
import {
  audioDir,
  readManifest,
  readStatus,
} from "@discord-agent/shared";
import type { Logger } from "./ports.js";

/**
 * Audio retention (DECISIONS open-question #5): raw per-speaker audio is purged
 * after `retentionDays`; transcripts and summaries are kept indefinitely.
 *
 * Only calls that have reached `delivered` are eligible — their text artifacts
 * are safely persisted, and a not-yet-processed call still needs its audio. Age
 * is measured from the call's `endedAt` (fallback `startedAt`). Pure w.r.t. the
 * clock: the caller passes `now`, so this is deterministic under test.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PurgeOptions {
  logger?: Logger;
}

/**
 * Delete the `audio/` directory of every eligible expired call under `baseDir`.
 * Returns the callIds whose audio was purged, sorted. A retentionDays < 0
 * disables purging entirely.
 */
export async function purgeExpiredAudio(
  baseDir: string,
  retentionDays: number,
  now: Date,
  options: PurgeOptions = {},
): Promise<string[]> {
  if (retentionDays < 0) return [];

  let callIds: string[];
  try {
    callIds = (await readdir(baseDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const cutoff = now.getTime() - retentionDays * MS_PER_DAY;
  const purged: string[] = [];

  for (const callId of callIds) {
    try {
      const status = await readStatus(baseDir, callId);
      if (status.status !== "delivered") continue;

      const manifest = await readManifest(baseDir, callId);
      const reference = manifest.endedAt ?? manifest.startedAt;
      if (Date.parse(reference) > cutoff) continue;

      const dir = audioDir(baseDir, callId);
      if (!(await pathExists(dir))) continue;

      await rm(dir, { recursive: true, force: true });
      purged.push(callId);
      options.logger?.info(`Purged audio for call ${callId} (retention).`);
    } catch (err) {
      options.logger?.warn(
        `Retention: skipping call ${callId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return purged.sort();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
