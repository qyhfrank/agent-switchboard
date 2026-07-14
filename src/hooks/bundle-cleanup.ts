import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BundleDistributionResult } from '../library/distribute-bundle.js';

export interface BundleCleanupDeleteGuard {
  configAliasPath: string;
  configPath: string;
  configHash: string;
  configMode?: number;
  configIdentity?: string;
}

interface BundleDirectoryCleanupOptions<Platform extends string> {
  platform: Platform;
  parentDir: string;
  activeIds: ReadonlySet<string>;
  deleteOnlyBundles?: ReadonlyMap<string, string>;
  dryRun?: boolean;
  verifyCurrent?: () => void;
  updateRetryFingerprint?: (id: string, fingerprint: string) => void;
  deleteGuard?: BundleCleanupDeleteGuard;
}

export function cleanBundleDirectories<Platform extends string>(
  options: BundleDirectoryCleanupOptions<Platform>
): Array<BundleDistributionResult<Platform>> {
  const {
    platform,
    parentDir,
    activeIds,
    deleteOnlyBundles,
    dryRun = false,
    verifyCurrent,
    updateRetryFingerprint,
    deleteGuard,
  } = options;
  const results: Array<BundleDistributionResult<Platform>> = [];
  const parentStat = lstatIfExists(parentDir);
  if (!parentStat) return results;
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return [
      {
        platform,
        targetDir: parentDir,
        status: 'error',
        error: `Failed to scan orphan parent: bundle root changed during cleanup: ${parentDir}`,
      },
    ];
  }
  const parentIdentity = readDirectoryIdentity(parentDir);
  if (!parentIdentity) {
    return [
      {
        platform,
        targetDir: parentDir,
        status: 'error',
        error: `Failed to scan orphan parent: bundle root changed during cleanup: ${parentDir}`,
      },
    ];
  }

  try {
    assertDirectoryIdentity(parentDir, parentIdentity);
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const matchingQuarantinedIds = new Set<string>();
    const managedQuarantinedIdHashes = new Set<string>();
    const cleanupFingerprints = new Map<string, string | undefined>();
    if (deleteOnlyBundles) {
      for (const entry of entries) {
        for (const [id, expectedFingerprint] of deleteOnlyBundles) {
          if (!isQuarantineForBundle(entry.name, id)) continue;
          const fingerprint = captureFingerprintForCleanup(path.join(parentDir, entry.name));
          cleanupFingerprints.set(entry.name, fingerprint);
          if (fingerprint === expectedFingerprint) matchingQuarantinedIds.add(id);
        }
      }
    } else {
      for (const entry of entries) {
        const quarantine = parseQuarantineName(entry.name);
        if (quarantine) managedQuarantinedIdHashes.add(quarantine.idHash);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const quarantine = parseQuarantineName(entry.name);
      if (!deleteOnlyBundles && entry.name.startsWith('.delete.') && !quarantine) continue;
      const ownedId = deleteOnlyBundles
        ? findDeleteOnlyBundleId(entry.name, deleteOnlyBundles)
        : activeIds.has(entry.name)
          ? undefined
          : entry.name;
      if (!ownedId) continue;
      if (deleteOnlyBundles?.has(entry.name) && matchingQuarantinedIds.has(entry.name)) continue;
      if (
        !deleteOnlyBundles &&
        !quarantine &&
        managedQuarantinedIdHashes.has(bundleIdHash(entry.name))
      ) {
        continue;
      }
      const targetPath = path.join(parentDir, entry.name);
      const expectedFingerprint = deleteOnlyBundles?.get(ownedId) ?? quarantine?.fingerprint;
      if (expectedFingerprint !== undefined) {
        const fingerprint = cleanupFingerprints.has(entry.name)
          ? cleanupFingerprints.get(entry.name)
          : captureFingerprintForCleanup(targetPath);
        if (fingerprint !== expectedFingerprint) {
          results.push({
            platform,
            targetDir: targetPath,
            status: 'skipped',
            reason: 'legacy cleanup ownership changed',
            entryId: entry.name,
          });
          continue;
        }
      }
      try {
        if (!dryRun) {
          if (entry.name.startsWith('.delete.')) {
            deleteExistingQuarantine(
              parentDir,
              parentIdentity,
              targetPath,
              expectedFingerprint,
              verifyCurrent,
              deleteGuard
            );
          } else {
            quarantineAndDelete(
              parentDir,
              parentIdentity,
              targetPath,
              ownedId,
              expectedFingerprint,
              verifyCurrent,
              deleteGuard
            );
          }
        }
        results.push({
          platform,
          targetDir: targetPath,
          status: 'deleted',
          reason: 'orphan',
          entryId: entry.name,
        });
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        if (error instanceof BundleCleanupRetryError && updateRetryFingerprint) {
          try {
            updateRetryFingerprint(ownedId, error.fingerprint);
          } catch (updateError) {
            message = `${message}; cleanup retry state update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`;
          }
        }
        results.push({
          platform,
          targetDir: targetPath,
          status: 'error',
          error: `Failed to delete orphan: ${message}`,
          entryId: entry.name,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      platform,
      targetDir: parentDir,
      status: 'error',
      error: `Failed to scan orphan parent: ${message}`,
    });
  }
  return results;
}

export function removeBundleTree(targetPath: string): void {
  const stat = lstatIfExists(targetPath);
  if (!stat) return;
  fs.rmSync(targetPath, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: false });
}

class BundleCleanupRetryError extends Error {
  constructor(
    message: string,
    readonly fingerprint: string
  ) {
    super(message);
  }
}

export function captureBundleTreeFingerprint(targetPath: string): string | undefined {
  const first = captureBundleTreeFingerprintOnce(targetPath);
  const second = captureBundleTreeFingerprintOnce(targetPath);
  if (first !== second)
    throw new Error(`bundle path changed while capturing cleanup state: ${targetPath}`);
  return second;
}

export function captureBundleCleanupEntries(
  parentDir: string,
  bundleIds: readonly string[]
): Array<{ id: string; fingerprint: string }> {
  const entries: Array<{ id: string; fingerprint: string }> = [];
  for (const id of bundleIds) {
    const fingerprint = captureBundleTreeFingerprint(path.join(parentDir, id));
    if (fingerprint !== undefined) entries.push({ id, fingerprint });
  }
  return entries;
}

function quarantineAndDelete(
  parentDir: string,
  parentIdentity: string,
  targetPath: string,
  bundleId: string,
  expectedFingerprint?: string,
  verifyCurrent?: () => void,
  deleteGuard?: BundleCleanupDeleteGuard
): void {
  assertDirectoryIdentity(parentDir, parentIdentity);
  const targetIdentity = readPathIdentity(targetPath);
  if (!targetIdentity) return;
  const cleanupFingerprint = expectedFingerprint ?? captureBundleTreeFingerprint(targetPath);
  if (!cleanupFingerprint) return;
  assertBundleFingerprint(targetPath, cleanupFingerprint);
  const quarantinePath = path.join(
    parentDir,
    `.delete.${bundleIdHash(bundleId)}.${cleanupFingerprint}.${randomBytes(12).toString('hex')}`
  );
  fs.renameSync(targetPath, quarantinePath);
  let verified = false;
  try {
    assertDirectoryIdentity(parentDir, parentIdentity);
    assertPathIdentity(quarantinePath, targetIdentity);
    assertBundleFingerprint(quarantinePath, cleanupFingerprint);
    verifyCurrent?.();
    assertDirectoryIdentity(parentDir, parentIdentity);
    assertPathIdentity(quarantinePath, targetIdentity);
    assertBundleFingerprint(quarantinePath, cleanupFingerprint);
    verified = true;
    removeBundleTreeAnchored(
      parentDir,
      parentIdentity,
      quarantinePath,
      targetIdentity,
      cleanupFingerprint,
      deleteGuard
    );
    assertDirectoryIdentity(parentDir, parentIdentity);
  } catch (error) {
    if (!verified) {
      restoreQuarantine(targetPath, quarantinePath, parentDir, parentIdentity, targetIdentity);
    }
    const message = error instanceof Error ? error.message : String(error);
    const retained = lstatIfExists(quarantinePath) ? `; orphan retained at ${quarantinePath}` : '';
    if (verified) {
      const fingerprint = captureFingerprintForCleanup(quarantinePath);
      if (fingerprint && !isAnchoredRemovePreconditionError(error)) {
        throw new BundleCleanupRetryError(`${message}${retained}`, fingerprint);
      }
    }
    throw new Error(`${message}${retained}`);
  }
}

function deleteExistingQuarantine(
  parentDir: string,
  parentIdentity: string,
  quarantinePath: string,
  expectedFingerprint?: string,
  verifyCurrent?: () => void,
  deleteGuard?: BundleCleanupDeleteGuard
): void {
  assertDirectoryIdentity(parentDir, parentIdentity);
  const identity = readPathIdentity(quarantinePath);
  if (!identity) return;
  assertPathIdentity(quarantinePath, identity);
  assertBundleFingerprint(quarantinePath, expectedFingerprint);
  verifyCurrent?.();
  assertDirectoryIdentity(parentDir, parentIdentity);
  assertPathIdentity(quarantinePath, identity);
  assertBundleFingerprint(quarantinePath, expectedFingerprint);
  try {
    removeBundleTreeAnchored(
      parentDir,
      parentIdentity,
      quarantinePath,
      identity,
      expectedFingerprint,
      deleteGuard
    );
  } catch (error) {
    const fingerprint = captureFingerprintForCleanup(quarantinePath);
    if (fingerprint && !isAnchoredRemovePreconditionError(error)) {
      throw new BundleCleanupRetryError(
        error instanceof Error ? error.message : String(error),
        fingerprint
      );
    }
    throw error;
  }
  assertDirectoryIdentity(parentDir, parentIdentity);
}

function isAnchoredRemovePreconditionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  const status = error.status;
  return typeof status === 'number' && status >= 70 && status <= 80;
}

