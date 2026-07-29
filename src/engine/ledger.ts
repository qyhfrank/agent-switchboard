import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './shapes.js';

/**
 * Machine-local ownership ledger in the state dir: proof this machine wrote a
 * specific slice, plus the run lock and last-run record. Fail closed: an
 * unreadable or corrupt ledger grants no authority anywhere it covers, and the
 * run aborts before any write.
 */

export type Provenance = 'written' | 'marker' | 'identity' | 'peer-record' | 'convention';

export interface LedgerEntry {
  app: string;
  type: string;
  /** Component id, or null for an aggregate slice (the composed rules block). */
  id: string | null;
  /** Absolute target path as declared by the table. */
  path: string;
  shape: 'own-file' | 'own-dir' | 'region' | 'keys';
  /** sha256 of the owned slice bytes as last written or adopted. */
  hash: string;
  /** own-dir only: the bundle-relative files this record proves ownership of. */
  files?: string[];
  /**
   * keys only: the key path this record proves ownership of, one segment per
   * element. Without it the hash proves a slice the planner cannot re-locate,
   * and removal cannot know which key to reclaim.
   */
  keys?: string[];
  /** Project MCP only: the peer schema's on-disk identity, never an @array address. */
  serverKey?: string;
  provenance: Provenance;
  updatedAt: string;
}

export interface LastRun {
  at: string;
  summary: string;
}

export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
  lastRun?: LastRun;
}

export class LedgerError extends Error {
  readonly exitCode = 2;
}

export function ledgerPath(stateHome: string): string {
  return path.join(stateHome, 'ledger.json');
}

export function ledgerKey(entry: Pick<LedgerEntry, 'app' | 'type' | 'id' | 'path'>): string {
  return [entry.app, entry.type, entry.id ?? '', entry.path].join('\u0000');
}

export function loadLedger(stateHome: string): Ledger {
  const filePath = ledgerPath(stateHome);
  if (!fs.existsSync(filePath)) {
    return { version: 1, entries: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LedgerError(`Ledger at ${filePath} is unreadable (${message}); refusing to proceed.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LedgerError(`Ledger at ${filePath} is corrupt (${message}); refusing to proceed.`);
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new LedgerError(`Ledger at ${filePath} has an unrecognized shape; refusing to proceed.`);
  }

  const candidate = parsed as { entries: unknown[]; lastRun?: unknown };
  for (const entry of candidate.entries) {
    const problem = describeEntryProblem(entry);
    if (problem !== null) {
      throw new LedgerError(
        `Ledger at ${filePath} contains an invalid entry (${problem}); refusing to proceed.`
      );
    }
  }
  if (candidate.lastRun !== undefined) {
    const lastRun = candidate.lastRun as { at?: unknown; summary?: unknown } | null;
    if (
      lastRun === null ||
      typeof lastRun !== 'object' ||
      typeof lastRun.at !== 'string' ||
      typeof lastRun.summary !== 'string'
    ) {
      throw new LedgerError(
        `Ledger at ${filePath} has an unrecognized lastRun record; refusing to proceed.`
      );
    }
  }

  return parsed as Ledger;
}

const PROVENANCES: ReadonlySet<string> = new Set([
  'written',
  'marker',
  'identity',
  'peer-record',
  'convention',
]);
const SHAPES: ReadonlySet<string> = new Set(['own-file', 'own-dir', 'region', 'keys']);

/** A bundle-relative path that cannot leave its root: no absolutes, no `..`. */
function isSafeRel(rel: unknown): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).every((segment) => segment !== '' && segment !== '..');
}

/**
 * Entry-level fail-closed validation: a ledger entry authorizes overwrites
 * and deletions, so a malformed one must abort the run rather than feed the
 * planner shapes it never reasons about (null entries, relative paths,
 * escaping file lists).
 */
function describeEntryProblem(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'not an object';
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.app !== 'string' || record.app.length === 0) return 'app is not a string';
  if (typeof record.type !== 'string' || record.type.length === 0) return 'type is not a string';
  if (record.id !== null && (typeof record.id !== 'string' || record.id.length === 0)) {
    return 'id is neither a string nor null';
  }
  if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) {
    return 'path is not an absolute path';
  }
  if (typeof record.shape !== 'string' || !SHAPES.has(record.shape)) return 'unknown shape';
  if (typeof record.hash !== 'string') return 'hash is not a string';
  if (typeof record.provenance !== 'string' || !PROVENANCES.has(record.provenance)) {
    return 'unknown provenance';
  }
  if (record.files !== undefined) {
    if (record.shape !== 'own-dir') return 'files on a non own-dir entry';
    if (!Array.isArray(record.files) || !record.files.every(isSafeRel)) {
      return 'files contains an unsafe or non-relative path';
    }
  }
  if (record.keys !== undefined) {
    if (record.shape !== 'keys') return 'keys on a non keys entry';
    if (
      !Array.isArray(record.keys) ||
      record.keys.length === 0 ||
      !record.keys.every((segment) => typeof segment === 'string' && segment.length > 0)
    ) {
      return 'keys is not a non-empty key path';
    }
  }
  if (record.shape === 'keys' && record.keys === undefined) return 'keys entry records no key path';
  if (
    record.serverKey !== undefined &&
    (record.shape !== 'keys' || typeof record.serverKey !== 'string')
  ) {
    return 'serverKey on a non keys entry or not a string';
  }
  if (typeof record.updatedAt !== 'string') return 'updatedAt is not a string';
  return null;
}

export function saveLedger(stateHome: string, ledger: Ledger): void {
  fs.mkdirSync(stateHome, { recursive: true });
  writeFileAtomic(ledgerPath(stateHome), `${JSON.stringify(ledger, null, 2)}\n`);
}

const LOCK_STALE_MS = 10 * 60 * 1000;

export interface RunLock {
  release(): void;
}

/** True when the pid recorded in the lock file is a live process. */
function lockHolderAlive(lockFile: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(lockFile, 'utf-8').trim().split(/\s+/)[0] ?? '', 10);
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
 * no cross-machine locking. A lock is stale only when its mtime is old AND
 * its recorded pid is dead; stealing goes through an atomic rename so two
 * reapers can never both unlink their way past each other — exactly one
 * process removes the corpse, and everyone re-contends on O_EXCL create.
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
    let stale = false;
    try {
      stale =
        Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS && !lockHolderAlive(lockFile);
    } catch {
      stale = true;
    }
    if (stale) {
      const reap = `${lockFile}.reap-${process.pid}`;
      try {
        fs.renameSync(lockFile, reap);
        fs.unlinkSync(reap);
      } catch {
        // lost the steal race to another reaper; contend on create below
      }
      fd = tryAcquire();
    }
  }
  if (fd === null) {
    throw new LedgerError(
      `Another asb run appears to be active (${lockFile}); wait for it or remove the stale lock.`
    );
  }

  try {
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  } catch (error) {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // leave the empty lock to the staleness reaper
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }

  return {
    release() {
      try {
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
