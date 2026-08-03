import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './shapes.js';

/**
 * Machine-local run state in the state dir: the lock that serializes runs on
 * one machine, and the fact of the last one. Ownership is not here — it is
 * derived from what the library renders, every run.
 */

export interface LastRun {
  at: string;
  summary: string;
}

export class RunStateError extends Error {
  readonly exitCode = 2;
}

export function lastRunPath(stateHome: string): string {
  return path.join(stateHome, 'last-run.json');
}

/** The last run, or null when there is none this machine can read. */
export function loadLastRun(stateHome: string): LastRun | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lastRunPath(stateHome), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; summary?: unknown };
    return typeof parsed?.at === 'string' && typeof parsed.summary === 'string'
      ? { at: parsed.at, summary: parsed.summary }
      : null;
  } catch {
    return null;
  }
}

export function saveLastRun(stateHome: string, lastRun: LastRun): void {
  fs.mkdirSync(stateHome, { recursive: true });
  writeFileAtomic(lastRunPath(stateHome), `${JSON.stringify(lastRun, null, 2)}\n`);
}

/**
 * The ownership stores a 0.4 install left behind: the entry ledger, the
 * per-project manifests, and the hook peer records. Nothing reads them, and a
 * stale record of who owns what is worse than none, so a real run clears them.
 */
export function clearOwnershipStores(stateHome: string, asbHome: string): void {
  for (const store of [
    path.join(stateHome, 'ledger.json'),
    path.join(asbHome, 'state', 'hooks'),
    path.join(asbHome, 'state', 'manifests'),
  ]) {
    try {
      fs.rmSync(store, { force: true, recursive: true });
    } catch {
      // A store that will not go changes nothing about what this run derives.
    }
  }
}

const LOCK_STALE_MS = 10 * 60 * 1000;

export interface RunLock {
  release(): void;
}

/** True when the pid recorded in one observed lock generation is live. */
function lockHolderAlive(generation: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(generation.trim().split(/\s+/)[0] ?? '', 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else: alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Single O_EXCL lock file serializes same-machine runs; there is deliberately
 * no cross-machine locking and no automatic reaping: any steal of a live path
 * needs an observe-then-displace step that a concurrent O_EXCL creator can
 * interleave with, so a leftover lock fails closed instead. The error names
 * the recorded holder and whether it is still running; a crashed run costs
 * one manual removal.
 */
export function acquireRunLock(stateHome: string): RunLock {
  fs.mkdirSync(stateHome, { recursive: true });
  const lockFile = path.join(stateHome, 'run.lock');

  const tryAcquire = (): number | null => {
    try {
      return fs.openSync(lockFile, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return null;
    }
  };

  let fd = tryAcquire();
  if (fd === null) {
    let observed: string | null = null;
    try {
      observed = fs.readFileSync(lockFile, 'utf-8');
    } catch {
      // The holder released between the failed create and this read; contend
      // once more. Any other read failure keeps the fail-closed error below.
      fd = tryAcquire();
    }
    if (fd === null) {
      const holder = observed?.trim().split(/\s+/)[0];
      const dead =
        observed !== null &&
        !lockHolderAlive(observed) &&
        (() => {
          try {
            return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS;
          } catch {
            return false;
          }
        })();
      throw new RunStateError(
        dead
          ? `Another asb run left ${lockFile} behind: its recorded pid ${holder} is not running. If no asb run is active, remove the file and retry.`
          : `Another asb run appears to be active (${lockFile}); wait for it or remove the stale lock.`
      );
    }
  }

  const generation = `${process.pid} ${new Date().toISOString()}\n`;
  try {
    fs.writeSync(fd, generation);
  } catch (error) {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // an unreadable empty lock still fails closed with the message above
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }

  return {
    release() {
      // The lock is removed only while it still holds this process's own
      // generation: after a manual removal plus a new acquire, unlinking
      // blindly would release a lock some other run now owns.
      try {
        if (fs.readFileSync(lockFile, 'utf-8') !== generation) return;
        fs.unlinkSync(lockFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`warning: could not release ${lockFile}: ${message}\n`);
        }
      }
    },
  };
}
