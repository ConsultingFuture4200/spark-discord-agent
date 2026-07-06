import { mergeTranscripts, type Segment } from "@discord-agent/shared";
import { describe, expect, it } from "vitest";
import type { ChatClient, ChatRequest } from "../src/ports.js";
import {
  CHUNK_TOKEN_BUDGET,
  SINGLE_PASS_TOKEN_THRESHOLD,
  chooseSummaryStrategy,
  chunkSegments,
  estimateTokens,
  groupBySpeaker,
  summarizeCall,
} from "../src/summarize.js";

/** A scripted chat client whose handler decides the response per request. */
class ScriptedChat implements ChatClient {
  readonly calls: ChatRequest[] = [];
  constructor(private readonly handler: (req: ChatRequest, n: number) => string) {}
  async chat(request: ChatRequest): Promise<string> {
    const n = this.calls.length;
    this.calls.push(request);
    return this.handler(request, n);
  }
}

const seg = (speaker: string, startMs: number, text: string): Segment => ({
  speaker,
  startMs,
  endMs: startMs + 100,
  text,
});

const VALID_SUMMARY = {
  fullCall: {
    overview: "We discussed the roadmap.",
    keyTopics: ["roadmap"],
    decisions: ["ship v1"],
    openQuestions: ["hosting?"],
    actionItems: [{ owner: "Ada", item: "draft spec" }],
  },
  perSpeaker: [
    {
      displayName: "Ada",
      contributions: ["proposed the plan"],
      positionsConcerns: ["worried about time"],
      actionItems: [{ owner: "Ada", item: "draft spec" }],
    },
  ],
};

describe("estimateTokens / chooseSummaryStrategy", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("picks single-pass at/under the threshold and map-reduce above it", () => {
    const short = "x".repeat(SINGLE_PASS_TOKEN_THRESHOLD * 4);
    const long = "x".repeat(SINGLE_PASS_TOKEN_THRESHOLD * 4 + 4);
    expect(chooseSummaryStrategy(short)).toBe("single");
    expect(chooseSummaryStrategy(long)).toBe("map-reduce");
  });
});

describe("chunkSegments", () => {
  it("packs segments greedily under the token budget without splitting a segment", () => {
    // Each line "Ada: hello" → 10 chars → 3 est tokens. Budget 6 → 2 per chunk.
    const segs = [
      seg("Ada", 0, "hello"),
      seg("Ada", 100, "hello"),
      seg("Ada", 200, "hello"),
    ];
    const chunks = chunkSegments(segs, 6);
    expect(chunks.map((c) => c.length)).toEqual([2, 1]);
  });

  it("gives an oversized single segment its own chunk", () => {
    const segs = [seg("Ada", 0, "x".repeat(400)), seg("Ada", 100, "hi")];
    const chunks = chunkSegments(segs, 10);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
  });

  it("uses the default budget when none is given", () => {
    const chunks = chunkSegments([seg("Ada", 0, "hi")]);
    expect(estimateTokens("Ada: hi")).toBeLessThan(CHUNK_TOKEN_BUDGET);
    expect(chunks).toHaveLength(1);
  });
});

describe("groupBySpeaker", () => {
  it("groups lines by speaker in first-appearance order", () => {
    const segs = [
      seg("Ada", 0, "a1"),
      seg("Ben", 100, "b1"),
      seg("Ada", 200, "a2"),
    ];
    expect(groupBySpeaker(segs)).toEqual([
      { displayName: "Ada", text: "a1\na2" },
      { displayName: "Ben", text: "b1" },
    ]);
  });
});

