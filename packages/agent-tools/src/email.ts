import type { EmailConfig } from "@discord-agent/shared";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import { defineTool, type RegisteredTool } from "./tools.js";

/**
 * Email as model tools (FR-4..FR-6): list + read via IMAP, send via SMTP.
 *
 * The tools depend on an {@link EmailGateway} interface, not on imapflow /
 * nodemailer directly, so the tool logic is unit-testable with a fake gateway
 * (no live mail server). {@link ImapSmtpEmailGateway} is the real, config-driven
 * implementation against the documented IMAP/SMTP client APIs.
 */

/** A lightweight header-only view of a message, for listing. */
export interface EmailSummary {
  /** IMAP UID — stable within a mailbox; use it to `read` the full message. */
  uid: number;
  from: string;
  subject: string;
  /** ISO-8601 date. */
  date: string;
}

/** A full message, including body text. */
export interface EmailMessage extends EmailSummary {
  to: string;
  /** RFC Message-ID, when present; thread replies by passing it as `inReplyTo`. */
  messageId: string | undefined;
  text: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  cc?: string;
  /** Message-ID being replied to, for threading. */
  inReplyTo?: string;
  /** References header (space-separated Message-IDs), for threading. */
  references?: string;
}

export interface SendEmailResult {
  messageId: string;
}

/** The read/list/send surface the email tools call. */
export interface EmailGateway {
  listRecent(limit: number, mailbox?: string): Promise<EmailSummary[]>;
  read(uid: number, mailbox?: string): Promise<EmailMessage>;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

const DEFAULT_MAILBOX = "INBOX";

/**
 * Real gateway: IMAP (imapflow) for read/list, SMTP (nodemailer) for send.
 * Fully config-driven from {@link EmailConfig}; provider-agnostic. Opens a fresh
 * IMAP connection per operation (the agent's mail volume is low and always-on
 * IMAP idle is out of scope for v1).
 */
export class ImapSmtpEmailGateway implements EmailGateway {
  private readonly imap: EmailConfig["imap"];
  private readonly from: string;
  private readonly transport: Transporter;

  constructor(config: EmailConfig) {
    this.imap = config.imap;
    this.from = config.smtp.from;
    this.transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    });
  }

  async listRecent(limit: number, mailbox = DEFAULT_MAILBOX): Promise<EmailSummary[]> {
    return this.withMailbox(mailbox, async (client) => {
      const box = client.mailbox;
      const total = typeof box === "object" ? box.exists : 0;
      if (total === 0) return [];

      const start = Math.max(1, total - limit + 1);
      const summaries: EmailSummary[] = [];
      for await (const msg of client.fetch(`${start}:*`, { envelope: true, uid: true })) {
        summaries.push(toSummary(msg.uid, msg.envelope));
      }
      // Newest first.
      return summaries.sort((a, b) => b.uid - a.uid);
    });
  }

  async read(uid: number, mailbox = DEFAULT_MAILBOX): Promise<EmailMessage> {
    return this.withMailbox(mailbox, async (client) => {
      const msg = await client.fetchOne(
        String(uid),
        { source: true, envelope: true, uid: true },
        { uid: true },
      );
      if (!msg || !msg.source) {
        throw new Error(`email uid ${uid} not found in ${mailbox}`);
      }

      const parsed = await simpleParser(msg.source);
      const summary = toSummary(msg.uid, msg.envelope);
      return {
        ...summary,
        to: formatAddresses(msg.envelope?.to),
        messageId: msg.envelope?.messageId ?? undefined,
        text: parsed.text ?? "",
      };
    });
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.cc ? { cc: input.cc } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references ? { references: input.references } : {}),
    });
    return { messageId: info.messageId };
  }

  private async withMailbox<T>(
    mailbox: string,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.tls,
      auth: { user: this.imap.user, pass: this.imap.password },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }
}

/** Build the three email tools bound to a gateway (real or fake). */
export function createEmailTools(gateway: EmailGateway): RegisteredTool[] {
  const listTool = defineTool({
    name: "list_recent_emails",
    description:
      "List the most recent emails in a mailbox (headers only: uid, from, subject, date). " +
      "Use the returned uid with read_email to get an email's body.",
    schema: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("How many recent emails to list (default 10, max 50)."),
      mailbox: z.string().optional().describe("Mailbox name; defaults to INBOX."),
    }),
    async execute(args) {
      const summaries = await gateway.listRecent(args.limit ?? 10, args.mailbox);
      return JSON.stringify(summaries);
    },
  });

  const readTool = defineTool({
    name: "read_email",
    description: "Read the full text of one email by its IMAP uid.",
    schema: z.object({
      uid: z.number().int().positive().describe("IMAP uid from list_recent_emails."),
      mailbox: z.string().optional().describe("Mailbox name; defaults to INBOX."),
    }),
    async execute(args) {
      const message = await gateway.read(args.uid, args.mailbox);
      return JSON.stringify(message);
    },
  });

  const sendTool = defineTool({
    name: "send_email",
    description:
      "Send an email from the agent's address. To reply within a thread, pass the " +
      "original Message-ID as in_reply_to.",
    schema: z.object({
      to: z.string().email().describe("Recipient email address."),
      subject: z.string().min(1).describe("Subject line."),
      body: z.string().describe("Plain-text body."),
      cc: z.string().email().optional(),
      in_reply_to: z.string().optional().describe("Message-ID being replied to."),
      references: z.string().optional().describe("References header for threading."),
    }),
    async execute(args) {
      const input: SendEmailInput = {
        to: args.to,
        subject: args.subject,
        text: args.body,
        ...(args.cc ? { cc: args.cc } : {}),
        ...(args.in_reply_to ? { inReplyTo: args.in_reply_to } : {}),
        ...(args.references ? { references: args.references } : {}),
      };
      const result = await gateway.send(input);
      return `Email sent to ${args.to} (message-id ${result.messageId}).`;
    },
  });

  return [listTool, readTool, sendTool];
}

// --- Internal mapping helpers ------------------------------------------------

interface EnvelopeAddress {
  name?: string;
  address?: string;
}

interface Envelope {
  date?: Date | null;
  subject?: string | null;
  from?: EnvelopeAddress[] | null;
  to?: EnvelopeAddress[] | null;
  messageId?: string | null;
}

function toSummary(uid: number, envelope: Envelope | undefined): EmailSummary {
  return {
    uid,
    from: formatAddresses(envelope?.from),
    subject: envelope?.subject ?? "(no subject)",
    date: envelope?.date instanceof Date ? envelope.date.toISOString() : "",
  };
}

function formatAddresses(addresses: EnvelopeAddress[] | null | undefined): string {
  if (!addresses || addresses.length === 0) return "";
  return addresses
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")))
    .filter((s) => s.length > 0)
    .join(", ");
}
