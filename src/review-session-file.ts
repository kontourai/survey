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

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ReviewQueueSessionState } from "./review-workbench/review-queue-session.js";
import type { ReviewSessionEvent } from "./review-resource.js";
import { defaultReviewSessionName } from "./review-workbench/review-queue-session.js";

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
/** A lock file that is still empty this long after creation was left by an acquirer that died between create and write. */
const EMPTY_LOCK_STALE_MS = 1_000;
/** The break mutex is held for a few milliseconds; older means its holder died mid-break. */
const BREAK_MUTEX_STALE_MS = 5_000;
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

/**
 * An identity for the process currently running as `pid`: its start time, as
 * the OS reports it. A pid can be reused after its holder dies, so a live pid
 * only proves the holder is alive when the start time also matches the one
 * the holder recorded (kontourai/survey#298). Linux reads `/proc/<pid>/stat`
 * field 22 (start time in clock ticks since boot); elsewhere `ps -o lstart=`
 * (one-second resolution), rendered in UTC with the C locale so every reader
 * spells the same instant the same way whatever its own TZ or locale. Resolves `undefined` when the platform offers
 * neither or the process is gone, which leaves the pid-only rule in force.
 */
async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const procStat = await readFile(`/proc/${pid}/stat`, "utf8");
      // Fields after the parenthesized command name, which may contain spaces.
      const fields = procStat.slice(procStat.lastIndexOf(")") + 2).split(" ");
      const startTicks = fields[19];
      return startTicks ? `linux-starttime:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") return undefined;
  return new Promise((resolveIdentity) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 2_000 }, (error, stdout) => {
      const started = error ? "" : stdout.trim().replace(/\s+/g, " ");
      resolveIdentity(started ? `ps-lstart:${started}` : undefined);
    });
  });
}

let ownStartIdentity: Promise<string | undefined> | undefined;

/**
 * A lock is stale only when we can show its holder is gone, never merely
 * because it is old. Liveness is authoritative whenever the lock carries a
 * usable pid: a holder that is alive but slow (age past `staleMs`) is NOT
 * stale — age alone used to be enough to break it, which let a live-but-slow
 * holder's lock be removed out from under it (kontourai/survey#281 review:
 * 135 double-hold events in 60 rounds of the reviewer's stress test). We
 * deliberately do not add a hard age ceiling that overrides a live pid: with
 * the default timeoutMs (10s) well under the default staleMs (30s), a waiter
 * simply times out with {@link ReviewSessionFileLockTimeoutError} against a
 * live holder that never releases in time, which is a loud, safe failure
 * mode rather than a silent double-hold. A genuinely wedged holder (hung
 * forever) requires an operator to remove the lock file by hand; that is the
 * accepted cost of "never remove a live lock" actually holding.
 *
 * The age rule is kept only as the fallback for a lock we cannot judge by
 * liveness: no pid field (unknown-PID); a live pid whose current start time
 * differs from the one the holder recorded, i.e. the holder died and its pid
 * was reused by an unrelated process (kontourai/survey#298); or, since the lock carries no host
 * identity, a pid from another host/container sharing this volume (`isPidAlive`
 * is meaningless there, in either direction — the residual this repo has
 * always accepted for that case).
 */
async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    const age = Date.now() - info.mtimeMs;
    const raw = await readFile(lockPath, "utf8");
    if (raw.trim() === "") return age > EMPTY_LOCK_STALE_MS;
    const holder = JSON.parse(raw) as { pid?: unknown; startIdentity?: unknown };
    if (typeof holder.pid === "number") {
      if (!isPidAlive(holder.pid)) return true;
      if (typeof holder.startIdentity !== "string") return false;
      const current = await processStartIdentity(holder.pid);
      // Unknown now (or never recorded): trust liveness, as before.
      if (current === undefined || current === holder.startIdentity) return false;
    }
    return age > staleMs;
  } catch {
    // Vanished (released) or half-written by a live acquirer: not stale.
    return false;
  }
}

/**
 * Remove a stale lock without ever removing a live one.
 *
 * Breakers serialize on a separate `<lock>.break` mutex and re-judge the lock
 * inside it. While a breaker holds the mutex, the lock file can only change if
 * its owner releases it, and {@link lockIsStale} only calls a lock stale once
 * its holder is provably dead (or, lacking a usable pid, sufficiently old), so
 * the file the breaker removes is the one it judged stale. The earlier
 * rename-aside scheme let two waiters that both judged the same lock stale
 * each remove it, the second removing the first's fresh lock
 * (kontourai/survey#281 review). A holder that is merely alive-but-slow is
 * never broken, by construction, no matter its age (see {@link lockIsStale}).
 * Residual (accepted): a breaker that dies inside the few-millisecond break
 * section leaves a mutex that is removed after BREAK_MUTEX_STALE_MS, and pid
 * liveness means nothing across hosts or containers that share the session
 * volume (the age rule is the only signal available there, and it is a
 * pre-existing limitation, not one this fix introduces).
 */
async function breakStaleLock(lockPath: string, staleMs: number): Promise<void> {
  const breakPath = `${lockPath}.break`;
  try {
    await (await open(breakPath, "wx")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      if (Date.now() - (await stat(breakPath)).mtimeMs > BREAK_MUTEX_STALE_MS) {
        await rm(breakPath, { force: true });
      }
    } catch {
      // Released meanwhile.
    }
    return;
  }
  try {
    if (await lockIsStale(lockPath, staleMs)) {
      await rm(lockPath, { force: true });
    }
  } finally {
    await rm(breakPath, { force: true });
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
  ownStartIdentity ??= processStartIdentity(process.pid);
  const startIdentity = await ownStartIdentity;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, ...(startIdentity ? { startIdentity } : {}), token, acquiredAt: new Date().toISOString() }));
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
      await breakStaleLock(lockPath, staleMs);
      continue;
    }

    if (Date.now() >= deadline) {
      throw new ReviewSessionFileLockTimeoutError(lockPath, timeoutMs);
    }
    const delay = RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
}

function tempFilePattern(sessionPath: string): RegExp {
  const escaped = basename(sessionPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`);
}

