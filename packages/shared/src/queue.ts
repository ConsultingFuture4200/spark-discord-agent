import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  CallManifestSchema,
  CallStatusFileSchema,
  type CallManifest,
  type CallStatus,
  type CallStatusFile,
} from "./manifest.js";

/**
 * Filesystem-queue helpers.
 *
 * The queue between capture and processing is just the storage directory: one
 * subdirectory per call, each holding `manifest.json`, `status.json`, the
 * per-speaker audio tracks, and later the transcript/summary. Processing
 * discovers work by listing calls whose status is `ready-to-process`.
 *
 * Path builders are pure string functions (base dir in → path out). The IO
 * helpers wrap them with validated read/write. No clock reads here: callers
 * pass `updatedAt` as an ISO string.
 */

export const MANIFEST_FILENAME = "manifest.json";
export const STATUS_FILENAME = "status.json";
export const TRANSCRIPT_FILENAME = "transcript.json";
export const SUMMARY_FILENAME = "summary.json";
export const SUMMARY_MARKDOWN_FILENAME = "summary.md";
export const VIDEO_FILENAME = "video.mp4";
export const AUDIO_DIRNAME = "audio";

// --- Pure path builders -----------------------------------------------------

/** Directory for a single call: `<baseDir>/<callId>`. */
export function callDir(baseDir: string, callId: string): string {
  return path.join(baseDir, callId);
}

export function manifestPath(baseDir: string, callId: string): string {
  return path.join(callDir(baseDir, callId), MANIFEST_FILENAME);
}

export function statusPath(baseDir: string, callId: string): string {
  return path.join(callDir(baseDir, callId), STATUS_FILENAME);
}

export function transcriptPath(baseDir: string, callId: string): string {
  return path.join(callDir(baseDir, callId), TRANSCRIPT_FILENAME);
}

export function summaryPath(baseDir: string, callId: string): string {
  return path.join(callDir(baseDir, callId), SUMMARY_FILENAME);
}

export function summaryMarkdownPath(baseDir: string, callId: string): string {
  return path.join(callDir(baseDir, callId), SUMMARY_MARKDOWN_FILENAME);
}

/** Path for the call's aligned video recording: `<callDir>/video.mp4`. */
export function videoPath(baseDir: string, callId: string): string {
  return path.join(callDir(baseDir, callId), VIDEO_FILENAME);
}

/** Directory holding the per-speaker audio tracks for a call. */
export function audioDir(baseDir: string, callId: string): string {
  return path.join(callDir(baseDir, callId), AUDIO_DIRNAME);
}

/** Path for one speaker's audio track file. */
export function speakerTrackPath(
  baseDir: string,
  callId: string,
  userId: string,
  extension = "pcm",
): string {
  const ext = extension.startsWith(".") ? extension.slice(1) : extension;
  return path.join(audioDir(baseDir, callId), `${userId}.${ext}`);
}

// --- IO helpers -------------------------------------------------------------

/** Ensure a call's directory (and its audio subdir) exist. */
export async function ensureCallDir(baseDir: string, callId: string): Promise<void> {
  await mkdir(audioDir(baseDir, callId), { recursive: true });
}

/**
 * Write a file atomically: write to a sibling temp file, then `rename` over the
 * target. `rename` is atomic on a local filesystem, so a crash mid-write never
 * leaves a half-written `status.json`/`manifest.json` for the watcher or the
 * reclaim scan to trip over.
 */
async function writeFileAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, target);
}

/** Write and validate the manifest for a call. */
export async function writeManifest(
  baseDir: string,
  manifest: CallManifest,
): Promise<void> {
  const validated = CallManifestSchema.parse(manifest);
  await ensureCallDir(baseDir, validated.callId);
  await writeFileAtomic(
    manifestPath(baseDir, validated.callId),
    JSON.stringify(validated, null, 2),
  );
}

/** Read and validate a call's manifest. */
export async function readManifest(
  baseDir: string,
  callId: string,
): Promise<CallManifest> {
  const raw = await readFile(manifestPath(baseDir, callId), "utf8");
  return CallManifestSchema.parse(JSON.parse(raw));
}

