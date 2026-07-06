import type { SpeakerTrack } from "@discord-agent/shared";
import { describe, expect, it } from "vitest";
import { labelTrackSegments, mergeTrackTranscripts } from "../src/merge.js";
import type { RawSegment } from "../src/ports.js";

const track = (
  displayName: string,
  startOffsetMs: number,
  userId = displayName.toLowerCase(),
): SpeakerTrack => ({
  userId,
  displayName,
  path: `audio/${userId}.pcm`,
  startOffsetMs,
});

describe("labelTrackSegments", () => {
  it("shifts timestamps by the track offset and labels with the display name", () => {
    const raw: RawSegment[] = [
      { startMs: 0, endMs: 500, text: "hello" },
      { startMs: 600, endMs: 900, text: "again" },
    ];
    expect(labelTrackSegments(track("Ada", 1000), raw)).toEqual([
      { speaker: "Ada", startMs: 1000, endMs: 1500, text: "hello" },
      { speaker: "Ada", startMs: 1600, endMs: 1900, text: "again" },
    ]);
  });

  it("drops blank/whitespace-only segments (Whisper silence)", () => {
    const raw: RawSegment[] = [
      { startMs: 0, endMs: 100, text: "   " },
      { startMs: 100, endMs: 200, text: "" },
      { startMs: 200, endMs: 300, text: "real" },
    ];
    expect(labelTrackSegments(track("Ben", 0), raw)).toEqual([
      { speaker: "Ben", startMs: 200, endMs: 300, text: "real" },
    ]);
  });

  it("returns an empty array for a track with no segments", () => {
    expect(labelTrackSegments(track("Cy", 500), [])).toEqual([]);
  });
});

describe("mergeTrackTranscripts", () => {
  it("interleaves multiple speakers chronologically using each track's offset", () => {
    const ada: RawSegment[] = [
      { startMs: 0, endMs: 1000, text: "A1" },
      { startMs: 4000, endMs: 5000, text: "A2" },
    ];
    // Ben's audio started 2s into the call, so his 0ms is 2000ms on the timeline.
    const ben: RawSegment[] = [{ startMs: 0, endMs: 1000, text: "B1" }];

    const merged = mergeTrackTranscripts("call-1", [
      { track: track("Ada", 0), segments: ada },
      { track: track("Ben", 2000), segments: ben },
    ]);

    expect(merged.callId).toBe("call-1");
    expect(merged.segments.map((s) => [s.speaker, s.startMs, s.text])).toEqual([
      ["Ada", 0, "A1"],
      ["Ben", 2000, "B1"],
      ["Ada", 4000, "A2"],
    ]);
  });

  it("breaks startMs ties by endMs, then speaker", () => {
    const merged = mergeTrackTranscripts("call-2", [
      { track: track("Ada", 0), segments: [{ startMs: 0, endMs: 500, text: "A" }] },
      { track: track("Ben", 0), segments: [{ startMs: 0, endMs: 300, text: "B" }] },
    ]);
    // Same startMs → shorter endMs (Ben, 300) sorts before Ada (500).
    expect(merged.segments.map((s) => s.speaker)).toEqual(["Ben", "Ada"]);
  });

  it("produces an empty transcript when every track is silent", () => {
    const merged = mergeTrackTranscripts("call-3", [
      { track: track("Ada", 0), segments: [{ startMs: 0, endMs: 10, text: " " }] },
    ]);
    expect(merged.segments).toEqual([]);
  });
});