function findDeleteOnlyBundleId(
  entryName: string,
  deleteOnlyBundles: ReadonlyMap<string, string>
): string | undefined {
  if (deleteOnlyBundles.has(entryName)) return entryName;
  for (const id of deleteOnlyBundles.keys()) {
    if (isQuarantineForBundle(entryName, id)) return id;
  }
  return undefined;
}

function captureFingerprintForCleanup(targetPath: string): string | undefined {
  try {
    return captureBundleTreeFingerprint(targetPath);
  } catch {
    return undefined;
  }
}

function assertBundleFingerprint(targetPath: string, expected?: string): void {
  if (expected !== undefined && captureBundleTreeFingerprint(targetPath) !== expected) {
    throw new Error(`bundle contents changed during cleanup: ${targetPath}`);
  }
}

function isQuarantineForBundle(entryName: string, bundleId: string): boolean {
  return entryName.startsWith(`.delete.${bundleIdHash(bundleId)}.`);
}

function parseQuarantineName(
  entryName: string
): { idHash: string; fingerprint: string } | undefined {
  const match = entryName.match(/^\.delete\.([0-9a-f]{64})\.([0-9a-f]{64})\.[0-9a-f]{24}$/i);
  return match
    ? { idHash: match[1].toLowerCase(), fingerprint: match[2].toLowerCase() }
    : undefined;
}

