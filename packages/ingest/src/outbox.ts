import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GbrainRequestError,
  type IngestEventResult,
  type IngestEventSink,
} from "./client.js";

/**
 * Durable event outbox: closes the gap between "accepted from Discord" and
 * "durably queued in gBrain". gBrain's own disk queue only protects a write
 * that has already arrived; while gBrain is restarting or unreachable, a
 * fire-and-forget POST would drop the event forever.
 *
 * Spool-first: every event is persisted to its own JSON file BEFORE the POST
 * is attempted, and the file is removed only after gBrain accepts the event.
 * Files are named so lexicographic order == FIFO order and are drained
 * strictly in that order (a spooled event blocks later ones), so replies,
 * attachments, and summaries always arrive after the events they reference.
 * Replay is safe: gBrain's ingest dedupes on canonical source refs, so
 * re-posting an event that was accepted right before a crash is a no-op.
 *
 * Failure handling:
 * - transport errors / 5xx: keep the file, retry with exponential backoff;
 * - 4xx (except 408/429): the event itself is rejected — park it as
 *   `.rejected` for inspection so one bad event can never wedge the queue.
 */

export interface OutboxOptions {
  /** First retry delay after a failed drain; doubles up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 60_000;

/** True for statuses that mean "this event will never be accepted". */
function isPermanentRejection(err: unknown): boolean {
  return (
    err instanceof GbrainRequestError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

export class EventOutbox implements IngestEventSink {
  private seq = 0;
  /** Serializes submits and retry drains — FIFO order is the contract. */
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private delay: number;
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly client: IngestEventSink,
    private readonly opts: OutboxOptions = {},
  ) {
    this.delay = opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** Create the spool dir; schedule a drain of any files left by a previous run. */
  async init(): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const pending = await this.list();
    if (pending.length > 0) {
      this.opts.logger?.info(
        `ingest outbox: ${pending.length} spooled event(s) from a previous run`,
      );
      this.enqueueDrain();
    }
    return pending.length;
  }

  /** Stop retrying (the spool stays on disk for the next run). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Spool the event durably, then drain the queue up to and including it.
   * Resolves with gBrain's result when the event was delivered now, or with
   * `{ ok: true, queued: true }` when gBrain is unreachable and the event
   * stays spooled for the retry loop.
   */
  async postEvent(event: Record<string, unknown>): Promise<IngestEventResult> {
    const name = `${String(Date.now()).padStart(14, "0")}-${String(this.seq++).padStart(8, "0")}.json`;
    await writeFile(join(this.dir, name), JSON.stringify(event), "utf8");
    const p = this.chain.then(() => this.drain(name));
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    const result = await p;
    return result ?? { ok: true, queued: true };
  }

  private async list(): Promise<string[]> {
    const entries = await readdir(this.dir);
    return entries.filter((n) => n.endsWith(".json")).sort();
  }

  /**
   * Post pending files in FIFO order. Returns the result for `upTo` when it
   * was delivered in this pass, undefined otherwise. On a transient failure
   * the pass stops (order preserved) and a backoff retry is scheduled.
   */
  private async drain(upTo?: string): Promise<IngestEventResult | undefined> {
    let resultForUpTo: IngestEventResult | undefined;
    for (const file of await this.list()) {
      const path = join(this.dir, file);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      } catch {
        this.opts.logger?.warn(`ingest outbox: unreadable spool file ${file} — parked`);
        await rename(path, `${path}.rejected`).catch(() => {});
        continue;
      }
      try {
        const result = await this.client.postEvent(event);
        await unlink(path);
        this.delay = this.opts.retryMs ?? DEFAULT_RETRY_MS; // healthy again
        if (file === upTo) resultForUpTo = result;
      } catch (err) {
        if (isPermanentRejection(err)) {
          this.opts.logger?.warn(
            `ingest outbox: gBrain rejected ${file} (${String(
              err instanceof Error ? err.message : err,
            )}) — parked as .rejected`,
          );
          await rename(path, `${path}.rejected`).catch(() => {});
          continue;
        }
        this.opts.logger?.warn(
          `ingest outbox: gBrain unreachable at ${file} — ${String(
            err instanceof Error ? err.message : err,
          )}; retrying in ${this.delay}ms`,
        );
        this.scheduleRetry();
        return resultForUpTo;
      }
    }
    return resultForUpTo;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer !== undefined) return;
    const delay = this.delay;
    this.delay = Math.min(delay * 2, this.opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueueDrain();
    }, delay);
    // never keep the host process alive just to retry
    this.timer.unref?.();
  }

  private enqueueDrain(): void {
    const p = this.chain.then(() => this.drain());
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
  }
}
