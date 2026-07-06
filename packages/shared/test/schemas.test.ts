import { describe, expect, it } from "vitest";
import {
  CallManifestSchema,
  CallStatusSchema,
  createCallManifest,
} from "../src/manifest.js";
import {
  mergeTranscripts,
  renderTranscriptText,
  SegmentSchema,
} from "../src/transcript.js";
import { CallSummarySchema, parseCallSummary } from "../src/summary.js";

const ISO = "2026-07-05T10:00:00.000Z";

describe("CallStatus / manifest schemas", () => {
  it("accepts every valid status value", () => {
    for (const s of [
      "recording",
      "ready-to-process",
      "transcribing",
      "summarizing",
      "delivered",
      "failed",
    ]) {
      expect(CallStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => CallStatusSchema.parse("paused")).toThrow();
  });

  it("createCallManifest builds a valid manifest with defaults", () => {
    const m = createCallManifest({
      callId: "call-1",
      guildId: "g1",
      channelId: "c1",
      startedAt: ISO,
    });
    expect(m.endedAt).toBeNull();
    expect(m.tracks).toEqual([]);
    expect(() => CallManifestSchema.parse(m)).not.toThrow();
  });

  it("createCallManifest carries speaker tracks and endedAt", () => {
    const m = createCallManifest({
      callId: "call-2",
      guildId: "g1",
      channelId: "c1",
      startedAt: ISO,
      endedAt: "2026-07-05T10:30:00.000Z",
      tracks: [
        { userId: "u1", displayName: "Ada", path: "audio/u1.pcm", startOffsetMs: 0 },
        { userId: "u2", displayName: "Grace", path: "audio/u2.pcm", startOffsetMs: 1200 },
      ],
    });
    expect(m.tracks).toHaveLength(2);
    expect(m.tracks[1]?.startOffsetMs).toBe(1200);
  });

  it("rejects a manifest with a non-ISO startedAt", () => {
    expect(() =>
      createCallManifest({
        callId: "call-3",
        guildId: "g1",
        channelId: "c1",
        startedAt: "yesterday",
      }),
    ).toThrow();
  });

  it("rejects a speaker track with a negative offset", () => {
    expect(() =>
      createCallManifest({
        callId: "call-4",
        guildId: "g1",
        channelId: "c1",
        startedAt: ISO,
        tracks: [{ userId: "u1", displayName: "Ada", path: "p", startOffsetMs: -1 }],
      }),
    ).toThrow();
  });
});

describe("transcript schemas + merge", () => {
  it("rejects a segment whose endMs precedes startMs", () => {
    expect(() =>
      SegmentSchema.parse({ speaker: "Ada", startMs: 500, endMs: 100, text: "hi" }),
    ).toThrow();
  });

  it("merges per-speaker segments into chronological order", () => {
    const ada = [
      { speaker: "Ada", startMs: 0, endMs: 1000, text: "hello" },
      { speaker: "Ada", startMs: 3000, endMs: 3500, text: "agreed" },
    ];
    const grace = [{ speaker: "Grace", startMs: 1200, endMs: 2000, text: "hi there" }];
    const merged = mergeTranscripts("call-1", [ada, grace]);
    expect(merged.segments.map((s) => s.text)).toEqual([
      "hello",
      "hi there",
      "agreed",
    ]);
    expect(renderTranscriptText(merged)).toBe(
      "Ada: hello\nGrace: hi there\nAda: agreed",
    );
  });

  it("breaks startMs ties deterministically by endMs then speaker", () => {
    const merged = mergeTranscripts("call-2", [
      [{ speaker: "Zed", startMs: 100, endMs: 200, text: "z" }],
      [{ speaker: "Ada", startMs: 100, endMs: 200, text: "a" }],
    ]);
    expect(merged.segments.map((s) => s.speaker)).toEqual(["Ada", "Zed"]);
  });
});

describe("summary contract", () => {
  const valid = {
    fullCall: {
      overview: "We discussed the launch.",
      keyTopics: ["launch", "pricing"],
      decisions: ["Ship Friday"],
      openQuestions: ["Who owns QA?"],
      actionItems: [{ owner: "Ada", item: "Draft the release notes" }],
    },
    perSpeaker: [
      {
        displayName: "Ada",
        contributions: ["Proposed the launch date"],
        positionsConcerns: ["Worried about QA coverage"],
        actionItems: [{ owner: "Ada", item: "Draft the release notes" }],
      },
    ],
  };

  it("accepts a well-formed dual summary", () => {
    const result = parseCallSummary(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.fullCall.keyTopics).toContain("pricing");
      expect(result.summary.perSpeaker[0]?.displayName).toBe("Ada");
    }
  });

  it("parseCallSummary reports an error result for malformed output", () => {
    const result = parseCallSummary({ fullCall: { overview: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects an action item missing an owner", () => {
    const bad = structuredClone(valid) as unknown as {
      fullCall: { actionItems: { item: string }[] };
    };
    bad.fullCall.actionItems = [{ item: "no owner" }];
    expect(() => CallSummarySchema.parse(bad)).toThrow();
  });
});