function bundleIdHash(bundleId: string): string {
  return createHash('sha256').update(bundleId).digest('hex');
}

function restoreQuarantine(
  targetPath: string,
  quarantinePath: string,
  parentDir: string,
  parentIdentity: string,
  quarantineIdentity: string
): void {
  try {
    assertDirectoryIdentity(parentDir, parentIdentity);
    if (!lstatIfExists(targetPath)) {
      assertPathIdentity(quarantinePath, quarantineIdentity);
      fs.renameSync(quarantinePath, targetPath);
    }
  } catch {}
}

const ANCHORED_REMOVE_SCRIPT = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const name = process.env.ASB_BUNDLE_NAME;
const parentIdentity = process.env.ASB_PARENT_IDENTITY;
const targetIdentity = process.env.ASB_TARGET_IDENTITY;
const expectedFingerprint = process.env.ASB_BUNDLE_FINGERPRINT;
if (!name || name.includes('/') || name.includes('\\')) process.exit(70);
const parent = fs.lstatSync('.');
if (parent.isSymbolicLink() || !parent.isDirectory() ||
    String(parent.dev) + ':' + String(parent.ino) !== parentIdentity) process.exit(71);
const target = fs.lstatSync(name);
if (String(target.dev) + ':' + String(target.ino) + ':' + String(target.mode) !== targetIdentity) {
  process.exit(72);
}

