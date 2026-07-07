import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCallManifest } from "../src/manifest.js";
import {
  audioDir,
  callDir,
  listReadyCalls,
  manifestPath,
  readManifest,
  readStatus,
  reclaimStaleCalls,
  reclaimStrandedRecordings,
  speakerTrackPath,
  statusPath,
  summaryPath,
  transcriptPath,
  videoPath,
  writeManifest,
  writeStatus,
} from "../src/queue.js";

const ISO = "2026-07-05T10:00:00.000Z";

describe("queue path builders (pure)", () => {
  const base = "/data/calls";

  it("builds the call dir and file paths under it", () => {
    expect(callDir(base, "call-1")).toBe(path.join(base, "call-1"));
    expect(manifestPath(base, "call-1")).toBe(
      path.join(base, "call-1", "manifest.json"),
    );
    expect(statusPath(base, "call-1")).toBe(
      path.join(base, "call-1", "status.json"),
    );
    expect(transcriptPath(base, "call-1")).toBe(
      path.join(base, "call-1", "transcript.json"),
    );
    expect(summaryPath(base, "call-1")).toBe(
      path.join(base, "call-1", "summary.json"),
    );
    expect(audioDir(base, "call-1")).toBe(path.join(base, "call-1", "audio"));
    expect(videoPath(base, "call-1")).toBe(
      path.join(base, "call-1", "video.mp4"),
    );
  });

  it("builds a speaker track path with a default and custom extension", () => {
    expect(speakerTrackPath(base, "call-1", "user-9")).toBe(
      path.join(base, "call-1", "audio", "user-9.pcm"),
    );
    expect(speakerTrackPath(base, "call-1", "user-9", ".opus")).toBe(
      path.join(base, "call-1", "audio", "user-9.opus"),
    );
  });
});

describe("queue IO helpers", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "queue-test-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("writes and reads back a manifest", async () => {
    const manifest = createCallManifest({
      callId: "call-1",
      guildId: "g1",
      channelId: "c1",
      startedAt: ISO,
      tracks: [{ userId: "u1", displayName: "Ada", path: "audio/u1.pcm", startOffsetMs: 0 }],
    });
    await writeManifest(base, manifest);
    const read = await readManifest(base, "call-1");
    expect(read).toEqual(manifest);
  });

  it("writes and reads a status document", async () => {
    await writeStatus(base, "call-1", "recording", ISO);
    const status = await readStatus(base, "call-1");
    expect(status.status).toBe("recording");
    expect(status.callId).toBe("call-1");
    expect(status.error).toBeUndefined();
  });

  it("records an error message on a failed status", async () => {
    await writeStatus(base, "call-2", "failed", ISO, "whisper crashed");
    const status = await readStatus(base, "call-2");
    expect(status.status).toBe("failed");
    expect(status.error).toBe("whisper crashed");
  });

  it("lists only calls in ready-to-process, sorted", async () => {
    await writeStatus(base, "call-b", "ready-to-process", ISO);
    await writeStatus(base, "call-a", "ready-to-process", ISO);
    await writeStatus(base, "call-c", "recording", ISO);
    await writeStatus(base, "call-d", "delivered", ISO);
    const ready = await listReadyCalls(base);
    expect(ready).toEqual(["call-a", "call-b"]);
  });

  it("returns an empty list when the base dir does not exist", async () => {
    const ready = await listReadyCalls(path.join(base, "does-not-exist"));
    expect(ready).toEqual([]);
  });

  it("skips a call dir with no status.json without throwing", async () => {
    // Create a call dir + manifest but no status file.
    await writeManifest(
      base,
      createCallManifest({
        callId: "half-written",
        guildId: "g1",
        channelId: "c1",
        startedAt: ISO,
      }),
    );
    await writeStatus(base, "good", "ready-to-process", ISO);
    const ready = await listReadyCalls(base);
    expect(ready).toEqual(["good"]);
  });
});

describe("crash-recovery reclamation", () => {
  let base: string;
  const OLD = "2026-07-05T10:00:00.000Z";
  const NOW = "2026-07-05T10:30:00.000Z"; // 30 min after OLD
  const STALE_MS = 15 * 60 * 1000;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "reclaim-test-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("re-enqueues stale in-progress calls, preserving threadId, and leaves fresh/terminal alone", async () => {
    // Stale transcribing (OLD) — reclaim, carrying its threadId forward.
    await writeStatus(base, "stale", "transcribing", OLD, undefined, "thread-7");
    // Fresh summarizing (1 min old) — still within lease, leave it.
    await writeStatus(base, "fresh", "summarizing", "2026-07-05T10:29:00.000Z");
    // Terminal delivered — never reclaimed.
    await writeStatus(base, "done", "delivered", OLD);

    const reclaimed = await reclaimStaleCalls(base, STALE_MS, NOW);

    expect(reclaimed).toEqual(["stale"]);
    const stale = await readStatus(base, "stale");
    expect(stale.status).toBe("ready-to-process");
    expect(stale.threadId).toBe("thread-7");
    expect((await readStatus(base, "fresh")).status).toBe("summarizing");
    expect((await readStatus(base, "done")).status).toBe("delivered");
  });

  it("fails stranded recordings on capture restart, leaving other states alone", async () => {
    await writeStatus(base, "stranded", "recording", OLD);
    await writeStatus(base, "queued", "ready-to-process", OLD);

    const reclaimed = await reclaimStrandedRecordings(base, NOW);

    expect(reclaimed).toEqual(["stranded"]);
    const stranded = await readStatus(base, "stranded");
    expect(stranded.status).toBe("failed");
    expect(stranded.error).toContain("stranded");
    expect((await readStatus(base, "queued")).status).toBe("ready-to-process");
  });
});
