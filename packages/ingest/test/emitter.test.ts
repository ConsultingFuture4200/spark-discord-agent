import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallSummary } from "@discord-agent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GbrainClient } from "../src/client.js";
import type { ConsentConfig } from "../src/consent.js";
import { IngestEmitter, chunkSegments } from "../src/emitter.js";
import type { CallOutputEvent, MessageEvent } from "../src/events.js";
import { IdMap } from "../src/idmap.js";
import { startStubGbrain, type StubGbrain } from "./stubGbrain.js";

const CONSENT: ConsentConfig = {
  allowChannels: ["chan-allowed", "voice-allowed"],
  optOutMembers: ["user-optout"],
};

function messageEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1",
    channelId: "chan-allowed",
    messageId: "msg-1",
    authorId: "user-ada",
    authorName: "Ada",
    content: "TriDB looks promising for the community brain.",
    timestamp: "2026-07-20T12:00:00.000Z",
    mentionUserIds: [],
    attachments: [],
    ...overrides,
  };
}

const SUMMARY: CallSummary = {
  fullCall: {
    overview: "Discussed the gBrain migration to TriDB.",
    keyTopics: ["gBrain", "TriDB"],
    decisions: ["Adopt TriDB as the backing store."],
    openQuestions: [],
    actionItems: [{ owner: "Ada", item: "Draft the schema bootstrap" }],
  },
  perSpeaker: [],
};

function callOutputEvent(overrides: {
  channelId?: string;
  summary?: CallSummary;
}): CallOutputEvent {
  return {
    manifest: {
      callId: "call-1",
      guildId: "g1",
      channelId: overrides.channelId ?? "voice-allowed",
      startedAt: "2026-07-20T11:00:00.000Z",
      endedAt: "2026-07-20T11:30:00.000Z",
      tracks: [
        { userId: "user-ada", displayName: "Ada", path: "audio/a.wav", startOffsetMs: 0 },
        { userId: "user-optout", displayName: "Eve", path: "audio/e.wav", startOffsetMs: 0 },
      ],
    },
    transcript: {
      callId: "call-1",
      segments: [
        { speaker: "Ada", startMs: 0, endMs: 1000, text: "Let us adopt TriDB." },
        { speaker: "Eve", startMs: 1000, endMs: 2000, text: "My secret opinion." },
        { speaker: "Ada", startMs: 2000, endMs: 3000, text: "Agreed on the schema." },
      ],
    },
    summary: overrides.summary ?? SUMMARY,
  };
}

