/**
 * Thin HTTP client for the gBrain v2 wire contract (PRD D7). Only the routes
 * ingest and /ask need: POST /memory, POST /edge, POST /query, GET /health.
 * `fetchImpl` is injectable so tests point it at a stub server.
 */

export interface MemoryInput {
  text: string;
  kind?: string;
  region?: string;
  source?: string;
  /** Memory id this one supersedes (append-only edit handling, PRD D6). */
  supersedes?: number;
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

  /** Store a memory node; returns its dense memory id. */
  async storeMemory(input: MemoryInput): Promise<number> {
    const body = await this.post("/memory", input);
    const id = (body as { id?: unknown }).id;
    if (!Number.isInteger(id)) {
      throw new Error(`gBrain /memory returned no integer id: ${JSON.stringify(body)}`);
    }
    return id as number;
  }

  /** Create a typed directed edge between two stored memories. */
  async createEdge(src: number, dst: number, rel: string): Promise<void> {
    await this.post("/edge", { src, dst, rel });
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
      throw new Error(`gBrain ${route} failed: ${res.status} ${text}`.trim());
    }
    return res.json();
  }
}
