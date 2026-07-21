import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stub gBrain HTTP server for fixture-driven tests: records every request
 * and answers the wire contract minimally — `/ingest/event` allocates one
 * dense id per graph-building event (tombstone requests get the ledger
 * shape), `/query` returns a configurable canned response.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

export interface StubGbrain {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Requests to one route, in arrival order. */
  to(route: string): RecordedRequest[];
  /** Override the canned `/query` response. */
  setQueryResponse(response: unknown): void;
  /** Make `/ingest/event` answer this HTTP status (null restores success). */
  setIngestFailure(status: number | null): void;
  close(): Promise<void>;
}

export async function startStubGbrain(): Promise<StubGbrain> {
  const requests: RecordedRequest[] = [];
  let nextId = 0;
  let queryResponse: unknown = { snippets: [], sources: [] };
  let ingestFailure: number | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const url = req.url ?? "/";
      requests.push({ method: req.method ?? "GET", url, body });

      const respond = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.method === "GET" && url === "/health") return respond(200, { ok: true });
      if (req.method === "POST" && url === "/ingest/event") {
        if (ingestFailure !== null) {
          return respond(ingestFailure, { error: `stubbed failure ${ingestFailure}` });
        }
        if (body.type === "tombstone-request") {
          return respond(200, {
            ok: true,
            tombstone_pending: true,
            ledger: "/data/pending-tombstones.jsonl",
          });
        }
        return respond(200, { ok: true, ids: [nextId++], edges: 1, warnings: [] });
      }
      if (req.method === "POST" && url === "/query") return respond(200, queryResponse);
      respond(404, { error: `no route for ${req.method} ${url}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    to: (route) => requests.filter((r) => r.url === route),
    setQueryResponse: (response) => {
      queryResponse = response;
    },
    setIngestFailure: (status) => {
      ingestFailure = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
