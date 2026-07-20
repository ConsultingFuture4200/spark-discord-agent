import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ask, honestyFooter, renderAskReply } from "../src/ask.js";
import { GbrainClient } from "../src/client.js";
import { startStubGbrain, type StubGbrain } from "./stubGbrain.js";

describe("renderAskReply", () => {
  it("renders ranked snippets with sources and the honesty footer", () => {
    const reply = renderAskReply("what did we decide about TriDB?", {
      snippets: ["Adopt TriDB as the backing store.", "Schema bootstrap at 768-d."],
      sources: ["discord://call/call-1#decision-0", "gbrain://memory/12"],
      graph_censored: false,
      termination_reason: "term_cond",
    });

    expect(reply).toContain("**Q:** what did we decide about TriDB?");
    expect(reply).toContain("**1.** Adopt TriDB as the backing store.");
    expect(reply).toContain("discord://call/call-1#decision-0");
    expect(reply).toContain("**2.** Schema bootstrap at 768-d.");
    expect(reply).toContain("mode=fused | graph_censored=false | termination=term_cond");
  });

  it("says so when nothing matched", () => {
    const reply = renderAskReply("anything?", { snippets: [], sources: [] });

    expect(reply).toContain("No memories matched.");
  });

  it("stays under Discord's message limit for oversized snippets", () => {
    const reply = renderAskReply("q", {
      snippets: Array.from({ length: 10 }, () => "x".repeat(1000)),
      sources: Array.from({ length: 10 }, (_, i) => `s${i}`),
    });

    expect(reply.length).toBeLessThanOrEqual(1900);
  });

  it("omits absent honesty probes from the footer (vector-shaped response)", () => {
    expect(honestyFooter({ snippets: [], sources: [] })).toBe("-# mode=fused");
  });
});

describe("ask (against stub gBrain)", () => {
  let stub: StubGbrain;
  beforeEach(async () => {
    stub = await startStubGbrain();
  });
  afterEach(async () => {
    await stub.close();
  });

  it("queries mode=fused and renders the response", async () => {
    stub.setQueryResponse({
      snippets: ["Fused answer."],
      sources: ["discord://message/g/c/m"],
      graph_censored: true,
      termination_reason: "max_hops",
    });
    const client = new GbrainClient({ baseUrl: stub.baseUrl });

    const reply = await ask(client, "who said what?", { k: 3 });

    expect(stub.to("/query")[0]?.body).toMatchObject({
      query: "who said what?",
      mode: "fused",
      k: 3,
    });
    expect(reply).toContain("Fused answer.");
    expect(reply).toContain("graph_censored=true");
    expect(reply).toContain("termination=max_hops");
  });
});
