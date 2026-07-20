import type { GbrainClient, QueryResponse } from "./client.js";

/**
 * The `/ask` command's brain: query gBrain with `mode=fused` and render the
 * ranked snippets, their sources, and the honesty footer (the engine's
 * `graph_censored` / `termination_reason` probes — PRD goal 2: honest,
 * user-visible recall quality signals).
 */

/** Discord's hard message limit is 2000; leave headroom for markdown. */
const MAX_REPLY_CHARS = 1900;
/** Cap per-snippet length so one long memory cannot crowd out the rest. */
const MAX_SNIPPET_CHARS = 400;

export interface AskOptions {
  k?: number;
  region?: string;
}

/** Query gBrain (fused recall) and render a Discord-ready reply. */
export async function ask(
  client: GbrainClient,
  question: string,
  options: AskOptions = {},
): Promise<string> {
  const response = await client.query(question, {
    mode: "fused",
    ...(options.k !== undefined ? { k: options.k } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
  });
  return renderAskReply(question, response);
}

/** Pure rendering of a query response (fixture-testable without HTTP). */
export function renderAskReply(question: string, response: QueryResponse): string {
  const lines: string[] = [`**Q:** ${question}`, ""];
  if (response.snippets.length === 0) {
    lines.push("No memories matched.");
  }
  response.snippets.forEach((snippet, i) => {
    const text = truncate(snippet.trim(), MAX_SNIPPET_CHARS);
    const source = response.sources[i] ?? "unknown source";
    lines.push(`**${i + 1}.** ${text}`, `-# ${source}`, "");
  });
  lines.push(honestyFooter(response));
  return truncate(lines.join("\n"), MAX_REPLY_CHARS);
}

/** The honesty footer: recall mode + TriDB's graph honesty probes. */
export function honestyFooter(response: QueryResponse): string {
  const parts = ["mode=fused"];
  if (response.graph_censored !== undefined) {
    parts.push(`graph_censored=${response.graph_censored}`);
  }
  if (response.termination_reason !== undefined) {
    parts.push(`termination=${response.termination_reason}`);
  }
  return `-# ${parts.join(" | ")}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
