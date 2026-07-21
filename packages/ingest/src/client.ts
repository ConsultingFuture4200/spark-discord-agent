/**
 * Thin HTTP client for the gBrain v2 wire contract (PRD D7). Only the routes
 * ingest and /ask need: POST /ingest/event, POST /query, GET /health.
 * `fetchImpl` is injectable so tests point it at a stub server.
 */

/**
 * What gBrain's EventIngestor answers on POST /ingest/event: created memory
 * ids + edge count for graph-building events, `tombstone_pending` for
 * tombstone requests.
 */
export interface IngestEventResult {
  ok: boolean;
  /** Ids of memories created by this event (reused anchors are not listed). */
  ids?: number[];
  edges?: number;
  warnings?: string[];
  tombstone_pending?: boolean;
  /** Set by the outbox when gBrain was unreachable and the event was spooled. */
  queued?: boolean;
}

/** Anything the emitter can post ingest events through (client or outbox). */
export interface IngestEventSink {
  postEvent(event: Record<string, unknown>): Promise<IngestEventResult>;
}

/** A non-2xx gBrain response, with the HTTP status for retry/park decisions. */
export class GbrainRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type QueryMode = "vector" | "fused" | "anchored";

export interface QueryOptions {
  k?: number;
  region?: string;
  mode?: QueryMode;
  anchorId?: number;
}

export interface QueryResponse {
  snippets: string[];
  sources: string[];
  /** TriDB honesty probes — present on fused/anchored responses only. */
  graph_censored?: boolean;
  termination_reason?: string;
}

export interface GbrainClientOptions {
  /** e.g. "http://127.0.0.1:8770" (no trailing slash needed). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class GbrainClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GbrainClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** POST a normalized ingest event; gBrain builds the nodes + edges. */
  async postEvent(event: Record<string, unknown>): Promise<IngestEventResult> {
    return (await this.post("/ingest/event", event)) as IngestEventResult;
  }

  /** Recall. Defaults to gBrain's own default mode (fused) when unset. */
  async query(query: string, options: QueryOptions = {}): Promise<QueryResponse> {
    const body = await this.post("/query", {
      query,
      ...(options.k !== undefined ? { k: options.k } : {}),
      ...(options.region !== undefined ? { region: options.region } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.anchorId !== undefined ? { anchor_id: options.anchorId } : {}),
    });
    return body as QueryResponse;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(route: string, payload: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GbrainRequestError(
        `gBrain ${route} failed: ${res.status} ${text}`.trim(),
        res.status,
      );
    }
    return res.json();
  }
}
