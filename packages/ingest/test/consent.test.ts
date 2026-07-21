import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  channelAllowed,
  DENY_ALL,
  loadConsentConfig,
  memberOptedOut,
} from "../src/consent.js";

describe("consent gates", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ingest-consent-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to DENY ALL when the config file is missing", async () => {
    const consent = await loadConsentConfig(path.join(dir, "nope.json"));

    expect(consent).toEqual(DENY_ALL);
    expect(channelAllowed(consent, "any-channel")).toBe(false);
  });

  it("loads allowlist and opt-out from the file", async () => {
    const file = path.join(dir, "consent.json");
    await writeFile(
      file,
      JSON.stringify({ allowChannels: ["c1"], optOutMembers: ["u9"] }),
      "utf8",
    );

    const consent = await loadConsentConfig(file);

    expect(channelAllowed(consent, "c1")).toBe(true);
    expect(channelAllowed(consent, "c2")).toBe(false);
    expect(memberOptedOut(consent, "u9")).toBe(true);
    expect(memberOptedOut(consent, "u1")).toBe(false);
  });

  it("allows every channel under allowAllChannels but still honors opt-outs", async () => {
    const file = path.join(dir, "consent.json");
    await writeFile(
      file,
      JSON.stringify({ allowAllChannels: true, optOutMembers: ["u9"] }),
      "utf8",
    );

    const consent = await loadConsentConfig(file);

    expect(channelAllowed(consent, "any-channel")).toBe(true);
    expect(channelAllowed(consent, "another")).toBe(true);
    expect(memberOptedOut(consent, "u9")).toBe(true);
  });

  it("defaults allowAllChannels to false for a partial file", async () => {
    const file = path.join(dir, "consent.json");
    await writeFile(file, JSON.stringify({ allowChannels: ["c1"] }), "utf8");

    const consent = await loadConsentConfig(file);

    expect(consent.allowAllChannels).toBe(false);
    expect(channelAllowed(consent, "c2")).toBe(false);
  });

  it("applies field defaults for a partial file", async () => {
    const file = path.join(dir, "consent.json");
    await writeFile(file, JSON.stringify({ allowChannels: ["c1"] }), "utf8");

    const consent = await loadConsentConfig(file);

    expect(consent.optOutMembers).toEqual([]);
  });

  it("throws on a malformed config file instead of silently altering consent", async () => {
    const file = path.join(dir, "consent.json");
    await writeFile(file, JSON.stringify({ allowChannels: "not-an-array" }), "utf8");

    await expect(loadConsentConfig(file)).rejects.toThrow();
  });
});
