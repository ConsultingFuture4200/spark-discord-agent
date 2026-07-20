import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Persistent source-URI → gBrain memory-id map.
 *
 * gBrain edges take integer memory ids, but Discord events reference each
 * other by snowflake (reply targets, mention targets, edit targets). This map
 * remembers which memory id a given source URI landed as, so later events can
 * edge against it — and so re-emitted events dedupe instead of re-storing.
 *
 * Disk-backed JSON with atomic writes (temp file + rename, same pattern as
 * the shared filesystem queue) so a crash mid-write never corrupts the map.
 */
export class IdMap {
  private constructor(
    private readonly filePath: string,
    private readonly entries: Map<string, number>,
  ) {}

  /** Open (or create) the map at `filePath`, loading any existing entries. */
  static async open(filePath: string): Promise<IdMap> {
    let entries = new Map<string, number>();
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        entries = new Map(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, number] => Number.isInteger(e[1]),
          ),
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return new IdMap(filePath, entries);
  }

  get(uri: string): number | undefined {
    return this.entries.get(uri);
  }

  has(uri: string): boolean {
    return this.entries.has(uri);
  }

  /** Record a mapping and persist the whole map atomically. */
  async set(uri: string, id: number): Promise<void> {
    this.entries.set(uri, id);
    await this.persist();
  }

  get size(): number {
    return this.entries.size;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const doc = Object.fromEntries(this.entries);
    const tmp = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(doc), "utf8");
    await rename(tmp, this.filePath);
  }
}
