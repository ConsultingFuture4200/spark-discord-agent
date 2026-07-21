/**
 * Historical message backfill — walks every text channel and thread of the
 * guild from newest to oldest and feeds each message through the same
 * IngestEmitter path as live capture, so backfilled history produces
 * identical nodes/edges. Safe to re-run and to run alongside the live
 * service: gBrain dedupes messages by canonical source ref, and consent
 * (channel allowlist / server-wide + member opt-outs) is enforced by the
 * emitter exactly as in live ingest.
 *
 *   node packages/capture/dist/backfill.js
 *
 * A per-channel cursor in `${INGEST_STATE_DIR}/backfill-state.json` lets an
 * interrupted run resume where it stopped instead of re-fetching everything.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AnyThreadChannel,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { GbrainClient, IngestEmitter, loadConsentConfig } from "@discord-agent/ingest";
import { loadConfig } from "@discord-agent/shared";
import { messageEventFromDiscord } from "./ingestWiring.js";
import { createLogger } from "./logger.js";

interface ChannelCursor {
  /** Oldest message id fetched so far (walk continues before this). */
  before?: string;
  done?: boolean;
}

interface BackfillState {
  channels: Record<string, ChannelCursor>;
}

async function loadState(file: string): Promise<BackfillState> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as BackfillState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { channels: {} };
    throw err;
  }
}

async function saveState(file: string, state: BackfillState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, file);
}

async function main(): Promise<void> {
  const logger = createLogger("info", "backfill");
  const config = loadConfig();
  if (!config.ingest) {
    throw new Error("INGEST_ENABLED must be true for a backfill run");
  }
  const ingest = config.ingest;
  const stateFile = path.join(ingest.stateDir, "backfill-state.json");
  const state = await loadState(stateFile);

  const consent = await loadConsentConfig(ingest.consentPath);
  const emitter = new IngestEmitter({
    // direct client, no outbox: backfill wants synchronous backpressure so
    // one run cannot flood gBrain's queue faster than the writer drains it
    client: new GbrainClient({ baseUrl: ingest.gbrainBaseUrl }),
    consent,
    region: ingest.region,
    logger,
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  await client.login(config.discord.token);
  const guild = await client.guilds.fetch(config.discord.guildId);
  logger.info(`backfilling guild "${guild.name}"`);

  const seenMembers = new Set<string>();
  let totalStored = 0;
  let totalFetched = 0;

  const targets = await collectTargets(guild, logger);
  logger.info(`${targets.length} channel(s)/thread(s) to walk`);

  for (const target of targets) {
    const cursor = (state.channels[target.id] ??= {});
    if (cursor.done) continue;
    let before = cursor.before;
    let walked = 0;

    for (;;) {
      const page = await target.messages
        .fetch({ limit: 100, ...(before ? { before } : {}) })
        .catch((err: unknown) => {
          logger.warn(`#${target.name ?? target.id}: fetch failed (${String(err)})`);
          return null;
        });
      if (page === null) break;
      if (page.size === 0) {
        cursor.done = true;
        await saveState(stateFile, state);
        break;
      }
      for (const message of page.values()) {
        totalFetched++;
        const ev = messageEventFromDiscord(message);
        if (ev === null) continue;
        if (!seenMembers.has(ev.authorId)) {
          seenMembers.add(ev.authorId);
          await emitter.handleMember(ev.authorId, ev.authorName);
        }
        const result = await emitter.handleMessage(ev);
        totalStored += result.memories;
      }
      before = page.last()?.id;
      if (before !== undefined) cursor.before = before;
      walked += page.size;
      if (walked % 500 === 0) {
        await saveState(stateFile, state);
        logger.info(`#${target.name ?? target.id}: ${walked} walked…`);
      }
    }
    logger.info(
      `#${target.name ?? target.id}: complete (${walked} message(s) this run)`,
    );
  }

  logger.info(
    `backfill done — ${totalFetched} fetched, ${totalStored} new memories stored ` +
      `(dedupe + consent skipped the rest)`,
  );
  await client.destroy();
}

/** Every walkable text surface: text/announcement channels + all threads. */
async function collectTargets(
  guild: Guild,
  logger: { warn(m: string): void },
): Promise<(GuildTextBasedChannel | AnyThreadChannel)[]> {
  const targets: (GuildTextBasedChannel | AnyThreadChannel)[] = [];
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (channel === null) continue;
    if (channel.isTextBased() && !channel.isThread()) {
      targets.push(channel);
    }
    // forum/media channels are not text-based themselves; their threads are
    if (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement ||
      channel.type === ChannelType.GuildForum
    ) {
      try {
        const active = await channel.threads.fetchActive();
        targets.push(...active.threads.values());
        const archived = await channel.threads.fetchArchived({ limit: 100 });
        targets.push(...archived.threads.values());
      } catch (err) {
        logger.warn(`threads of #${channel.name}: ${String(err)}`);
      }
    }
  }
  return targets;
}

main().catch((err) => {
  console.error(`[backfill] fatal: ${String(err instanceof Error ? err.message : err)}`);
  process.exitCode = 1;
});
