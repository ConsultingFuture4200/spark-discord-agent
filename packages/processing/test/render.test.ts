import type { CallSummary } from "@discord-agent/shared";
import { describe, expect, it } from "vitest";
import { renderSummaryMarkdown, splitForDiscord } from "../src/render.js";

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
