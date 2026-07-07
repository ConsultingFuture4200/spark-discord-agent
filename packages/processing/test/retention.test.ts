import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  audioDir,
  callDir,
  createCallManifest,
  ensureCallDir,
  speakerTrackPath,
  transcriptPath,
  videoPath,
  writeManifest,
  writeStatus,
  type CallStatus,
  type VideoDescriptor,
} from "@discord-agent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIMECODED_TRANSCRIPT_FILENAME } from "../src/render.js";
import { purgeExpiredAudio, purgeExpiredVideo } from "../src/retention.js";

const NOW = new Date("2026-07-05T00:00:00.000Z");
const OLD = "2026-06-01T00:00:00.000Z"; // > 7 days before NOW
const RECENT = "2026-07-04T00:00:00.000Z"; // < 7 days before NOW

async function seedCall(
  base: string,
  callId: string,
  endedAt: string,
  status: CallStatus,
  video?: VideoDescriptor,
): Promise<void> {
  await ensureCallDir(base, callId);
  await writeManifest(
    base,
    createCallManifest({
      callId,
      guildId: "g1",
      channelId: "c1",
      startedAt: endedAt,
      endedAt,
      tracks: [
        { userId: "u1", displayName: "Ada", path: "audio/u1.pcm", startOffsetMs: 0 },
      ],
      ...(video ? { video } : {}),
    }),
  );
  await writeStatus(base, callId, status, endedAt);
  await writeFile(speakerTrackPath(base, callId, "u1"), "PCMDATA");
  await writeFile(transcriptPath(base, callId), "{}");
  if (video) {
    await writeFile(videoPath(base, callId), "MP4DATA");
    await writeFile(
      path.join(callDir(base, callId), TIMECODED_TRANSCRIPT_FILENAME),
      "# Timecoded transcript",
    );
  }
}

const VIDEO: VideoDescriptor = {
  path: "video.mp4",
  startedAt: "2026-07-05T00:00:00.000Z",
  startOffsetMs: 0,
};

function timecodedPath(base: string, callId: string): string {
  return path.join(callDir(base, callId), TIMECODED_TRANSCRIPT_FILENAME);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("purgeExpiredAudio", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "retention-test-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("purges audio for a delivered call past retention, keeping text artifacts", async () => {
    await seedCall(base, "old", OLD, "delivered");
    const purged = await purgeExpiredAudio(base, 7, NOW);

    expect(purged).toEqual(["old"]);
    expect(await exists(audioDir(base, "old"))).toBe(false);
    // Transcript is retained.
    expect(await exists(transcriptPath(base, "old"))).toBe(true);
  });

  it("keeps audio for a delivered call still within retention", async () => {
    await seedCall(base, "recent", RECENT, "delivered");
    const purged = await purgeExpiredAudio(base, 7, NOW);

    expect(purged).toEqual([]);
    expect(await exists(audioDir(base, "recent"))).toBe(true);
  });

  it("does not purge calls that are not yet delivered", async () => {
    await seedCall(base, "pending", OLD, "ready-to-process");
    const purged = await purgeExpiredAudio(base, 7, NOW);

    expect(purged).toEqual([]);
    expect(await exists(audioDir(base, "pending"))).toBe(true);
  });

  it("disables purging when retentionDays is negative", async () => {
    await seedCall(base, "old", OLD, "delivered");
    const purged = await purgeExpiredAudio(base, -1, NOW);

    expect(purged).toEqual([]);
    expect(await exists(audioDir(base, "old"))).toBe(true);
  });

  it("returns an empty list when the base dir does not exist", async () => {
    const purged = await purgeExpiredAudio(
      path.join(base, "nope"),
      7,
      NOW,
    );
    expect(purged).toEqual([]);
  });
});

describe("purgeExpiredVideo", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "retention-video-test-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("purges video.mp4 past retention, keeping transcript + timecoded artifacts", async () => {
    await seedCall(base, "old", OLD, "delivered", VIDEO);
    const purged = await purgeExpiredVideo(base, 7, NOW);

    expect(purged).toEqual(["old"]);
    expect(await exists(videoPath(base, "old"))).toBe(false);
    // Both text artifacts are retained.
    expect(await exists(transcriptPath(base, "old"))).toBe(true);
    expect(await exists(timecodedPath(base, "old"))).toBe(true);
    // Audio is untouched by the video sweep.
    expect(await exists(audioDir(base, "old"))).toBe(true);
  });

  it("keeps video.mp4 still within its retention window", async () => {
    await seedCall(base, "recent", RECENT, "delivered", VIDEO);
    const purged = await purgeExpiredVideo(base, 7, NOW);

    expect(purged).toEqual([]);
    expect(await exists(videoPath(base, "recent"))).toBe(true);
  });

  it("honors a shorter video window than audio (video expires, audio kept)", async () => {
    // Call ended 2 days ago: past a 1-day video window, within a 7-day audio one.
    const twoDaysAgo = "2026-07-03T00:00:00.000Z";
    await seedCall(base, "mid", twoDaysAgo, "delivered", VIDEO);

    const videoPurged = await purgeExpiredVideo(base, 1, NOW);
    const audioPurged = await purgeExpiredAudio(base, 7, NOW);

    expect(videoPurged).toEqual(["mid"]);
    expect(audioPurged).toEqual([]);
    expect(await exists(videoPath(base, "mid"))).toBe(false);
    expect(await exists(audioDir(base, "mid"))).toBe(true);
  });

  it("does not purge video for calls that are not yet delivered", async () => {
    await seedCall(base, "pending", OLD, "ready-to-process", VIDEO);
    const purged = await purgeExpiredVideo(base, 7, NOW);

    expect(purged).toEqual([]);
    expect(await exists(videoPath(base, "pending"))).toBe(true);
  });

  it("disables purging when retentionDays is negative", async () => {
    await seedCall(base, "old", OLD, "delivered", VIDEO);
    const purged = await purgeExpiredVideo(base, -1, NOW);

    expect(purged).toEqual([]);
    expect(await exists(videoPath(base, "old"))).toBe(true);
  });

  it("is a no-op for a call that captured no video", async () => {
    await seedCall(base, "audioonly", OLD, "delivered");
    const purged = await purgeExpiredVideo(base, 7, NOW);

    expect(purged).toEqual([]);
    expect(await exists(audioDir(base, "audioonly"))).toBe(true);
  });
});