function updateFingerprint(hash, value) {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(buffer.length));
  hash.update(length);
  hash.update(buffer);
}

function pathIdentity(stat) {
  return String(stat.dev) + ':' + String(stat.ino) + ':' + String(stat.mode);
}

function captureBundleFingerprint(rootPath) {
  const hash = crypto.createHash('sha256');
  const visit = (currentPath, relativePath) => {
    const before = fs.lstatSync(currentPath);
    updateFingerprint(hash, relativePath);
    updateFingerprint(hash, pathIdentity(before));
    if (before.isSymbolicLink()) {
      updateFingerprint(hash, 'symlink');
      updateFingerprint(hash, fs.readlinkSync(currentPath));
    } else if (before.isDirectory()) {
      updateFingerprint(hash, 'directory');
      const names = fs.readdirSync(currentPath).sort();
      updateFingerprint(hash, JSON.stringify(names));
      for (const child of names) {
        visit(path.join(currentPath, child), relativePath ? relativePath + '/' + child : child);
      }
    } else if (before.isFile()) {
      updateFingerprint(hash, 'file');
      let fd;
      try {
        fd = fs.openSync(currentPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd);
        if (pathIdentity(opened) !== pathIdentity(before)) process.exit(73);
        updateFingerprint(hash, fs.readFileSync(fd));
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    } else {
      updateFingerprint(hash, 'other');
    }
    if (pathIdentity(fs.lstatSync(currentPath)) !== pathIdentity(before)) process.exit(73);
  };
  visit(rootPath, '');
  return hash.digest('hex');
}

function resolveConfigTarget(configAliasPath) {
  const absolute = path.resolve(configAliasPath);
  let root = path.parse(absolute).root;
  let remaining = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let resolved = root;
  let hops = 0;
  while (remaining.length > 0) {
    const segment = remaining.shift();
    const candidate = path.join(resolved, segment);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') return path.join(candidate, ...remaining);
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }
    if (++hops > 40) process.exit(74);
    const targetPath = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
    root = path.parse(targetPath).root;
    remaining = targetPath.slice(root.length).split(path.sep).filter(Boolean).concat(remaining);
    resolved = root;
  }
  return resolved;
}

