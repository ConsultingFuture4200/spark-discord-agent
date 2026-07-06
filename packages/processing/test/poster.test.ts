import { describe, expect, it, vi } from "vitest";
import { DiscordRestPoster } from "../src/poster.js";

/** Minimal Response-like stub for the injected fetch. */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface SeenCall {
  method: string;
  url: string;
}

/** Thread name the poster derives from the callId (must match poster.ts). */
const THREAD_NAME = "Call summary — call-1";

function makeFetch(activeThreads: { id: string; name: string }[]): {
  fetchImpl: typeof fetch;
  calls: SeenCall[];
} {
  const calls: SeenCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u });
    if (u.endsWith("/threads/active")) return jsonResponse({ threads: activeThreads });
    if (method === "POST" && u.endsWith("/threads")) {
      return jsonResponse({ id: "new-thread" });
    }
    return jsonResponse({}); // message posts
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const createdThreads = (calls: SeenCall[]): SeenCall[] =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/threads"));

describe("DiscordRestPoster — idempotent thread creation", () => {
  it("creates a new thread when none with the name exists", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const poster = new DiscordRestPoster({ token: "t", apiBase: "http://x/api", fetchImpl });

    const { threadId } = await poster.postSummary("chan-1", "call-1", "hello");

    expect(threadId).toBe("new-thread");
    expect(createdThreads(calls)).toHaveLength(1);
  });

  it("reuses an existing active thread with the same name and does not create a duplicate", async () => {
    // A prior run created the thread but crashed before persisting its id; the
    // thread is still present, so a second delivery run must reuse it.
    const { fetchImpl, calls } = makeFetch([{ id: "existing-thread", name: THREAD_NAME }]);
    const poster = new DiscordRestPoster({ token: "t", apiBase: "http://x/api", fetchImpl });

    const { threadId } = await poster.postSummary("chan-1", "call-1", "hello");

    expect(threadId).toBe("existing-thread");
    // No new thread was created — the create endpoint was never POSTed.
    expect(createdThreads(calls)).toHaveLength(0);
  });
});
