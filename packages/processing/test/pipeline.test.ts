import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  callDir,
  createCallManifest,
  readStatus,
  summaryMarkdownPath,
  summaryPath,
  transcriptPath,
  writeManifest,
  writeStatus,
  type CallSummary,
  type VideoDescriptor,
} from "@discord-agent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCall, type PipelineDeps } from "../src/pipeline.js";
import { TIMECODED_TRANSCRIPT_FILENAME } from "../src/render.js";
import type {
  ChatClient,
  Emailer,
  RawSegment,
  SttBackend,
  SummaryPoster,
} from "../src/ports.js";

const NOW = new Date("2026-07-05T12:00:00.000Z");

const VALID_SUMMARY: CallSummary = {
  fullCall: {
    overview: "Roadmap sync.",
    keyTopics: ["roadmap"],
    decisions: [],
    openQuestions: [],
    actionItems: [],
  },
  perSpeaker: [
    { displayName: "Ada", contributions: ["led"], positionsConcerns: [], actionItems: [] },
    { displayName: "Ben", contributions: ["listened"], positionsConcerns: [], actionItems: [] },
  ],
};

/** STT mock: returns one segment per track, keyed by the file's basename. */
class FakeStt implements SttBackend {
  readonly seen: string[] = [];
  constructor(private readonly byBasename: Record<string, RawSegment[]>) {}
  async transcribeTrack(audioPath: string): Promise<RawSegment[]> {
    this.seen.push(audioPath);
    return this.byBasename[path.basename(audioPath)] ?? [];
  }
}

class ThrowingStt implements SttBackend {
  async transcribeTrack(): Promise<RawSegment[]> {
    throw new Error("whisper crashed");
  }
}

class FakeChat implements ChatClient {
  async chat(): Promise<string> {
    return JSON.stringify(VALID_SUMMARY);
  }
}

class RecordingPoster implements SummaryPoster {
  readonly posts: { channelId: string; callId: string; markdown: string }[] = [];
  async postSummary(channelId: string, callId: string, markdown: string) {
    this.posts.push({ channelId, callId, markdown });
    return { threadId: "thread-99" };
  }
}

async function seedReadyCall(base: string, callId: string): Promise<void> {
  await writeManifest(
    base,
    createCallManifest({
      callId,
      guildId: "g1",
      channelId: "chan-7",
      startedAt: "2026-07-05T11:00:00.000Z",
      endedAt: "2026-07-05T11:30:00.000Z",
      tracks: [
        { userId: "u1", displayName: "Ada", path: "audio/u1.pcm", startOffsetMs: 0 },
        { userId: "u2", displayName: "Ben", path: "audio/u2.pcm", startOffsetMs: 5000 },
      ],
    }),
  );
  await writeStatus(base, callId, "ready-to-process", "2026-07-05T11:30:00.000Z");
}

function makeDeps(base: string, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    baseDir: base,
    stt: new FakeStt({
      "u1.pcm": [{ startMs: 0, endMs: 1000, text: "Hi from Ada" }],
      "u2.pcm": [{ startMs: 0, endMs: 1000, text: "Hi from Ben" }],
    }),
    chat: new FakeChat(),
    batchModel: "qwen2.5:32b",
    poster: new RecordingPoster(),
    now: () => NOW,
    ...overrides,
  };
}

