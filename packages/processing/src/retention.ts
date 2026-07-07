import { readdir, rm, stat } from "node:fs/promises";
import {
  audioDir,
  readManifest,
  readStatus,
  videoPath,
} from "@discord-agent/shared";
import type { Logger } from "./ports.js";

/**
 * Media retention (DECISIONS open-question #5; M7 for video): raw per-speaker
 * audio is purged after `audioRetentionDays` and the aligned `video.mp4` after
 * `videoRetentionDays`; transcripts and summaries (including the timecoded
 * transcript) are kept indefinitely.
 *
 * Only calls that have reached `delivered` are eligible — their text artifacts
 * are safely persisted, and a not-yet-processed call still needs its media. Age
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
export function purgeExpiredAudio(
  baseDir: string,
  retentionDays: number,
  now: Date,
  options: PurgeOptions = {},
): Promise<string[]> {
  return purgeExpired(baseDir, retentionDays, now, audioDir, "audio", options);
}

/**
 * Delete the aligned `video.mp4` of every eligible expired call under `baseDir`
 * (M7 — video is large + sensitive, so it may expire sooner than audio). Returns
 * the callIds whose video was purged, sorted. A retentionDays < 0 disables it.
 * The timecoded transcript and every other text artifact are kept.
 */
export function purgeExpiredVideo(
  baseDir: string,
  retentionDays: number,
  now: Date,
  options: PurgeOptions = {},
): Promise<string[]> {
  return purgeExpired(baseDir, retentionDays, now, videoPath, "video", options);
}

/**
 * Shared sweep: for every `delivered` call whose reference timestamp is older
 * than `retentionDays`, delete the target resolved by `resolveTarget` (an audio
 * dir or the video file — `rm` with `force` handles both). `label` names the
 * kind in log lines.
 */
async function purgeExpired(
  baseDir: string,
  retentionDays: number,
  now: Date,
  resolveTarget: (baseDir: string, callId: string) => string,
  label: string,
  options: PurgeOptions,
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

      const target = resolveTarget(baseDir, callId);
      if (!(await pathExists(target))) continue;

      await rm(target, { recursive: true, force: true });
      purged.push(callId);
      options.logger?.info(`Purged ${label} for call ${callId} (retention).`);
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
