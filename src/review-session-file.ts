/**
 * Shared session-file persistence for the local review writers
 * (`survey-review-console` and `survey-review-mcp`).
 *
 * Every write goes through {@link updateReviewSessionFile}, which takes one
 * exclusive lock file next to the session, re-reads the session inside the
 * lock, applies the caller's change, writes a uniquely named temp file and
 * renames it into place. Both writers must use this helper: a lock that only
 * one of them takes still races with the other (kontourai/survey#281).
 */

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import type { ReviewQueueSessionState } from "./review-workbench/review-queue-session.js";
import type { ReviewSessionEvent } from "./review-resource.js";

export interface ReviewSessionFileContent {
  readonly session: unknown;
  readonly snapshot: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
}

export interface ReviewSessionFileLockOptions {
  /** How long to wait for a busy lock before failing. Defaults to 10s. */
  readonly timeoutMs?: number;
  /** A lock older than this is treated as abandoned. Defaults to 30s. */
  readonly staleMs?: number;
}

export class ReviewSessionFileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for session lock ${lockPath}`);
    this.name = "ReviewSessionFileLockTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_MIN_MS = 10;
const RETRY_MAX_MS = 50;

export function reviewSessionLockPath(sessionPath: string): string {
  return `${sessionPath}.lock`;
}

export async function readReviewSessionFile<T extends ReviewSessionFileContent = ReviewSessionFileContent>(
  sessionPath: string,
): Promise<T> {
  return JSON.parse(await readFile(sessionPath, "utf8")) as T;
}

/**
 * Opaque revision token for an event log: a digest of its serialized form.
 * An event count is not enough, because the log is regenerated from session
 * state and a changed decision keeps the count while changing the content.
 */
export function reviewSessionRevision(events: readonly ReviewSessionEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex").slice(0, 32);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > staleMs) return true;
    const holder = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof holder.pid === "number" && !isPidAlive(holder.pid);
  } catch {
    // Vanished (released) or half-written by a live acquirer: not stale.
    return false;
  }
}

/**
 * Acquire the exclusive session lock. Resolves with a release function.
 * Exported so tests can hold the lock and observe that writers wait for it.
 */
export async function acquireReviewSessionFileLock(
  sessionPath: string,
  options: ReviewSessionFileLockOptions = {},
): Promise<() => Promise<void>> {
  const lockPath = reviewSessionLockPath(sessionPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      return async () => {
        // Only remove the lock if it is still ours (a stale-lock breaker may
        // have replaced it after we were presumed dead).
        try {
          const holder = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
          if (holder.token === token) await rm(lockPath, { force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (await lockIsStale(lockPath, staleMs)) {
      // Rename-then-remove so two waiters that both judged it stale do not
      // both delete it. Residual race (accepted): if another waiter breaks the
      // stale lock and a third process acquires a fresh one between our check
      // and this rename, we move the fresh lock aside. This needs a crashed
      // writer plus three contenders within a few milliseconds.
      const aside = `${lockPath}.stale-${token}`;
      try {
        await rename(lockPath, aside);
        await rm(aside, { force: true });
      } catch {
        // Another waiter broke it first.
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new ReviewSessionFileLockTimeoutError(lockPath, timeoutMs);
    }
    const delay = RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
}

async function writeReviewSessionFileAtomic(sessionPath: string, content: ReviewSessionFileContent): Promise<void> {
  const tmp = `${sessionPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(content, null, 2), "utf8");
    await rename(tmp, sessionPath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Locked read-modify-write of a session file. `mutate` receives the content
 * read inside the lock and returns the content to write, or `undefined` to
 * leave the file untouched. Whatever `mutate` throws propagates after the lock
 * is released.
 */
export async function updateReviewSessionFile<T extends ReviewSessionFileContent, R>(
  sessionPath: string,
  mutate: (current: T) => Promise<{ readonly next?: T; readonly result: R }> | { readonly next?: T; readonly result: R },
  options: ReviewSessionFileLockOptions = {},
): Promise<R> {
  const release = await acquireReviewSessionFileLock(sessionPath, options);
  try {
    const current = await readReviewSessionFile<T>(sessionPath);
    const { next, result } = await mutate(current);
    if (next !== undefined) {
      await writeReviewSessionFileAtomic(sessionPath, next);
    }
    return result;
  } finally {
    await release();
  }
}