describe("processCall — happy path", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "pipeline-test-"));
    await seedReadyCall(base, "call-1");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("transcribes, merges, summarizes, persists, posts, and marks delivered", async () => {
    const poster = new RecordingPoster();
    const deps = makeDeps(base, { poster });
    const result = await processCall("call-1", deps);

    expect(result.ok).toBe(true);

    const status = await readStatus(base, "call-1");
    expect(status.status).toBe("delivered");
    expect(status.updatedAt).toBe(NOW.toISOString());

    // Transcript is merged and speaker-labeled with real names, on the timeline.
    const transcript = JSON.parse(await readFile(transcriptPath(base, "call-1"), "utf8"));
    expect(transcript.callId).toBe("call-1");
    expect(transcript.segments.map((s: { speaker: string }) => s.speaker)).toEqual([
      "Ada",
      "Ben",
    ]);
    // Ben's track started at 5000ms offset.
    expect(transcript.segments[1].startMs).toBe(5000);

    // Summary JSON + markdown persisted.
    const summary = JSON.parse(await readFile(summaryPath(base, "call-1"), "utf8"));
    expect(summary.fullCall.overview).toBe("Roadmap sync.");
    const markdown = await readFile(summaryMarkdownPath(base, "call-1"), "utf8");
    expect(markdown).toContain("# Call summary");

    // Posted to the manifest's channel with the rendered markdown.
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]!.channelId).toBe("chan-7");
    expect(poster.posts[0]!.markdown).toBe(markdown);
  });

  it("emails the summary when an emailer is injected", async () => {
    const sendSummary = vi.fn<Emailer["sendSummary"]>().mockResolvedValue();
    const emailer: Emailer = { sendSummary };
    const result = await processCall("call-1", makeDeps(base, { emailer }));

    expect(result.ok).toBe(true);
    expect(sendSummary).toHaveBeenCalledOnce();
    expect(sendSummary.mock.calls[0]![0].subject).toContain("call-1");
  });
});

describe("processCall — video (M7)", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "pipeline-video-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const VIDEO: VideoDescriptor = {
    path: "video.mp4",
    startedAt: "2026-07-05T11:00:03.000Z",
    startOffsetMs: 3000,
  };

  async function seedWithVideo(callId: string, video?: VideoDescriptor): Promise<void> {
    await writeManifest(
      base,
      createCallManifest({
        callId,
        guildId: "g1",
        channelId: "chan-7",
        startedAt: "2026-07-05T11:00:00.000Z",
        endedAt: "2026-07-05T11:30:00.000Z",
        tracks: [
          { userId: "u1", displayName: "Ada", path: "audio/u1.pcm", startOffsetMs: 0 },
          { userId: "u2", displayName: "Ben", path: "audio/u2.pcm", startOffsetMs: 5000 },
        ],
        ...(video ? { video } : {}),
      }),
    );
    await writeStatus(base, callId, "ready-to-process", "2026-07-05T11:30:00.000Z");
  }

  it("writes a timecoded transcript and adds the summary note when video is present", async () => {
    await seedWithVideo("call-v", VIDEO);
    const poster = new RecordingPoster();
    const result = await processCall("call-v", makeDeps(base, { poster }));

    expect(result.ok).toBe(true);

    // Summary carries the one-line video note.
    const markdown = await readFile(summaryMarkdownPath(base, "call-v"), "utf8");
    expect(markdown).toContain("📹 Video recorded (aligned) — video.mp4");
    expect(poster.posts[0]!.markdown).toContain("📹 Video recorded (aligned)");

    // Timecoded transcript artifact is written; Ben's 5000ms segment maps to
    // 5000 − 3000 = 2000ms → [00:02] in the video.
    const timecoded = await readFile(
      path.join(callDir(base, "call-v"), TIMECODED_TRANSCRIPT_FILENAME),
      "utf8",
    );
    expect(timecoded).toContain("[00:00] Ada: Hi from Ada");
    expect(timecoded).toContain("[00:02] Ben: Hi from Ben");
  });

  it("writes no timecoded artifact and no note when video is absent", async () => {
    await seedWithVideo("call-nov");
    const result = await processCall("call-nov", makeDeps(base));

    expect(result.ok).toBe(true);
    const markdown = await readFile(summaryMarkdownPath(base, "call-nov"), "utf8");
    expect(markdown).not.toContain("📹");
    await expect(
      readFile(path.join(callDir(base, "call-nov"), TIMECODED_TRANSCRIPT_FILENAME), "utf8"),
    ).rejects.toThrow();
  });
});

