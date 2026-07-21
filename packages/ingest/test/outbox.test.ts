import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GbrainClient } from "../src/client.js";
import { EventOutbox } from "../src/outbox.js";
import { startStubGbrain, type StubGbrain } from "./stubGbrain.js";

const memberEvent = (id: string): Record<string, unknown> => ({
  type: "member",
  member_id: id,
  display_name: `Member ${id}`,
});

async function spoolFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe("EventOutbox", () => {
  let stub: StubGbrain;
  let dir: string;
  let outbox: EventOutbox;

  beforeEach(async () => {
    stub = await startStubGbrain();
    dir = await mkdtemp(path.join(tmpdir(), "ingest-outbox-"));
    outbox = new EventOutbox(dir, new GbrainClient({ baseUrl: stub.baseUrl }), {
      retryMs: 20,
      maxRetryMs: 100,
    });
    await outbox.init();
  });

  afterEach(async () => {
    outbox.stop();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("delivers immediately when gBrain is up and removes the spool file", async () => {
    const result = await outbox.postEvent(memberEvent("u1"));

    expect(result.queued).toBeUndefined();
    expect(result.ids).toHaveLength(1);
    expect(stub.to("/ingest/event")).toHaveLength(1);
    expect(await spoolFiles(dir)).toEqual([]);
  });

  it("spools on outage and keeps the event on disk instead of dropping it", async () => {
    stub.setIngestFailure(503);

    const result = await outbox.postEvent(memberEvent("u1"));

    expect(result).toEqual({ ok: true, queued: true });
    expect(await spoolFiles(dir)).toHaveLength(1);
  });

  it("drains spooled events in FIFO order once gBrain recovers", async () => {
    stub.setIngestFailure(503);
    await outbox.postEvent(memberEvent("u1"));
    await outbox.postEvent(memberEvent("u2"));
    expect(await spoolFiles(dir)).toHaveLength(2);

    stub.setIngestFailure(null);
    await vi.waitFor(async () => {
      expect(await spoolFiles(dir)).toEqual([]);
    });

    const delivered = stub
      .to("/ingest/event")
      .filter((r) => (r.body as { member_id?: string }).member_id !== undefined)
      .map((r) => (r.body as { member_id: string }).member_id);
    // failed attempts always target the queue head (u1); the successful
    // replay delivers u1 then u2, preserving FIFO order
    expect(delivered.slice(-2)).toEqual(["u1", "u2"]);
    expect(delivered.slice(0, -2).every((id) => id === "u1")).toBe(true);
  });

  it("drains spool files left behind by a previous run on init", async () => {
    await writeFile(
      path.join(dir, "00000000000001-00000000.json"),
      JSON.stringify(memberEvent("leftover")),
      "utf8",
    );

    const restarted = new EventOutbox(dir, new GbrainClient({ baseUrl: stub.baseUrl }), {
      retryMs: 20,
    });
    expect(await restarted.init()).toBe(1);
    await vi.waitFor(async () => {
      expect(await spoolFiles(dir)).toEqual([]);
    });
    restarted.stop();
    expect(stub.to("/ingest/event")).toHaveLength(1);
  });

  it("parks permanently rejected events as .rejected so they never wedge the queue", async () => {
    stub.setIngestFailure(400);
    await outbox.postEvent(memberEvent("bad"));
    stub.setIngestFailure(null);

    const result = await outbox.postEvent(memberEvent("good"));

    expect(result.queued).toBeUndefined();
    const files = await spoolFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.rejected$/);
  });
});
