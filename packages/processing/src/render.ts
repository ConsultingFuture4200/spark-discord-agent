import type { ActionItem, CallSummary } from "@discord-agent/shared";

/**
 * Render a {@link CallSummary} into Discord/email-friendly markdown (FR-19).
 * Pure. `splitForDiscord` chunks the result under Discord's per-message limit.
 */

/** Discord's hard message-content limit is 2000; keep headroom for safety. */
export const DISCORD_MESSAGE_LIMIT = 1900;

export function renderSummaryMarkdown(summary: CallSummary): string {
  const { fullCall, perSpeaker } = summary;
  const out: string[] = [];

  out.push("# Call summary");
  out.push("");
  out.push("## Overview");
  out.push(fullCall.overview.trim() || "_No overview._");

  out.push("");
  out.push("## Key topics");
  out.push(bulletList(fullCall.keyTopics));

  out.push("");
  out.push("## Decisions");
  out.push(bulletList(fullCall.decisions));

  out.push("");
  out.push("## Open questions");
  out.push(bulletList(fullCall.openQuestions));

  out.push("");
  out.push("## Action items");
  out.push(actionItemList(fullCall.actionItems));

  out.push("");
  out.push("## Per-speaker");
  if (perSpeaker.length === 0) {
    out.push("_No per-speaker breakdown._");
  } else {
    for (const s of perSpeaker) {
      out.push("");
      out.push(`### ${s.displayName}`);
      out.push("**Contributions**");
      out.push(bulletList(s.contributions));
      out.push("**Positions / concerns**");
      out.push(bulletList(s.positionsConcerns));
      out.push("**Action items**");
      out.push(actionItemList(s.actionItems));
    }
  }

  return out.join("\n");
}

function bulletList(items: readonly string[]): string {
  if (items.length === 0) return "_None._";
  return items.map((i) => `- ${i}`).join("\n");
}

function actionItemList(items: readonly ActionItem[]): string {
  if (items.length === 0) return "_None._";
  return items.map((a) => `- **${a.owner}:** ${a.item}`).join("\n");
}

/**
 * Split markdown into chunks each within `limit`, breaking on line boundaries
 * where possible. A single line longer than `limit` is hard-split.
 */
export function splitForDiscord(
  markdown: string,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine;
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > limit) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}
