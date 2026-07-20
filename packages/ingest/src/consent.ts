import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Consent gates (PRD D8): opt-in before ingest.
 *
 * A JSON config file carries a per-channel allowlist and a per-member opt-out
 * list, both checked at emit time. The default posture is DENY: a channel not
 * on the allowlist is never ingested, and a missing config file means nothing
 * is ingested at all. Voice ingestion additionally keeps the bot's existing
 * announce-on-record behavior (capture announces before any audio is
 * recorded); the same allowlist applies to the voice channel's id.
 */

export const ConsentConfigSchema = z.object({
  /** Channel ids (text or voice) whose content may be ingested. */
  allowChannels: z.array(z.string().min(1)).default([]),
  /** User ids whose content is never ingested (messages, mentions, speech). */
  optOutMembers: z.array(z.string().min(1)).default([]),
});
export type ConsentConfig = z.infer<typeof ConsentConfigSchema>;

/** The deny-everything default used when no consent file exists. */
export const DENY_ALL: ConsentConfig = { allowChannels: [], optOutMembers: [] };

/**
 * Load the consent config from a JSON file. A missing file yields
 * {@link DENY_ALL} (safe default: nothing is ingested until channels are
 * explicitly allowlisted). A present-but-invalid file throws — a malformed
 * consent config must never silently widen or narrow consent.
 */
export async function loadConsentConfig(filePath: string): Promise<ConsentConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DENY_ALL;
    throw err;
  }
  return ConsentConfigSchema.parse(JSON.parse(raw));
}

/** True when the channel is explicitly allowlisted. Default deny. */
export function channelAllowed(consent: ConsentConfig, channelId: string): boolean {
  return consent.allowChannels.includes(channelId);
}

/** True when the member has opted out of ingestion. */
export function memberOptedOut(consent: ConsentConfig, userId: string): boolean {
  return consent.optOutMembers.includes(userId);
}
