import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  audioDir,
  createCallManifest,
  ensureCallDir,
  speakerTrackPath,
  transcriptPath,
  writeManifest,
  writeStatus,
  type CallStatus,
} from "@discord-agent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeExpiredAudio } from "../src/retention.js";

const NOW = new Date("2026-07-05T00:00:00.000Z");
const OLD = "2026-06-01T00:00:00.000Z"; // > 7 days before NOW
const RECENT = "2026-07-04T00:00:00.000Z"; // < 7 days before NOW

async function seedCall(
  base: string,
  callId: string,
  endedAt: string,
  status: CallStatus,
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
    }),
  );
  await writeStatus(base, callId, status, endedAt);
  await writeFile(speakerTrackPath(base, callId, "u1"), "PCMDATA");
  await writeFile(transcriptPath(base, callId), "{}");
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
