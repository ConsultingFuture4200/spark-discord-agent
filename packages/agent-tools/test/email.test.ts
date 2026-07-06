import { describe, expect, it, vi } from "vitest";
import {
  createEmailTools,
  type EmailGateway,
  type EmailMessage,
  type EmailSummary,
  type SendEmailInput,
  type SendEmailResult,
} from "../src/email.js";

/** An in-memory gateway so the email tools are testable without a mail server. */
function fakeGateway(overrides: Partial<EmailGateway> = {}): EmailGateway {
  return {
    listRecent: overrides.listRecent ?? (async () => []),
    read:
      overrides.read ??
      (async () => {
        throw new Error("not implemented");
      }),
    send: overrides.send ?? (async () => ({ messageId: "<generated>" })),
  };
}

function toolMap(gateway: EmailGateway) {
  const tools = createEmailTools(gateway);
  return new Map(tools.map((t) => [t.name, t]));
}

describe("createEmailTools", () => {
  it("exposes list, read, and send tools", () => {
    const tools = createEmailTools(fakeGateway());
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_recent_emails",
      "read_email",
      "send_email",
    ]);
  });

  it("list_recent_emails passes limit/mailbox and returns JSON summaries", async () => {
    const summaries: EmailSummary[] = [
      { uid: 9, from: "Ada <ada@example.com>", subject: "Hi", date: "2026-07-05T10:00:00.000Z" },
    ];
    const listRecent = vi.fn(async () => summaries);
    const tools = toolMap(fakeGateway({ listRecent }));

    const out = await tools.get("list_recent_emails")!.execute({ limit: 5, mailbox: "Work" });
    expect(listRecent).toHaveBeenCalledWith(5, "Work");
    expect(JSON.parse(out)).toEqual(summaries);
  });

  it("list_recent_emails defaults the limit to 10 when omitted", async () => {
    const listRecent = vi.fn(async () => []);
    const tools = toolMap(fakeGateway({ listRecent }));
    await tools.get("list_recent_emails")!.execute({});
    expect(listRecent).toHaveBeenCalledWith(10, undefined);
  });

  it("read_email returns the full message as JSON", async () => {
    const message: EmailMessage = {
      uid: 12,
      from: "Ada <ada@example.com>",
      to: "agent@example.com",
      subject: "Report",
      date: "2026-07-05T10:00:00.000Z",
      messageId: "<abc@example.com>",
      text: "the body",
    };
    const read = vi.fn(async () => message);
    const tools = toolMap(fakeGateway({ read }));

    const out = await tools.get("read_email")!.execute({ uid: 12 });
    expect(read).toHaveBeenCalledWith(12, undefined);
    expect(JSON.parse(out)).toEqual(message);
  });

  it("send_email maps body->text and in_reply_to->inReplyTo, omitting unset fields", async () => {
    let received: SendEmailInput | undefined;
    const send = vi.fn(async (input: SendEmailInput): Promise<SendEmailResult> => {
      received = input;
      return { messageId: "<sent-1@example.com>" };
    });
    const tools = toolMap(fakeGateway({ send }));

    const out = await tools.get("send_email")!.execute({
      to: "boss@example.com",
      subject: "Re: Report",
      body: "Done.",
      in_reply_to: "<abc@example.com>",
    });

    expect(received).toEqual({
      to: "boss@example.com",
      subject: "Re: Report",
      text: "Done.",
      inReplyTo: "<abc@example.com>",
    });
    expect(received).not.toHaveProperty("cc");
    expect(out).toContain("<sent-1@example.com>");
  });

  it("send_email rejects a non-email recipient before touching the gateway", async () => {
    const send = vi.fn(async () => ({ messageId: "x" }));
    const tools = toolMap(fakeGateway({ send }));
    await expect(
      tools.get("send_email")!.execute({ to: "not-an-email", subject: "s", body: "b" }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