describe("IngestEmitter", () => {
  let stub: StubGbrain;
  let stateDir: string;
  let emitter: IngestEmitter;
  let idMap: IdMap;

  beforeEach(async () => {
    stub = await startStubGbrain();
    stateDir = await mkdtemp(path.join(tmpdir(), "ingest-emitter-"));
    idMap = await IdMap.open(path.join(stateDir, "idmap.json"));
    emitter = new IngestEmitter({
      client: new GbrainClient({ baseUrl: stub.baseUrl }),
      idMap,
      consent: CONSENT,
    });
  });

  afterEach(async () => {
    await stub.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  describe("messages", () => {
    it("stores member + channel + message nodes with authored/in_channel edges", async () => {
      const result = await emitter.handleMessage(messageEvent());

      expect(result.skipped).toBeUndefined();
      expect(result.memories).toBe(3); // member, channel, message
      expect(result.edges).toBe(2); // authored, in_channel

      const memories = stub.to("/memory").map((r) => r.body);
      expect(memories.map((m) => m.kind)).toEqual(["member", "channel", "message"]);
      expect(memories[2]).toMatchObject({
        text: "TriDB looks promising for the community brain.",
        kind: "message",
        region: "discord",
        source: "discord://message/g1/chan-allowed/msg-1",
      });

      const edges = stub.to("/edge").map((r) => r.body);
      // member(0) authored message(2); message(2) in_channel channel(1).
      expect(edges).toEqual([
        { src: 0, dst: 2, rel: "authored" },
        { src: 2, dst: 1, rel: "in_channel" },
      ]);
    });

    it("emits in_thread, replies_to, and mentions edges when targets are known", async () => {
      await emitter.handleMessage(messageEvent()); // msg-1 by Ada → ids 0..2
      await emitter.handleMember("user-ben", "Ben"); // member Ben → id 3

      const result = await emitter.handleMessage(
        messageEvent({
          messageId: "msg-2",
          threadId: "thread-9",
          replyToMessageId: "msg-1",
          mentionUserIds: ["user-ben", "user-optout"],
          content: "Replying with a mention.",
        }),
      );

      // message(4) + thread(5); author/channel already exist.
      expect(result.memories).toBe(2);
      // authored, in_channel, in_thread, replies_to, mentions(Ben only).
      expect(result.edges).toBe(5);
      const rels = stub.to("/edge").map((r) => r.body.rel);
      expect(rels).toEqual([
        "authored",
        "in_channel",
        "authored",
        "in_channel",
        "in_thread",
        "replies_to",
        "mentions",
      ]);
      // The mention edge targets Ben's node, never the opted-out member.
      const mention = stub.to("/edge").find((r) => r.body.rel === "mentions");
      expect(mention?.body.dst).toBe(3);
    });

    it("denies channels not on the allowlist (default DENY)", async () => {
      const result = await emitter.handleMessage(
        messageEvent({ channelId: "chan-unlisted" }),
      );

      expect(result.skipped).toBe("channel not allowlisted");
      expect(stub.requests).toHaveLength(0);
    });

    it("skips messages from opted-out authors", async () => {
      const result = await emitter.handleMessage(
        messageEvent({ authorId: "user-optout", authorName: "Eve" }),
      );

      expect(result.skipped).toBe("author opted out");
      expect(stub.requests).toHaveLength(0);
    });

    it("is idempotent: re-emitting the same message stores nothing", async () => {
      await emitter.handleMessage(messageEvent());
      const before = stub.requests.length;

      const result = await emitter.handleMessage(messageEvent());

      expect(result.skipped).toBe("already ingested");
      expect(stub.requests).toHaveLength(before);
    });
  });

  describe("edits (PRD D6 append-only)", () => {
    it("stores a new node with supersedes pointing at the original", async () => {
      await emitter.handleMessage(messageEvent()); // message node id 2
      const result = await emitter.handleMessageEdit(
        messageEvent({ content: "TriDB looks great (edited)." }),
      );

      expect(result.skipped).toBeUndefined();
      const edited = stub.to("/memory").at(-1)?.body;
      expect(edited).toMatchObject({
        kind: "message",
        text: "TriDB looks great (edited).",
        supersedes: 2,
      });
      // The map now points at the new node, so future replies edge against it.
      expect(idMap.get("discord://message/g1/chan-allowed/msg-1")).toBe(3);
    });

    it("treats an edit of a never-ingested message as a fresh store", async () => {
      const result = await emitter.handleMessageEdit(messageEvent());

      expect(result.skipped).toBeUndefined();
      const stored = stub.to("/memory").at(-1)?.body;
      expect(stored?.supersedes).toBeUndefined();
    });
  });

  describe("deletions (tombstone requests)", () => {
    it("emits a tombstone_request node with an about edge to the target", async () => {
      await emitter.handleMessage(messageEvent()); // message node id 2
      const result = await emitter.handleMessageDelete({
        guildId: "g1",
        channelId: "chan-allowed",
        messageId: "msg-1",
      });

      expect(result).toEqual({ memories: 1, edges: 1 });
      const tombstone = stub.to("/memory").at(-1)?.body;
      expect(tombstone).toMatchObject({
        kind: "tombstone_request",
        source: "discord://tombstone/g1/chan-allowed/msg-1",
      });
      expect(tombstone?.text).toContain("delete memory 2");
      expect(stub.to("/edge").at(-1)?.body).toMatchObject({ dst: 2, rel: "about" });
    });

    it("skips deletes of messages that were never ingested", async () => {
      const result = await emitter.handleMessageDelete({
        guildId: "g1",
        channelId: "chan-unlisted",
        messageId: "msg-x",
      });

      expect(result.skipped).toBe("message was never ingested");
      expect(stub.requests).toHaveLength(0);
    });
  });

  describe("attachments (media-ingest events)", () => {
    it("emits a media_ingest_request node + attached_to edge for video/image attachments", async () => {
      const result = await emitter.handleMessage(
        messageEvent({
          attachments: [
            {
              id: "att-1",
              url: "https://cdn.discord.test/demo.mp4",
              filename: "demo.mp4",
              contentType: "video/mp4",
            },
            {
              id: "att-2",
              url: "https://cdn.discord.test/notes.txt",
              filename: "notes.txt",
              contentType: "text/plain",
            },
          ],
        }),
      );

      // member + channel + message + ONE media request (the .txt is skipped).
      expect(result.memories).toBe(4);
      const media = stub
        .to("/memory")
        .map((r) => r.body)
        .filter((m) => m.kind === "media_ingest_request");
      expect(media).toHaveLength(1);
      const meta = JSON.parse(media[0]!.text as string) as Record<string, unknown>;
      expect(meta).toMatchObject({
        url: "https://cdn.discord.test/demo.mp4",
        contentType: "video/mp4",
        messageId: "msg-1",
      });
      expect(stub.to("/edge").at(-1)?.body.rel).toBe("attached_to");
    });
  });

  describe("call outputs", () => {
    it("ingests chunks, summary, decisions, and action items with the full edge set", async () => {
      const result = await emitter.handleCallOutput(callOutputEvent({}));

      expect(result.skipped).toBeUndefined();
      const memories = stub.to("/memory").map((r) => r.body);
      const kinds = memories.map((m) => m.kind);
      // Ada's member node (Eve is opted out), call_summary, channel anchor,
      // one transcript chunk, one decision, one action item.
      expect(kinds).toEqual([
        "member",
        "call_summary",
        "channel",
        "transcript_chunk",
        "decision",
        "action_item",
      ]);

      // Opted-out Eve's speech never reaches gBrain.
      const chunk = memories.find((m) => m.kind === "transcript_chunk");
      expect(chunk?.text).toContain("Ada: Let us adopt TriDB.");
      expect(chunk?.text).not.toContain("secret opinion");

      const rels = stub.to("/edge").map((r) => r.body.rel);
      expect(rels).toEqual([
        "in_channel", // call → channel
        "part_of_call", // chunk → call
        "spoke_in", // Ada → chunk
        "decided_in", // decision → call
        "decided_in", // action item → call
        "assigned_to", // action item → Ada
      ]);
    });

    it("denies calls from voice channels not on the allowlist", async () => {
      const result = await emitter.handleCallOutput(
        callOutputEvent({ channelId: "voice-unlisted" }),
      );

      expect(result.skipped).toBe("channel not allowlisted");
      expect(stub.requests).toHaveLength(0);
    });

    it("is idempotent per call: a re-run after delivery stores nothing", async () => {
      await emitter.handleCallOutput(callOutputEvent({}));
      const before = stub.requests.length;

      const result = await emitter.handleCallOutput(callOutputEvent({}));

      expect(result.skipped).toBe("already ingested");
      expect(stub.requests).toHaveLength(before);
    });
  });
});

describe("chunkSegments", () => {
  it("splits at the char budget without splitting a segment", () => {
    const segments = [
      { speaker: "Ada", startMs: 0, endMs: 1, text: "a".repeat(50) },
      { speaker: "Ben", startMs: 1, endMs: 2, text: "b".repeat(50) },
      { speaker: "Ada", startMs: 2, endMs: 3, text: "c".repeat(50) },
    ];

    const chunks = chunkSegments(segments, 120);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.speakers).toEqual(["Ada", "Ben"]);
    expect(chunks[1]!.speakers).toEqual(["Ada"]);
  });

  it("returns no chunks for no segments", () => {
    expect(chunkSegments([], 100)).toEqual([]);
  });
});