/**
 * Remove temp files a crashed writer left between write and rename. Called
 * only while holding the lock, when no other writer can have a temp file in
 * flight, so every match is an orphan.
 */
async function removeOrphanTempFiles(sessionPath: string): Promise<void> {
  const pattern = tempFilePattern(sessionPath);
  let entries: string[];
  try {
    entries = await readdir(dirname(sessionPath));
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => pattern.test(entry)).map((entry) => rm(join(dirname(sessionPath), entry), { force: true })));
}

async function writeReviewSessionFileAtomic(sessionPath: string, content: ReviewSessionFileContent): Promise<void> {
  const tmp = `${sessionPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(JSON.stringify(content, null, 2), "utf8");
      // Durable before it becomes visible: a crash after the rename must not
      // leave a renamed but empty or partial session file.
      await handle.sync();
    } finally {
      await handle.close();
    }
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
    await removeOrphanTempFiles(sessionPath);
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

/**
 * The session name the stored log is recorded under: the name its events
 * already carry, else the stored ReviewSession's name, else `fallback` (the
 * writer's own default). Appended events are renamed into it so one log never mixes names.
 */
export function storedReviewSessionName(
  content: ReviewSessionFileContent,
  fallback: string = defaultReviewSessionName,
): string {
  const fromEvents = content.events[0]?.spec.sessionName;
  if (fromEvents) return fromEvents;
  const session = content.session as { metadata?: { name?: unknown } } | undefined;
  return typeof session?.metadata?.name === "string" ? session.metadata.name : fallback;
}

/**
 * Append events to the stored log, renumbering them after the stored events
 * and renaming them into the stored session. The stored log is never
 * rewritten, so decision reversals and note changes stay on record.
 */
export function appendReviewSessionEvents(
  content: ReviewSessionFileContent,
  appended: readonly ReviewSessionEvent[],
): ReviewSessionEvent[] {
  const sessionName = storedReviewSessionName(content);
  const start = content.events.length;
  const renumbered = [...appended]
    .sort((left, right) => left.spec.sequence - right.spec.sequence)
    .map((event, index): ReviewSessionEvent => {
      const sequence = start + index + 1;
      return {
        ...event,
        metadata: { ...event.metadata, name: `${sessionName}-${String(sequence).padStart(4, "0")}-${event.spec.eventType}` },
        spec: { ...event.spec, sessionName, sequence },
      };
    });
  return [...content.events, ...renumbered];
}
