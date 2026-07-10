import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface FileLockOwner {
  token: string;
  pid: number;
  startedAt: number;
  processIdentity?: string;
  lockToken?: string;
}

interface FileLockObservation {
  owner: FileLockOwner | null;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
}

const PROCESS_IDENTITY_PREFIX = 'ps-lstart-utc-v1:';
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 25;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const activeLocks = new Set<string>();

function processIdentity(pid: number): string | null {
  try {
    const identity = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    return identity ? `${PROCESS_IDENTITY_PREFIX}${identity}` : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function ownerIsStale(owner: FileLockOwner): boolean {
  if (!processIsAlive(owner.pid)) return true;
  if (!owner.processIdentity?.startsWith(PROCESS_IDENTITY_PREFIX)) return false;
  const identity = processIdentity(owner.pid);
  return identity !== null && identity !== owner.processIdentity;
}

function readOwner(filePath: string): FileLockOwner | null {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Config lock path is a symbolic link: ${filePath}`);
    }
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (
      typeof value?.token !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.startedAt !== 'number' ||
      (value.processIdentity !== undefined && typeof value.processIdentity !== 'string') ||
      (value.lockToken !== undefined && typeof value.lockToken !== 'string')
    ) {
      return null;
    }
    return value as FileLockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function observeLock(lockPath: string): FileLockObservation | null {
  try {
    const stat = fs.lstatSync(lockPath, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`Config lock path is a symbolic link: ${lockPath}`);
    return {
      owner: readOwner(lockPath),
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function observationIsStale(observation: FileLockObservation): boolean {
  if (observation.owner) return ownerIsStale(observation.owner);
  return Date.now() - Number(observation.mtimeNs / 1_000_000n) > LOCK_STALE_MS;
}

function writePreparedOwner(filePath: string, owner: FileLockOwner): void {
  fs.writeFileSync(filePath, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
}

function removeStaleClaim(claimPath: string): void {
  const observed = observeLock(claimPath);
  if (observed && observationIsStale(observed)) {
    fs.rmSync(claimPath, { force: true });
  }
}

function tryRecoverStaleLock(
  lockPath: string,
  claimPath: string,
  observed: FileLockObservation
): boolean {
  const token = randomUUID();
  const preparedClaim = `${claimPath}.${token}.tmp`;
  const owner: FileLockOwner = {
    token,
    pid: process.pid,
    startedAt: Date.now(),
    processIdentity: processIdentity(process.pid) ?? undefined,
    lockToken: observed.owner?.token,
  };
  try {
    writePreparedOwner(preparedClaim, owner);
    try {
      fs.linkSync(preparedClaim, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      removeStaleClaim(claimPath);
      return false;
    }

    const current = observeLock(lockPath);
    if (
      !current ||
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      current.owner?.token !== observed.owner?.token ||
      !observationIsStale(observed)
    ) {
      return false;
    }
    const stalePath = `${lockPath}.stale-${token}`;
    fs.renameSync(lockPath, stalePath);
    fs.rmSync(stalePath, { force: true });
    return true;
  } finally {
    fs.rmSync(preparedClaim, { force: true });
    if (readOwner(claimPath)?.token === token) fs.rmSync(claimPath, { force: true });
  }
}

export function acquireFileLock(lockPath: string): () => void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const preparedPath = `${lockPath}.${token}.tmp`;
  const claimPath = `${lockPath}.recovering`;
  const owner: FileLockOwner = {
    token,
    pid: process.pid,
    startedAt: Date.now(),
    processIdentity: processIdentity(process.pid) ?? undefined,
  };
  writePreparedOwner(preparedPath, owner);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    while (true) {
      removeStaleClaim(claimPath);
      if (!fs.existsSync(claimPath)) {
        try {
          fs.linkSync(preparedPath, lockPath);
          if (fs.existsSync(claimPath)) {
            if (readOwner(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
          } else {
            fs.rmSync(preparedPath, { force: true });
            return () => {
              if (readOwner(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
            };
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }

      const observed = observeLock(lockPath);
      if (observed && observationIsStale(observed)) {
        if (tryRecoverStaleLock(lockPath, claimPath, observed)) continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for config lock: ${lockPath}`);
      }
      Atomics.wait(lockWaitBuffer, 0, 0, LOCK_WAIT_MS);
    }
  } catch (error) {
    fs.rmSync(preparedPath, { force: true });
    throw error;
  }
}

export function withFileLock<T>(lockPath: string, action: () => T): T {
  const normalized = path.resolve(lockPath);
  if (activeLocks.has(normalized)) return action();
  const release = acquireFileLock(normalized);
  activeLocks.add(normalized);
  try {
    return action();
  } finally {
    activeLocks.delete(normalized);
    release();
  }
}