describe("summarizeCall — single pass with JSON-validation retry", () => {
  const transcript = mergeTranscripts("call-1", [[seg("Ada", 0, "hi there")]]);

  it("returns the summary when the first response is valid", async () => {
    const chat = new ScriptedChat(() => JSON.stringify(VALID_SUMMARY));
    const res = await summarizeCall(chat, "batch", transcript);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.fullCall.overview).toContain("roadmap");
    expect(chat.calls).toHaveLength(1);
  });

  it("retries once when the first response fails schema validation, then succeeds", async () => {
    const chat = new ScriptedChat((_req, n) =>
      n === 0 ? JSON.stringify({ fullCall: {} }) : JSON.stringify(VALID_SUMMARY),
    );
    const res = await summarizeCall(chat, "batch", transcript);
    expect(res.ok).toBe(true);
    expect(chat.calls).toHaveLength(2);
    // The repair turn must feed the prior (bad) answer plus a corrective message.
    const repair = chat.calls[1]!;
    expect(repair.messages.at(-1)?.content).toContain("previous response was invalid");
  });

  it("retries once when the first response is not valid JSON at all", async () => {
    const chat = new ScriptedChat((_req, n) =>
      n === 0 ? "not json" : JSON.stringify(VALID_SUMMARY),
    );
    const res = await summarizeCall(chat, "batch", transcript);
    expect(res.ok).toBe(true);
    expect(chat.calls).toHaveLength(2);
  });

  it("fails after the retry when both responses are invalid", async () => {
    const chat = new ScriptedChat(() => JSON.stringify({ fullCall: {} }));
    const res = await summarizeCall(chat, "batch", transcript);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
    expect(chat.calls).toHaveLength(2);
  });
});

