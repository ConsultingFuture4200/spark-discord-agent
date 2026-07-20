import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  deleteEventFromDiscord,
  messageEventFromDiscord,
} from "../src/ingestWiring.js";

/** Build a minimal discord.js-Message-shaped fake for the adapter. */
function fakeMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    partial: false,
    id: "msg-1",
    system: false,
    guildId: "g1",
    channelId: "chan-1",
    channel: { isThread: () => false },
    author: { id: "user-1", bot: false, username: "ada" },
    member: { displayName: "Ada" },
    content: "hello world",
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    ...overrides,
  } as unknown as Message;
}

describe("messageEventFromDiscord", () => {
  it("maps a plain guild message", () => {
    const event = messageEventFromDiscord(fakeMessage());

    expect(event).toEqual({
      guildId: "g1",
      channelId: "chan-1",
      messageId: "msg-1",
      authorId: "user-1",
      authorName: "Ada",
      content: "hello world",
      timestamp: "2026-07-20T12:00:00.000Z",
      mentionUserIds: [],
      attachments: [],
    });
  });

  it("maps thread messages onto the parent channel with a threadId", () => {
    const event = messageEventFromDiscord(
      fakeMessage({
        channelId: "thread-5",
        channel: { isThread: () => true, parentId: "chan-1" },
      }),
    );

    expect(event?.channelId).toBe("chan-1");
    expect(event?.threadId).toBe("thread-5");
  });

  it("carries reply target, mentions, and attachment metadata", () => {
    const event = messageEventFromDiscord(
      fakeMessage({
        reference: { messageId: "msg-0" },
        mentions: { users: new Map([["user-2", {}]]) },
        attachments: new Map([
          [
            "att-1",
            {
              id: "att-1",
              url: "https://cdn/x.mp4",
              name: "x.mp4",
              contentType: "video/mp4",
            },
          ],
        ]),
      }),
    );

    expect(event?.replyToMessageId).toBe("msg-0");
    expect(event?.mentionUserIds).toEqual(["user-2"]);
    expect(event?.attachments).toEqual([
      { id: "att-1", url: "https://cdn/x.mp4", filename: "x.mp4", contentType: "video/mp4" },
    ]);
  });

  it.each([
    ["bot author", { author: { id: "b", bot: true, username: "bot" } }],
    ["system message", { system: true }],
    ["DM (no guild)", { guildId: null }],
    ["partial message", { partial: true }],
    ["empty content, no attachments", { content: "   " }],
  ])("returns null for %s", (_label, overrides) => {
    expect(messageEventFromDiscord(fakeMessage(overrides))).toBeNull();
  });

  it("keeps an empty-content message that has attachments", () => {
    const event = messageEventFromDiscord(
      fakeMessage({
        content: "",
        attachments: new Map([
          ["a", { id: "a", url: "u", name: "pic.png", contentType: "image/png" }],
        ]),
      }),
    );

    expect(event).not.toBeNull();
  });
});

describe("deleteEventFromDiscord", () => {
  it("maps a guild delete (partial-safe: only ids required)", () => {
    const event = deleteEventFromDiscord(
      fakeMessage({ partial: true, content: undefined }),
    );

    expect(event).toEqual({ guildId: "g1", channelId: "chan-1", messageId: "msg-1" });
  });

  it("returns null for DMs", () => {
    expect(deleteEventFromDiscord(fakeMessage({ guildId: null }))).toBeNull();
  });
});
