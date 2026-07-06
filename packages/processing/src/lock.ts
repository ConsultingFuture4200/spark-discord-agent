import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * Single-instance advisory lock (LIOTTA-7).
 *
 * The watcher's claim-then-process flow assumes a single writer; two processing
 * instances (e.g. a systemd restart overlapping a `kill -9`ed predecessor) would
 * both select the same `ready-to-process` call and double-post/double-email.
 * Acquiring an exclusive pidfile at startup enforces the single-writer invariant
 * documented in DECISIONS.md; delivery idempotency (persisted `threadId`) is the
 * second line of defence for the reclaim path.
 *
 * The lock is a file created with `O_EXCL`. A leftover lock from a crashed
 * process is stolen only when its PID is no longer alive.
 */

export class LockHeldError extends Error {
  constructor(lockPath: string, pid: string) {
    super(
      `Another processing instance holds the lock at ${lockPath} (pid ${pid}). ` +
        "Refusing to start a second instance.",
    );
    this.name = "LockHeldError";
  }
}

/** True if a process with `pid` is currently alive (signal 0 probes it). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: exists but not ours — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the lock at `lockPath`. Returns a release function that removes it.
 * Throws {@link LockHeldError} if a live instance already holds it.
 */
export function acquireSingleInstanceLock(lockPath: string): () => void {
  const write = (): number => {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return process.pid;
  };

  try {
    write();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = readFileSync(lockPath, "utf8").trim();
    const existingPid = Number.parseInt(existing, 10);
    if (Number.isInteger(existingPid) && isAlive(existingPid)) {
      throw new LockHeldError(lockPath, existing);
    }
    // Stale lock from a dead process: steal it.
    unlinkSync(lockPath);
    write();
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone; nothing to do.
    }
  };
  // Best-effort cleanup if the process exits without an explicit release.
  process.once("exit", release);
  return release;
}
