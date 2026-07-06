import { z } from "zod";
import type { SummaryPoster } from "./ports.js";
import { splitForDiscord } from "./render.js";

/**
 * Posts the rendered summary to Discord via the REST API using the bot token
 * (FR-19). Creates a public thread off the call's text channel, then writes the
 * (possibly chunked) markdown into it. Kept independent of the capture bot so
 * the processing service can run as its own process.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Discord thread type 11 = GUILD_PUBLIC_THREAD (created without a parent message). */
const PUBLIC_THREAD = 11;

/** Auto-archive after 1 day (1440 min) of inactivity. */
const AUTO_ARCHIVE_MINUTES = 1440;

const ThreadResponse = z.object({ id: z.string() });

/** Shape of the active-threads listing we care about (id + name per thread). */
const ActiveThreadsResponse = z.object({
  threads: z.array(z.object({ id: z.string(), name: z.string().nullish() })),
});

export interface DiscordRestPosterOptions {
  token: string;
  /** Override the API base (tests). Defaults to Discord v10. */
  apiBase?: string;
  /** Injectable fetch, for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class DiscordRestPoster implements SummaryPoster {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DiscordRestPosterOptions) {
    this.apiBase = (opts.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async postSummary(
    channelId: string,
    callId: string,
    markdown: string,
  ): Promise<{ threadId: string }> {
    const name = threadName(callId);
    // Idempotent thread creation: a crash between the create and the threadId
    // fs-write leaves a thread on Discord with no persisted id, so a reclaim
    // would otherwise create a *second* thread. Reuse an existing active thread
    // with the deterministic name instead of creating a duplicate.
    const threadId =
      (await this.findActiveThreadId(channelId, name)) ??
      ThreadResponse.parse(
        await this.post(`/channels/${channelId}/threads`, {
          name,
          type: PUBLIC_THREAD,
          auto_archive_duration: AUTO_ARCHIVE_MINUTES,
        }),
      ).id;

    for (const chunk of splitForDiscord(markdown)) {
      await this.post(`/channels/${threadId}/messages`, { content: chunk });
    }
    return { threadId };
  }

  /**
   * Look up an existing active thread on the channel by exact name. Best-effort:
   * if the listing fails or is unparseable we return undefined and fall through
   * to creating the thread, so a transient list error never blocks delivery.
   */
  private async findActiveThreadId(
    channelId: string,
    name: string,
  ): Promise<string | undefined> {
    const res = await this.fetchImpl(
      `${this.apiBase}/channels/${channelId}/threads/active`,
      { method: "GET", headers: { authorization: `Bot ${this.opts.token}` } },
    );
    if (!res.ok) return undefined;
    const parsed = ActiveThreadsResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return undefined;
    return parsed.data.threads.find((t) => t.name === name)?.id;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bot ${this.opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Discord POST ${path} failed (${res.status} ${res.statusText}): ${errBody.slice(0, 500)}`,
      );
    }
    return res.json();
  }
}

function threadName(callId: string): string {
  // Discord thread names cap at 100 chars.
  return `Call summary — ${callId}`.slice(0, 100);
}
