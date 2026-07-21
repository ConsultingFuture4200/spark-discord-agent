import type { CallSummary } from "@discord-agent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GbrainClient } from "../src/client.js";
import type { ConsentConfig } from "../src/consent.js";
import { IngestEmitter, messageSourceRef } from "../src/emitter.js";
import type { CallOutputEvent, MessageEvent } from "../src/events.js";
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
    actionItems: [
      { owner: "Ada", item: "Draft the schema bootstrap" },
      { owner: "Eve", item: "Review the consent copy" },
    ],
  },
  perSpeaker: [
    {
      displayName: "Ada",
      contributions: ["Proposed the TriDB migration."],
      positionsConcerns: [],
      actionItems: [],
    },
    {
      displayName: "Eve",
      contributions: ["Private remarks."],
      positionsConcerns: [],
      actionItems: [],
    },
  ],
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
  let emitter: IngestEmitter;

  beforeEach(async () => {
    stub = await startStubGbrain();
    emitter = new IngestEmitter({
      client: new GbrainClient({ baseUrl: stub.baseUrl }),
      consent: CONSENT,
    });
  });

  afterEach(async () => {
    await stub.close();
  });

  describe("messages", () => {
    it("posts one normalized message event — gBrain builds the graph server-side", async () => {
      const result = await emitter.handleMessage(messageEvent());

      expect(result.skipped).toBeUndefined();
      const events = stub.to("/ingest/event").map((r) => r.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "message",
        message_id: "msg-1",
        channel_id: "chan-allowed",
        author_id: "user-ada",
        author_name: "Ada",
        content: "TriDB looks promising for the community brain.",
        guild_id: "g1",
        edited: false,
        region: "discord",
      });
      // counts come from gBrain's response, not client-side bookkeeping
      expect(result).toEqual({ memories: 1, edges: 1 });
    });

    it("passes thread and reply refs through; gBrain resolves them by source", async () => {
      await emitter.handleMessage(
        messageEvent({
          messageId: "msg-2",
          threadId: "thread-9",
          replyToMessageId: "msg-1",
          mentionUserIds: ["user-ben", "user-optout"],
          content: "Replying with a mention.",
        }),
      );

      const event = stub.to("/ingest/event").at(-1)?.body;
      expect(event).toMatchObject({
        type: "message",
        thread_id: "thread-9",
        reply_to: "msg-1",
      });
      // opted-out members are stripped from mentions before anything is sent
      expect(event?.mentions).toEqual(["user-ben"]);
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
  });

  describe("edits (PRD D6 append-only)", () => {
    it("re-posts the message event with edited: true", async () => {
      await emitter.handleMessage(messageEvent());
      const result = await emitter.handleMessageEdit(
        messageEvent({ content: "TriDB looks great (edited)." }),
      );

      expect(result.skipped).toBeUndefined();
      const edited = stub.to("/ingest/event").at(-1)?.body;
      expect(edited).toMatchObject({
        type: "message",
        content: "TriDB looks great (edited).",
        edited: true,
      });
    });
  });

  describe("deletions (tombstone requests)", () => {
    it("posts a tombstone-request targeting gBrain's canonical message ref", async () => {
      const result = await emitter.handleMessageDelete({
        guildId: "g1",
        channelId: "chan-allowed",
        messageId: "msg-1",
      });

      expect(result).toEqual({ memories: 0, edges: 0 });
      expect(stub.to("/ingest/event").at(-1)?.body).toMatchObject({
        type: "tombstone-request",
        target: messageSourceRef("chan-allowed", "msg-1"),
      });
    });

    it("emits even for never-allowlisted channels — removal requests are never dropped", async () => {
      await emitter.handleMessageDelete({
        guildId: "g1",
        channelId: "chan-unlisted",
        messageId: "msg-x",
      });

      expect(stub.to("/ingest/event")).toHaveLength(1);
    });
  });

  describe("members", () => {
    it("posts a member event", async () => {
      const result = await emitter.handleMember("user-ben", "Ben");
      expect(stub.to("/ingest/event").at(-1)?.body).toMatchObject({
        type: "member",
        member_id: "user-ben",
        display_name: "Ben",
      });
      expect(result).toEqual({ memories: 1, edges: 1 });
    });

    it("respects opt-out", async () => {
      const result = await emitter.handleMember("user-optout", "Eve");
      expect(result.skipped).toBe("member opted out");
      expect(stub.requests).toHaveLength(0);
    });
  });

  describe("attachments (media events)", () => {
    it("posts one media event per video/image attachment for gBrain's transcribe/caption pipeline", async () => {
      await emitter.handleMessage(
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

      const events = stub.to("/ingest/event").map((r) => r.body);
      // message event + ONE media event (the .txt is skipped)
      expect(events.map((e) => e.type)).toEqual(["message", "media"]);
      expect(events[1]).toMatchObject({
        type: "media",
        media_id: "att-1",
        url: "https://cdn.discord.test/demo.mp4",
        filename: "demo.mp4",
        content_type: "video/mp4",
        channel_id: "chan-allowed",
        message_id: "msg-1",
      });
    });

    it("still posts media events for attachment-only messages (no text to store)", async () => {
      const result = await emitter.handleMessage(
        messageEvent({
          content: "",
          attachments: [
            {
              id: "att-1",
              url: "https://cdn.discord.test/photo.png",
              filename: "photo.png",
              contentType: "image/png",
            },
          ],
        }),
      );

      const events = stub.to("/ingest/event").map((r) => r.body);
      expect(events.map((e) => e.type)).toEqual(["media"]);
      expect(result).toEqual({ memories: 1, edges: 1 });
    });
  });

  describe("call outputs", () => {
    it("posts transcript + summary events (topics, speaker turns and edges are built by gBrain)", async () => {
      const result = await emitter.handleCallOutput(callOutputEvent({}));

      expect(result.skipped).toBeUndefined();
      const events = stub.to("/ingest/event").map((r) => r.body);
      expect(events.map((e) => e.type)).toEqual(["transcript", "summary"]);

      const transcript = events[0] as {
        call_id: string;
        channel_id: string;
        segments: { speaker: string; text: string }[];
      };
      expect(transcript.call_id).toBe("call-1");
      expect(transcript.channel_id).toBe("voice-allowed");
      // Opted-out Eve's speech never reaches gBrain.
      expect(transcript.segments.map((s) => s.speaker)).toEqual(["Ada", "Ada"]);
      expect(JSON.stringify(transcript)).not.toContain("secret opinion");

      const summary = events[1] as { summary: CallSummary };
      // keyTopics ride along so gBrain creates topic nodes + about edges.
      expect(summary.summary.fullCall.keyTopics).toEqual(["gBrain", "TriDB"]);
      // Eve's per-speaker section is dropped; her action-item ownership is anonymized.
      expect(summary.summary.perSpeaker.map((s) => s.displayName)).toEqual(["Ada"]);
      expect(summary.summary.fullCall.actionItems).toEqual([
        { owner: "Ada", item: "Draft the schema bootstrap" },
        { owner: "unassigned", item: "Review the consent copy" },
      ]);
    });

    it("substitutes a non-empty overview when the summarizer produced none", async () => {
      await emitter.handleCallOutput(
        callOutputEvent({
          summary: { ...SUMMARY, fullCall: { ...SUMMARY.fullCall, overview: "  " } },
        }),
      );

      const summary = stub.to("/ingest/event").at(-1)?.body as {
        summary: CallSummary;
      };
      expect(summary.summary.fullCall.overview).toBe("Call call-1");
    });

    it("denies calls from voice channels not on the allowlist", async () => {
      const result = await emitter.handleCallOutput(
        callOutputEvent({ channelId: "voice-unlisted" }),
      );

      expect(result.skipped).toBe("channel not allowlisted");
      expect(stub.requests).toHaveLength(0);
    });
  });
});