/**
 * Write `status.json`. Caller supplies `updatedAt` (ISO string), optionally an
 * `error` message (for the `failed` state), the `threadId` a summary was posted
 * to, and the `emailedAt` timestamp the summary email was sent. `threadId` and
 * `emailedAt` are carried forward across a reclaim so each delivery leg stays
 * independently idempotent. The write is atomic (temp file + rename).
 */
export async function writeStatus(
  baseDir: string,
  callId: string,
  status: CallStatus,
  updatedAt: string,
  error?: string,
  threadId?: string,
  emailedAt?: string,
): Promise<void> {
  const doc: CallStatusFile = CallStatusFileSchema.parse({
    callId,
    status,
    updatedAt,
    ...(error !== undefined ? { error } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(emailedAt !== undefined ? { emailedAt } : {}),
  });
  await ensureCallDir(baseDir, callId);
  await writeFileAtomic(statusPath(baseDir, callId), JSON.stringify(doc, null, 2));
}

/** Read and validate a call's `status.json`. */
export async function readStatus(
  baseDir: string,
  callId: string,
): Promise<CallStatusFile> {
  const raw = await readFile(statusPath(baseDir, callId), "utf8");
  return CallStatusFileSchema.parse(JSON.parse(raw));
}

/**
 * List call IDs currently in `ready-to-process`, sorted ascending (FIFO by
 * callId). Calls whose status file is missing or unreadable are skipped, so a
 * half-written call dir never crashes the poller.
 */
export async function listReadyCalls(baseDir: string): Promise<string[]> {
  const ready: string[] = [];
  for (const callId of await listCallDirs(baseDir)) {
    try {
      const status = await readStatus(baseDir, callId);
      if (status.status === "ready-to-process") ready.push(callId);
    } catch {
      // Missing/invalid status.json => not claimable yet; skip.
    }
  }
  return ready.sort();
}

/** List the immediate call subdirectories of `baseDir` (empty if it is absent). */
async function listCallDirs(baseDir: string): Promise<string[]> {
  try {
    return (await readdir(baseDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** In-progress states a crashed processing run can strand a call in. */
const IN_PROGRESS_STATUSES: readonly CallStatus[] = ["transcribing", "summarizing"];

/**
 * Crash recovery for the processing side (NFR-2/NFR-3): re-enqueue calls stuck
 * in an in-progress state (`transcribing`/`summarizing`) whose `status.json` has
 * not been touched for longer than `staleMs` — the sign of a processing run that
 * died mid-pipeline. The status is reset to `ready-to-process`, preserving any
 * `threadId` and `emailedAt` so each delivery leg stays independently
 * idempotent across the re-run. Returns the reclaimed IDs.
 */
export async function reclaimStaleCalls(
  baseDir: string,
  staleMs: number,
  nowIso: string,
): Promise<string[]> {
  const nowMs = Date.parse(nowIso);
  const reclaimed: string[] = [];
  for (const callId of await listCallDirs(baseDir)) {
    try {
      const status = await readStatus(baseDir, callId);
      if (!IN_PROGRESS_STATUSES.includes(status.status)) continue;
      if (nowMs - Date.parse(status.updatedAt) < staleMs) continue;
      await writeStatus(
        baseDir,
        callId,
        "ready-to-process",
        nowIso,
        undefined,
        status.threadId,
        status.emailedAt,
      );
      reclaimed.push(callId);
    } catch {
      // Missing/invalid status.json => nothing to reclaim; skip.
    }
  }
  return reclaimed.sort();
}

/**
 * Crash recovery for the capture side: on startup no recorder is live, so any
 * call still marked `recording` was stranded by a crash/restart mid-call. It has
 * no manifest (the manifest is written only on a clean stop), so it cannot be
 * processed — mark it `failed` so it never sits in a non-terminal state forever.
 * Returns the reclaimed IDs.
 */
export async function reclaimStrandedRecordings(
  baseDir: string,
  nowIso: string,
): Promise<string[]> {
  const reclaimed: string[] = [];
  for (const callId of await listCallDirs(baseDir)) {
    try {
      const status = await readStatus(baseDir, callId);
      if (status.status !== "recording") continue;
      await writeStatus(
        baseDir,
        callId,
        "failed",
        nowIso,
        "recording stranded by a capture-service restart",
      );
      reclaimed.push(callId);
    } catch {
      // Missing/invalid status.json => nothing to reclaim; skip.
    }
  }
  return reclaimed.sort();
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
