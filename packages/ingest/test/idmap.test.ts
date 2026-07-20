import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdMap } from "../src/idmap.js";

describe("IdMap", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ingest-idmap-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists mappings across reopen", async () => {
    const file = path.join(dir, "idmap.json");
    const map = await IdMap.open(file);
    await map.set("discord://message/g/c/m1", 7);
    await map.set("discord://member/u1", 3);

    const reopened = await IdMap.open(file);

    expect(reopened.get("discord://message/g/c/m1")).toBe(7);
    expect(reopened.get("discord://member/u1")).toBe(3);
    expect(reopened.size).toBe(2);
  });

  it("starts empty when the file does not exist", async () => {
    const map = await IdMap.open(path.join(dir, "fresh.json"));

    expect(map.get("anything")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("leaves no temp files behind after writes (atomic rename)", async () => {
    const file = path.join(dir, "idmap.json");
    const map = await IdMap.open(file);
    await map.set("a", 1);
    await map.set("b", 2);

    const files = await readdir(dir);

    expect(files).toEqual(["idmap.json"]);
  });

  it("overwrites an existing mapping (edit repointing)", async () => {
    const file = path.join(dir, "idmap.json");
    const map = await IdMap.open(file);
    await map.set("uri", 1);
    await map.set("uri", 9);

    expect(map.get("uri")).toBe(9);
    expect((await IdMap.open(file)).get("uri")).toBe(9);
  });
});