function captureConfigSnapshot(configPath) {
  let fd;
  try {
    const pathStat = fs.lstatSync(configPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) process.exit(75);
    fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) process.exit(75);
    const hash = crypto.createHash('sha256');
    hash.update('present\0');
    hash.update(fs.readFileSync(fd));
    return {
      hash: hash.digest('hex'),
      mode: String(stat.mode & 0o777),
      identity: String(stat.dev) + ':' + String(stat.ino),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        hash: crypto.createHash('sha256').update('missing\0').digest('hex'),
        mode: '',
        identity: '',
      };
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const configPath = process.env.ASB_CONFIG_PATH;
const configAliasPath = process.env.ASB_CONFIG_ALIAS_PATH;
const configHash = process.env.ASB_CONFIG_HASH;
if (configPath || configAliasPath || configHash) {
  if (!configPath || !configAliasPath || !configHash) process.exit(76);
  if (path.resolve(resolveConfigTarget(configAliasPath)) !== path.resolve(configPath)) process.exit(77);
  const config = captureConfigSnapshot(configPath);
  const expectedMode = process.env.ASB_CONFIG_MODE;
  const expectedIdentity = process.env.ASB_CONFIG_IDENTITY;
  if (config.hash !== configHash ||
      (expectedMode !== '*' && config.mode !== expectedMode) ||
      (expectedIdentity !== '*' && config.identity !== expectedIdentity)) process.exit(78);
}
if (expectedFingerprint && captureBundleFingerprint(name) !== expectedFingerprint) process.exit(79);
const targetAfterChecks = fs.lstatSync(name);
if (pathIdentity(targetAfterChecks) !== targetIdentity) process.exit(80);
fs.rmSync(name, { recursive: target.isDirectory() && !target.isSymbolicLink(), force: false });
`;

function removeBundleTreeAnchored(
  parentDir: string,
  parentIdentity: string,
  targetPath: string,
  targetIdentity: string,
  expectedFingerprint?: string,
  deleteGuard?: BundleCleanupDeleteGuard
): void {
  const name = path.basename(targetPath);
  if (path.dirname(targetPath) !== parentDir || name === '.' || name === '..') {
    throw new Error(`invalid anchored bundle path: ${targetPath}`);
  }
  execFileSync(process.execPath, ['--input-type=commonjs', '-e', ANCHORED_REMOVE_SCRIPT], {
    cwd: parentDir,
    env: {
      ...process.env,
      ASB_BUNDLE_NAME: name,
      ASB_PARENT_IDENTITY: parentIdentity,
      ASB_TARGET_IDENTITY: targetIdentity,
      ...(expectedFingerprint ? { ASB_BUNDLE_FINGERPRINT: expectedFingerprint } : {}),
      ...(deleteGuard
        ? {
            ASB_CONFIG_ALIAS_PATH: deleteGuard.configAliasPath,
            ASB_CONFIG_PATH: deleteGuard.configPath,
            ASB_CONFIG_HASH: deleteGuard.configHash,
            ASB_CONFIG_MODE:
              deleteGuard.configMode === undefined ? '*' : String(deleteGuard.configMode),
            ASB_CONFIG_IDENTITY: deleteGuard.configIdentity ?? '*',
          }
        : {}),
    },
    stdio: 'pipe',
  });
}

function captureBundleTreeFingerprintOnce(targetPath: string): string | undefined {
  const root = lstatIfExists(targetPath);
  if (!root) return undefined;
  const hash = createHash('sha256');
  const visit = (currentPath: string, relativePath: string): void => {
    const before = fs.lstatSync(currentPath);
    updateFingerprint(hash, relativePath);
    updateFingerprint(hash, pathIdentity(before));
    if (before.isSymbolicLink()) {
      updateFingerprint(hash, 'symlink');
      updateFingerprint(hash, fs.readlinkSync(currentPath));
    } else if (before.isDirectory()) {
      updateFingerprint(hash, 'directory');
      const names = fs.readdirSync(currentPath).sort();
      updateFingerprint(hash, JSON.stringify(names));
      for (const name of names) {
        visit(path.join(currentPath, name), relativePath ? `${relativePath}/${name}` : name);
      }
    } else if (before.isFile()) {
      updateFingerprint(hash, 'file');
      let fd: number | undefined;
      try {
        fd = fs.openSync(currentPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd);
        if (pathIdentity(opened) !== pathIdentity(before)) {
          throw new Error(`bundle file changed while capturing cleanup state: ${currentPath}`);
        }
        updateFingerprint(hash, fs.readFileSync(fd));
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    } else {
      updateFingerprint(hash, 'other');
    }
    const after = fs.lstatSync(currentPath);
    if (pathIdentity(after) !== pathIdentity(before)) {
      throw new Error(`bundle path changed while capturing cleanup state: ${currentPath}`);
    }
  };
  visit(targetPath, '');
  return hash.digest('hex');
}

function updateFingerprint(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(buffer.length));
  hash.update(length);
  hash.update(buffer);
}

function pathIdentity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

function readDirectoryIdentity(dirPath: string): string | undefined {
  const stat = lstatIfExists(dirPath);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  return `${stat.dev}:${stat.ino}`;
}

function assertDirectoryIdentity(dirPath: string, expected: string): void {
  if (readDirectoryIdentity(dirPath) !== expected) {
    throw new Error(`bundle root changed during cleanup: ${dirPath}`);
  }
}

function readPathIdentity(filePath: string): string | undefined {
  const stat = lstatIfExists(filePath);
  return stat ? pathIdentity(stat) : undefined;
}

function assertPathIdentity(filePath: string, expected: string): void {
  if (readPathIdentity(filePath) !== expected) {
    throw new Error(`bundle path changed during cleanup: ${filePath}`);
  }
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
