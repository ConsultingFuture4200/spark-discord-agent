import type { z } from "zod";

/**
 * Parse JSON that an LLM produced, tolerating a ```json … ``` code fence the
 * model may wrap around it despite instructions.
 */
export function safeJsonParse(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const cleaned = stripCodeFence(raw);
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  // Drop the opening fence line (``` or ```json) and the trailing fence.
  return trimmed
    .replace(/^```[a-zA-Z0-9]*\s*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

/** Flatten a ZodError into a compact single-line message for LLM repair prompts. */
export function zodErrorToString(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("; ");
}