describe("processCall — empty/silent call", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "pipeline-empty-"));
    await seedReadyCall(base, "call-silent");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("posts a no-speech notice and never calls the LLM on a zero-segment transcript", async () => {
    const chat = { chat: vi.fn(async () => "") } satisfies ChatClient;
    const poster = new RecordingPoster();
    // STT returns nothing for either track → merged transcript has 0 segments.
    const deps = makeDeps(base, {
      stt: new FakeStt({}),
      chat,
      poster,
    });

    const result = await processCall("call-silent", deps);

    expect(result.ok).toBe(true);
    expect(chat.chat).not.toHaveBeenCalled();
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]!.markdown).toContain("No speech");

    const status = await readStatus(base, "call-silent");
    expect(status.status).toBe("delivered");
    expect(status.threadId).toBe("thread-99");
  });
});

describe("processCall — delivery idempotency on reclaim", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "pipeline-idem-"));
    await seedReadyCall(base, "call-2");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("does not re-post or re-email a call whose both legs already completed", async () => {
    // First run delivers BOTH legs, recording threadId and emailedAt.
    const firstEmail = vi.fn<Emailer["sendSummary"]>().mockResolvedValue();
    await processCall("call-2", makeDeps(base, { emailer: { sendSummary: firstEmail } }));
    const delivered = await readStatus(base, "call-2");
    expect(delivered.threadId).toBe("thread-99");
    expect(delivered.emailedAt).toBeDefined();

    // Simulate a crash-recovery reclaim: reset to ready-to-process, carry both
    // the threadId and emailedAt forward (as reclaimStaleCalls does).
    await writeStatus(
      base,
      "call-2",
      "ready-to-process",
      NOW.toISOString(),
      undefined,
      delivered.threadId,
      delivered.emailedAt,
    );

    const poster = new RecordingPoster();
    const sendSummary = vi.fn<Emailer["sendSummary"]>().mockResolvedValue();
    const result = await processCall(
      "call-2",
      makeDeps(base, { poster, emailer: { sendSummary } }),
    );

    expect(result.ok).toBe(true);
    // Neither leg re-runs.
    expect(poster.posts).toHaveLength(0);
    expect(sendSummary).not.toHaveBeenCalled();
    expect((await readStatus(base, "call-2")).status).toBe("delivered");
  });

  it("preserves threadId across a second crash on a reclaimed run (FIX 1)", async () => {
    // A second crash during a reclaimed run must not erase the persisted
    // threadId via an intermediate writeStatus, or the next reclaim would
    // double-deliver. The poster/thread-create must fire exactly once overall.
    const poster = new RecordingPoster();

    // Run 1: deliver normally, persisting threadId.
    await processCall("call-2", makeDeps(base, { poster }));
    expect((await readStatus(base, "call-2")).threadId).toBe("thread-99");

    // Reclaim 1: reset to ready-to-process, carrying the persisted threadId.
    const s1 = await readStatus(base, "call-2");
    await writeStatus(
      base,
      "call-2",
      "ready-to-process",
      NOW.toISOString(),
      undefined,
      s1.threadId,
      s1.emailedAt,
    );

    // Run 2 (reclaimed): crash mid-transcribe.
    const r2 = await processCall(
      "call-2",
      makeDeps(base, { poster, stt: new ThrowingStt() }),
    );
    expect(r2.ok).toBe(false);
    // The "transcribing"/"failed" writes must NOT have erased the threadId.
    expect((await readStatus(base, "call-2")).threadId).toBe("thread-99");

    // Reclaim 2: reset again, carrying whatever threadId survived.
    const s2 = await readStatus(base, "call-2");
    await writeStatus(
      base,
      "call-2",
      "ready-to-process",
      NOW.toISOString(),
      undefined,
      s2.threadId,
      s2.emailedAt,
    );

    // Run 3 (reclaimed, healthy): must skip the post because threadId survived.
    const r3 = await processCall("call-2", makeDeps(base, { poster }));
    expect(r3.ok).toBe(true);

    // Exactly one thread-create across all three runs.
    expect(poster.posts).toHaveLength(1);
  });

  it("re-sends only the email when a reclaim already has a thread but no email (FIX 3)", async () => {
    // Simulate a crash after post + threadId persist but before the email:
    // status is reclaimed with a threadId but no emailedAt.
    await writeStatus(
      base,
      "call-2",
      "ready-to-process",
      NOW.toISOString(),
      undefined,
      "thread-99", // already posted
      undefined, // never emailed
    );

    const poster = new RecordingPoster();
    const sendSummary = vi.fn<Emailer["sendSummary"]>().mockResolvedValue();
    const result = await processCall(
      "call-2",
      makeDeps(base, { poster, emailer: { sendSummary } }),
    );

    expect(result.ok).toBe(true);
    // The post leg is skipped (thread already exists)...
    expect(poster.posts).toHaveLength(0);
    // ...but the unfinished email leg still runs, exactly once.
    expect(sendSummary).toHaveBeenCalledOnce();

    const status = await readStatus(base, "call-2");
    expect(status.status).toBe("delivered");
    expect(status.threadId).toBe("thread-99");
    expect(status.emailedAt).toBeDefined();
  });
});

