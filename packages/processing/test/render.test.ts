import type {
  CallSummary,
  MergedTranscript,
  VideoDescriptor,
} from "@discord-agent/shared";
import { describe, expect, it } from "vitest";
import {
  renderSummaryMarkdown,
  renderTimecodedTranscript,
  splitForDiscord,
} from "../src/render.js";

const summary: CallSummary = {
  fullCall: {
    overview: "We aligned on the plan.",
    keyTopics: ["scope", "timeline"],
    decisions: ["ship in Q3"],
    openQuestions: ["who owns QA?"],
    actionItems: [{ owner: "Ada", item: "write the spec" }],
  },
  perSpeaker: [
    {
      displayName: "Ada",
      contributions: ["drove the agenda"],
      positionsConcerns: ["timeline is tight"],
      actionItems: [{ owner: "Ada", item: "write the spec" }],
    },
  ],
};

describe("renderSummaryMarkdown", () => {
  it("renders sections, action items with owners, and per-speaker headings", () => {
    const md = renderSummaryMarkdown(summary);
    expect(md).toContain("## Overview");
    expect(md).toContain("We aligned on the plan.");
    expect(md).toContain("- **Ada:** write the spec");
    expect(md).toContain("### Ada");
    expect(md).toContain("**Positions / concerns**");
  });

  it("adds the video note when a video descriptor is present", () => {
    const video: VideoDescriptor = {
      path: "video.mp4",
      startedAt: "2026-07-07T00:00:03.000Z",
      startOffsetMs: 3000,
    };
    const md = renderSummaryMarkdown(summary, video);
    expect(md).toContain("📹 Video recorded (aligned) — video.mp4");
  });

  it("omits the video note (byte-for-byte) when no video is present", () => {
    expect(renderSummaryMarkdown(summary)).toBe(renderSummaryMarkdown(summary, undefined));
    expect(renderSummaryMarkdown(summary)).not.toContain("📹");
  });

  it("renders _None._ for empty lists", () => {
    const empty: CallSummary = {
      fullCall: {
        overview: "",
        keyTopics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      perSpeaker: [],
    };
    const md = renderSummaryMarkdown(empty);
    expect(md).toContain("_None._");
    expect(md).toContain("_No per-speaker breakdown._");
  });
});

describe("renderTimecodedTranscript", () => {
  const transcript: MergedTranscript = {
    callId: "call-1",
    segments: [
      { speaker: "Ada", startMs: 0, endMs: 1000, text: "hello" },
      { speaker: "Ben", startMs: 10_000, endMs: 12_000, text: "hi there" },
      { speaker: "Ada", startMs: 125_000, endMs: 126_000, text: "later" },
    ],
  };

  it("prefixes each segment with its [MM:SS] video timecode (offset applied)", () => {
    // OBS started 3s after the call → startOffsetMs = +3000.
    const video: VideoDescriptor = {
      path: "video.mp4",
      startedAt: "2026-07-07T00:00:03.000Z",
      startOffsetMs: 3000,
    };
    const md = renderTimecodedTranscript(transcript, video);
    // 0ms segment predates the video → clamped to 00:00.
    expect(md).toContain("[00:00] Ada: hello");
    // 10000 − 3000 = 7000ms → 00:07.
    expect(md).toContain("[00:07] Ben: hi there");
    // 125000 − 3000 = 122000ms → 02:02.
    expect(md).toContain("[02:02] Ada: later");
    expect(md).toContain("Video: video.mp4");
  });

  it("handles a negative offset (OBS started before the call)", () => {
    // OBS started 2s before the call → every segment shifts later in the video.
    const video: VideoDescriptor = {
      path: "video.mp4",
      startedAt: "2026-07-06T23:59:58.000Z",
      startOffsetMs: -2000,
    };
    const md = renderTimecodedTranscript(transcript, video);
    // 0 − (−2000) = 2000ms → 00:02.
    expect(md).toContain("[00:02] Ada: hello");
    // 10000 + 2000 = 12000ms → 00:12.
    expect(md).toContain("[00:12] Ben: hi there");
  });
});

describe("splitForDiscord", () => {
  it("keeps a short message as a single chunk", () => {
    expect(splitForDiscord("hello world", 1900)).toEqual(["hello world"]);
  });

  it("splits on line boundaries and keeps every chunk within the limit", () => {
    const md = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitForDiscord(md, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    // No content lost (join with newline reconstructs the original lines).
    expect(chunks.join("\n").replace(/\n+/g, "\n")).toContain("line 49");
  });

  it("hard-splits a single line longer than the limit", () => {
    const chunks = splitForDiscord("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});