describe("summarizeCall — map-reduce for long transcripts", () => {
  const speakerObj = (name: string) => ({
    displayName: name,
    contributions: [name],
    positionsConcerns: [],
    actionItems: [],
  });

  it("runs partial → reduce → one call per speaker and assembles a valid summary", async () => {
    const segs = [
      seg("Ada", 0, "a".repeat(60)),
      seg("Ben", 200, "b".repeat(60)),
      seg("Ada", 400, "c".repeat(60)),
    ];
    const transcript = mergeTranscripts("call-long", [segs]);

    const stages: string[] = [];
    const chat = new ScriptedChat((req) => {
      const system = req.messages[0]!.content;
      if (system.includes("summarizing one portion")) {
        stages.push("partial");
        return "notes for a chunk";
      }
      if (system.includes("whole-call summary")) {
        stages.push("reduce");
        return JSON.stringify(VALID_SUMMARY.fullCall);
      }
      if (system.includes("summarizing a single participant")) {
        stages.push("speaker");
        // The system prompt names the speaker being summarized.
        const name = system.includes('"Ada"') ? "Ada" : "Ben";
        return JSON.stringify(speakerObj(name));
      }
      throw new Error(`unexpected stage: ${system.slice(0, 60)}`);
    });

    // Force map-reduce with a tiny threshold; small chunk budget → multiple chunks.
    const res = await summarizeCall(chat, "batch", transcript, {
      thresholdTokens: 0,
      chunkTokens: 20,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.perSpeaker.map((s) => s.displayName)).toEqual(["Ada", "Ben"]);
      expect(res.value.fullCall.overview).toBe(VALID_SUMMARY.fullCall.overview);
    }
    expect(stages.filter((s) => s === "partial").length).toBeGreaterThan(1);
    expect(stages).toContain("reduce");
    // One independent per-speaker call each for Ada and Ben (LIOTTA-4).
    expect(stages.filter((s) => s === "speaker")).toHaveLength(2);
  });

  it("folds partials hierarchically so no reduce call exceeds the reduce budget", async () => {
    // Many chunks → many partials whose flat join would overflow the reduce
    // budget. Distinct speakers keep every per-speaker call a single small call
    // so the only unbounded path under test is the whole-call reduce.
    const segs = Array.from({ length: 20 }, (_v, i) =>
      seg(`S${i}`, i * 100, `point ${i} ${"z".repeat(100)}`),
    );
    const transcript = mergeTranscripts("call-huge", [segs]);

    const REDUCE_BUDGET = 300;
    let sawIntermediateReduce = false;
    const chat = new ScriptedChat((req) => {
      const system = req.messages[0]!.content;
      if (system.includes("summarizing one portion")) return "detail ".repeat(60);
      if (system.includes("condensing several ordered partial notes")) {
        sawIntermediateReduce = true;
        return "sum ".repeat(20);
      }
      if (system.includes("whole-call summary")) {
        return JSON.stringify(VALID_SUMMARY.fullCall);
      }
      if (system.includes("summarizing a single participant")) {
        const name = system.match(/participant, "([^"]+)"/)?.[1] ?? "S0";
        return JSON.stringify(speakerObj(name));
      }
      throw new Error(`unexpected stage: ${system.slice(0, 60)}`);
    });

    const res = await summarizeCall(chat, "batch", transcript, {
      thresholdTokens: 0,
      chunkTokens: 60,
      reduceTokens: REDUCE_BUDGET,
    });

    expect(res.ok).toBe(true);
    // The flat join of the partials was over budget, so a hierarchical fold ran.
    expect(sawIntermediateReduce).toBe(true);
    // No single chat call's payload exceeds the reduce budget (with slack for the
    // fixed prompt prefix). A flat reduce would have been multiples over.
    for (const call of chat.calls) {
      const payload = call.messages.at(-1)!.content;
      expect(estimateTokens(payload)).toBeLessThanOrEqual(REDUCE_BUDGET + 30);
    }
  });

  it("chunk-then-reduces a single speaker whose lines exceed the speaker budget", async () => {
    // One dominant speaker with many short segments: over the per-speaker budget.
    const segs = Array.from({ length: 6 }, (_v, i) => seg("Ada", i * 100, `line ${i}`));
    const transcript = mergeTranscripts("call-solo", [segs]);

    const SPEAKER_BUDGET = 10;
    let sawReduceSpeaker = false;
    const chat = new ScriptedChat((req) => {
      const system = req.messages[0]!.content;
      if (system.includes("summarizing one portion")) return "chunk notes";
      if (system.includes("whole-call summary")) {
        return JSON.stringify(VALID_SUMMARY.fullCall);
      }
      if (system.includes("about a single participant")) {
        sawReduceSpeaker = true;
        // Every reduce input line is a partial-notes string, never the raw
        // transcript, so this call's context is bounded.
        return JSON.stringify({
          displayName: "Ada",
          contributions: ["c"],
          positionsConcerns: [],
          actionItems: [],
        });
      }
      // A non-chunked single-speaker call would land here — it must NOT for Ada.
      if (system.includes("summarizing a single participant")) {
        throw new Error("speaker over budget must be chunked, not sent whole");
      }
      throw new Error(`unexpected stage: ${system.slice(0, 60)}`);
    });

    const res = await summarizeCall(chat, "batch", transcript, {
      thresholdTokens: 0,
      // Keep the full-call pass a single chunk so all chunking here is per-speaker.
      chunkTokens: 100_000,
      speakerChunkTokens: SPEAKER_BUDGET,
    });

    expect(res.ok).toBe(true);
    expect(sawReduceSpeaker).toBe(true);
    // Per-speaker map chunks send the speaker's raw lines (no "Name:" prefix),
    // unlike the full-call map which sends prefixed transcript lines. Each such
    // chunk stays within the per-speaker budget, so no single call ever sees the
    // speaker's whole (potentially huge) transcript.
    const speakerMapCalls = chat.calls.filter(
      (c) =>
        c.messages[0]!.content.includes("summarizing one portion") &&
        !c.messages[1]!.content.includes(": "),
    );
    expect(speakerMapCalls.length).toBeGreaterThan(1);
    for (const call of speakerMapCalls) {
      expect(estimateTokens(call.messages[1]!.content)).toBeLessThanOrEqual(
        SPEAKER_BUDGET + estimateTokens("line 0"),
      );
    }
  });
});