describe("processCall — gBrain call ingest (best-effort)", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "pipeline-ingest-"));
    await seedReadyCall(base, "call-g");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("passes the manifest, transcript, and summary to the ingest hook after delivery", async () => {
    const ingestCall = vi.fn(async () => {});
    const result = await processCall(
      "call-g",
      makeDeps(base, { callIngest: { ingestCall } }),
    );

    expect(result.ok).toBe(true);
    expect(ingestCall).toHaveBeenCalledOnce();
    const input = ingestCall.mock.calls[0]![0] as unknown as {
      manifest: { callId: string; channelId: string };
      transcript: { segments: unknown[] };
      summary: CallSummary;
    };
    expect(input.manifest.callId).toBe("call-g");
    expect(input.manifest.channelId).toBe("chan-7");
    expect(input.transcript.segments).toHaveLength(2);
    expect(input.summary.fullCall.overview).toBe("Roadmap sync.");
  });

  it("still delivers the call when ingest throws", async () => {
    const ingestCall = vi.fn(async () => {
      throw new Error("gbrain unreachable");
    });
    const result = await processCall(
      "call-g",
      makeDeps(base, { callIngest: { ingestCall } }),
    );

    expect(result.ok).toBe(true);
    expect((await readStatus(base, "call-g")).status).toBe("delivered");
  });

  it("does not ingest a failed call", async () => {
    const ingestCall = vi.fn(async () => {});
    const result = await processCall(
      "call-g",
      makeDeps(base, { stt: new ThrowingStt(), callIngest: { ingestCall } }),
    );

    expect(result.ok).toBe(false);
    expect(ingestCall).not.toHaveBeenCalled();
  });

  it("does not ingest a silent call (no transcript, no summary)", async () => {
    const ingestCall = vi.fn(async () => {});
    const result = await processCall(
      "call-g",
      makeDeps(base, { stt: new FakeStt({}), callIngest: { ingestCall } }),
    );

    expect(result.ok).toBe(true);
    expect(ingestCall).not.toHaveBeenCalled();
  });
});

describe("processCall — failure handling", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "pipeline-fail-"));
    await seedReadyCall(base, "call-x");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("marks the call failed with the error when transcription throws", async () => {
    const result = await processCall(
      "call-x",
      makeDeps(base, { stt: new ThrowingStt() }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("whisper crashed");
    const status = await readStatus(base, "call-x");
    expect(status.status).toBe("failed");
    expect(status.error).toContain("whisper crashed");
  });
});
