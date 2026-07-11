import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireFileLock } from '../config/file-lock.js';
import {
  getConfigDir,
  getMarketplacePluginCacheDir,
  getPluginSourceLocksDir,
} from '../config/paths.js';
import { authenticatedGitEnv, credentialFreeGitUrl } from './git-identity.js';
import { marketplaceGitFetchTargets, normalizeMarketplaceGitRef } from './git-ref.js';

export interface MarketplaceEntryCacheRequest {
  sourceName: string;
  marketplacePath: string;
  pluginName: string;
  url: string;
  ref?: string;
  sha?: string;
  subdir?: string;
  ownerIsCurrent?: () => boolean;
}

export interface MarketplaceEntryMaterialization {
  identity: string;
  entryPath: string;
  repoPath: string;
  pluginPath: string;
  commit: string;
}

export interface MarketplaceEntryCacheRefreshResult {
  refreshed: number;
  removed: number;
}

export interface MarketplaceCacheRemovalStage {
  commit: () => void;
  rollback: () => void;
}

export interface MarketplaceCacheRemovalPaths {
  activePath: string;
  stagedPath: string;
}

interface MarketplaceEntryCacheMetadata {
  version: 2;
  generation: number;
  identity: string;
  sourceName: string;
  marketplacePath: string;
  pluginName: string;
  ref?: string;
  sha?: string;
  subdir?: string;
  commit: string;
}

interface MarketplacePathIdentity {
  device: string;
  inode: string;
}

interface MarketplaceMaterializationStageClaim {
  version: 1 | 2 | 3;
  token: string;
  ownerIdentity: string;
  stageName: string;
  binding?: MarketplacePathIdentity;
  stage?: MarketplacePathIdentity;
}

interface MarketplaceMaterializationStageBinding {
  version: 1;
  token: string;
  claim: MarketplacePathIdentity;
  stage: MarketplacePathIdentity;
}

interface MarketplaceMaterializationStage {
  claimPath: string;
  bindingPath: string;
  stagePath: string;
  claimIdentity?: MarketplacePathIdentity;
  bindingIdentity?: MarketplacePathIdentity;
  stageIdentity?: MarketplacePathIdentity;
}

interface MarketplaceCacheLease {
  release: () => void;
  token: symbol;
}

const METADATA_FILE = 'entry.json';
const MATERIALIZATION_STAGE_CLAIM_PREFIX = '.stage-claim-';
const FETCHED_COMMIT_REF = 'refs/asb/marketplace-cache';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const temporaryCacheRoot = new AsyncLocalStorage<string>();
const heldSourceLocks = new Map<string, MarketplaceCacheLease>();
const activeSourceLocks = new Set<string>();
let lockExitHandlerRegistered = false;

function configuredCacheRoot(): string {
  return temporaryCacheRoot.getStore() ?? getMarketplacePluginCacheDir();
}

function runGit(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
  } catch (error) {
    const execError = error as { stderr?: Buffer | string };
    const stderr =
      typeof execError.stderr === 'string'
        ? execError.stderr.trim()
        : (execError.stderr?.toString().trim() ?? '');
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args[0]} failed: ${redactGitCredentials(detail)}`);
  }
}

export function redactGitCredentials(value: string): string {
  return value
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)/gi,
      (_match, scheme: string, authority: string) => {
        const separator = authority.lastIndexOf('@');
        return separator < 0
          ? `${scheme}${authority}`
          : `${scheme}<redacted>@${authority.slice(separator + 1)}`;
      }
    )
    .replace(
      /(^|[\s"'(])[^\s/"'()]+@((?:\[[^\]\s]+\]|[^:\s/"'()]+):[^\s"'()]+)/gi,
      '$1<redacted>@$2'
    )
    .replace(/([?&][^=\s&#]+)=([^&\s#'"]+)/g, '$1=<redacted>')
    .replace(/#[^\s'"]+/g, '#<redacted>');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value: string): string {
  return (value.replace(/[^a-zA-Z0-9_-]/g, '-') || 'entry').slice(0, 48);
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSubdir(value: string | undefined): string | undefined {
  const trimmed = optionalTrimmed(value)?.replaceAll('\\', '/');
  if (!trimmed || trimmed === '.') return undefined;
  if (
    path.posix.isAbsolute(trimmed) ||
    trimmed.startsWith('//') ||
    /^[a-zA-Z]:\//.test(trimmed) ||
    trimmed.includes('\0')
  ) {
    throw new Error(`Marketplace plugin subdirectory must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Marketplace plugin subdirectory escapes the repository: ${value}`);
  }
  return normalized.replace(/^\.\//, '');
}

function normalizeRequest(request: MarketplaceEntryCacheRequest): MarketplaceEntryCacheRequest {
  const sourceName = request.sourceName.trim();
  const marketplacePath = canonicalPath(request.marketplacePath);
  const pluginName = request.pluginName.trim();
  const url = request.url.trim();
  if (!sourceName || !marketplacePath || !pluginName || !url) {
    throw new Error(
      'Marketplace cache source name, marketplace path, plugin name, and URL must be non-empty.'
    );
  }
  const ref = normalizeMarketplaceGitRef(request.ref);
  const sha = optionalTrimmed(request.sha)?.toLowerCase();
  if (sha && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error(`Marketplace plugin SHA must be a full 40- or 64-character object ID: ${sha}`);
  }
  return {
    sourceName,
    marketplacePath,
    pluginName,
    url,
    ref,
    sha,
    subdir: normalizeSubdir(request.subdir),
    ownerIsCurrent: request.ownerIsCurrent,
  };
}

function requestIdentity(request: MarketplaceEntryCacheRequest): string {
  return digest(
    JSON.stringify({
      sourceName: request.sourceName,
      marketplacePath: request.marketplacePath,
      pluginName: request.pluginName,
      url: request.url,
      ref: request.ref ?? null,
      sha: request.sha ?? null,
      subdir: request.subdir ?? null,
    })
  );
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sourceOwnerIdentity(sourceName: string, marketplacePath: string): string {
  return digest(
    JSON.stringify({
      sourceName: sourceName.trim(),
      marketplacePath: canonicalPath(marketplacePath),
    })
  );
}

function sourceCachePath(sourceName: string, marketplacePath: string): string {
  const normalized = sourceName.trim();
  const ownerIdentity = sourceOwnerIdentity(normalized, marketplacePath);
  return path.resolve(
    configuredCacheRoot(),
    `${safeSegment(normalized)}-${ownerIdentity.slice(0, 10)}`
  );
}

function entryCachePath(request: MarketplaceEntryCacheRequest, identity: string): string {
  return path.join(
    sourceCachePath(request.sourceName, request.marketplacePath),
    `${safeSegment(request.pluginName)}-${identity.slice(0, 16)}`
  );
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Marketplace cache path escapes its root: ${target}`);
  }
}

function assertNoCacheSymlinks(root: string, target: string): void {
  assertInside(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Marketplace cache path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function pathIdentity(target: string): MarketplacePathIdentity {
  const stat = fs.lstatSync(target, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function samePathIdentity(left: MarketplacePathIdentity, right: MarketplacePathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function validPathIdentity(value: unknown): value is MarketplacePathIdentity {
  const identity = value as Partial<MarketplacePathIdentity> | null;
  return Boolean(
    identity && /^\d+$/.test(identity.device ?? '') && /^\d+$/.test(identity.inode ?? '')
  );
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeDurableRecord(filePath: string, value: unknown): MarketplacePathIdentity {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  const stat = fs.fstatSync(descriptor, { bigint: true });
  const identity = { device: stat.dev.toString(), inode: stat.ino.toString() };
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!samePathIdentity(pathIdentity(filePath), identity)) {
    throw new Error(`Marketplace cache stage record changed: ${filePath}`);
  }
  syncDirectory(path.dirname(filePath));
  return identity;
}

function rewriteDurableBinding(
  filePath: string,
  value: unknown,
  expectedIdentity: MarketplacePathIdentity
): void {
  const descriptor = fs.openSync(filePath, 'r+');
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const identity = { device: stat.dev.toString(), inode: stat.ino.toString() };
    if (!samePathIdentity(identity, expectedIdentity)) {
      throw new Error(`Marketplace cache stage binding changed: ${filePath}`);
    }
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!samePathIdentity(pathIdentity(filePath), expectedIdentity)) {
    throw new Error(`Marketplace cache stage binding changed: ${filePath}`);
  }
  syncDirectory(path.dirname(filePath));
}

function stagePaths(sourcePath: string, token: string): MarketplaceMaterializationStage {
  const claimPath = path.join(sourcePath, `${MATERIALIZATION_STAGE_CLAIM_PREFIX}${token}.json`);
  return {
    claimPath,
    bindingPath: `${claimPath}.ready`,
    stagePath: path.join(sourcePath, `.tmp-${token}`),
  };
}

function readStageClaim(
  sourcePath: string,
  claimPath: string,
  ownerIdentity: string
): { value: MarketplaceMaterializationStageClaim; identity: MarketplacePathIdentity } | null {
  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedClaimPath = path.resolve(claimPath);
  assertInside(resolvedSourcePath, resolvedClaimPath);
  if (path.dirname(resolvedClaimPath) !== resolvedSourcePath) return null;
  try {
    const stat = fs.lstatSync(resolvedClaimPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const claim = JSON.parse(
      fs.readFileSync(resolvedClaimPath, 'utf-8')
    ) as MarketplaceMaterializationStageClaim;
    if (
      (claim.version !== 1 && claim.version !== 2 && claim.version !== 3) ||
      !UUID_PATTERN.test(claim.token) ||
      claim.ownerIdentity !== ownerIdentity ||
      claim.stageName !== `.tmp-${claim.token}` ||
      (claim.version === 1 && (claim.binding !== undefined || claim.stage !== undefined)) ||
      (claim.version === 2 && (!validPathIdentity(claim.binding) || claim.stage !== undefined)) ||
      (claim.version === 3 &&
        (!validPathIdentity(claim.binding) || !validPathIdentity(claim.stage))) ||
      path.basename(resolvedClaimPath) !==
        `${MATERIALIZATION_STAGE_CLAIM_PREFIX}${claim.token}.json`
    ) {
      return null;
    }
    return { value: claim, identity: pathIdentity(resolvedClaimPath) };
  } catch {
    return null;
  }
}

function readStageBinding(
  bindingPath: string,
  token: string,
  claimIdentity: MarketplacePathIdentity
): { value: MarketplaceMaterializationStageBinding; identity: MarketplacePathIdentity } | null {
  try {
    const stat = fs.lstatSync(bindingPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const binding = JSON.parse(
      fs.readFileSync(bindingPath, 'utf-8')
    ) as MarketplaceMaterializationStageBinding;
    if (
      binding.version !== 1 ||
      binding.token !== token ||
      !validPathIdentity(binding.claim) ||
      !validPathIdentity(binding.stage) ||
      !samePathIdentity(binding.claim, claimIdentity)
    ) {
      return null;
    }
    return { value: binding, identity: pathIdentity(bindingPath) };
  } catch {
    return null;
  }
}

function unlinkIfIdentity(filePath: string, identity: MarketplacePathIdentity): void {
  try {
    if (samePathIdentity(pathIdentity(filePath), identity)) fs.rmSync(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function cleanupMaterializationStage(
  cacheRoot: string,
  sourcePath: string,
  stage: MarketplaceMaterializationStage
): void {
  if (stage.stageIdentity) {
    try {
      const stat = fs.lstatSync(stage.stagePath);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        samePathIdentity(pathIdentity(stage.stagePath), stage.stageIdentity)
      ) {
        assertNoCacheSymlinks(cacheRoot, stage.stagePath);
        if (samePathIdentity(pathIdentity(stage.stagePath), stage.stageIdentity)) {
          fs.rmSync(stage.stagePath, { recursive: true, force: true });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (stage.bindingIdentity) unlinkIfIdentity(stage.bindingPath, stage.bindingIdentity);
  if (stage.claimIdentity) unlinkIfIdentity(stage.claimPath, stage.claimIdentity);
  syncDirectory(sourcePath);
}

function prepareMaterializationStage(
  cacheRoot: string,
  sourcePath: string,
  ownerIdentity: string
): MarketplaceMaterializationStage {
  const token = randomUUID();
  const paths = stagePaths(sourcePath, token);
  assertNoCacheSymlinks(cacheRoot, paths.claimPath);
  assertNoCacheSymlinks(cacheRoot, paths.bindingPath);
  assertNoCacheSymlinks(cacheRoot, paths.stagePath);
  try {
    const bindingIdentity = writeDurableRecord(paths.bindingPath, { version: 0, token });
    paths.bindingIdentity = bindingIdentity;
    fs.mkdirSync(paths.stagePath);
    const stageIdentity = pathIdentity(paths.stagePath);
    paths.stageIdentity = stageIdentity;
    const claim: MarketplaceMaterializationStageClaim = {
      version: 3,
      token,
      ownerIdentity,
      stageName: path.basename(paths.stagePath),
      binding: bindingIdentity,
      stage: stageIdentity,
    };
    const claimIdentity = writeDurableRecord(paths.claimPath, claim);
    paths.claimIdentity = claimIdentity;
    const binding: MarketplaceMaterializationStageBinding = {
      version: 1,
      token,
      claim: claimIdentity,
      stage: stageIdentity,
    };
    rewriteDurableBinding(paths.bindingPath, binding, bindingIdentity);
    const observedClaim = readStageClaim(sourcePath, paths.claimPath, ownerIdentity);
    const observedBinding = observedClaim
      ? readStageBinding(paths.bindingPath, token, observedClaim.identity)
      : null;
    if (
      !observedClaim ||
      !samePathIdentity(observedClaim.identity, claimIdentity) ||
      observedClaim.value.version !== 3 ||
      !observedClaim.value.binding ||
      !observedClaim.value.stage ||
      !samePathIdentity(observedClaim.value.binding, bindingIdentity) ||
      !samePathIdentity(observedClaim.value.stage, stageIdentity) ||
      !observedBinding ||
      !samePathIdentity(observedBinding.identity, bindingIdentity) ||
      !samePathIdentity(observedBinding.value.claim, claimIdentity) ||
      !samePathIdentity(observedBinding.value.stage, stageIdentity) ||
      !samePathIdentity(pathIdentity(paths.stagePath), stageIdentity)
    ) {
      throw new Error(`Marketplace cache stage claim changed: ${paths.stagePath}`);
    }
    return paths;
  } catch (error) {
    cleanupMaterializationStage(cacheRoot, sourcePath, paths);
    throw error;
  }
}

function safeCacheRoot(create: boolean): string {
  const override = temporaryCacheRoot.getStore();
  const trustedRoot = path.resolve(override ? path.dirname(override) : getConfigDir());
  const cacheRoot = path.resolve(configuredCacheRoot());
  assertInside(trustedRoot, cacheRoot);
  let current = trustedRoot;
  for (const segment of path.relative(trustedRoot, cacheRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Marketplace cache root contains a symbolic link: ${current}`);
    }
  }
  if (create) fs.mkdirSync(cacheRoot, { recursive: true });
  return cacheRoot;
}

function safeSourceLockRoot(create: boolean): string {
  const trustedRoot = path.resolve(getConfigDir());
  const lockRoot = path.resolve(getPluginSourceLocksDir());
  assertInside(trustedRoot, lockRoot);
  let current = trustedRoot;
  for (const segment of path.relative(trustedRoot, lockRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Plugin source lock root contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (create) fs.mkdirSync(lockRoot, { recursive: true });
  return lockRoot;
}

function sourceLockPath(sourceName: string, marketplacePath: string): string {
  const sourcePath = sourceCachePath(sourceName, marketplacePath);
  return path.resolve(getPluginSourceLocksDir(), `.${path.basename(sourcePath)}.lock`);
}

function acquireSourceLock(sourceName: string, marketplacePath: string): () => void {
  const cacheRoot = safeSourceLockRoot(true);
  const lockPath = sourceLockPath(sourceName, marketplacePath);
  assertNoCacheSymlinks(cacheRoot, lockPath);
  return acquireFileLock(lockPath);
}

export function isTemporaryMarketplaceEntryCache(): boolean {
  return temporaryCacheRoot.getStore() !== undefined;
}

export function releaseMarketplaceCacheLeases(): void {
  for (const [lockPath, lease] of heldSourceLocks) {
    lease.release();
    heldSourceLocks.delete(lockPath);
  }
}

export function captureMarketplaceCacheLeaseSnapshot(): ReadonlySet<symbol> {
  return new Set([...heldSourceLocks.values()].map((lease) => lease.token));
}

export function releaseMarketplaceCacheLeasesAfter(snapshot: ReadonlySet<symbol>): void {
  for (const [lockPath, lease] of heldSourceLocks) {
    if (snapshot.has(lease.token)) continue;
    lease.release();
    heldSourceLocks.delete(lockPath);
  }
}

function retainSourceLock(lockPath: string, release: () => void): void {
  heldSourceLocks.set(lockPath, { release, token: Symbol() });
  if (lockExitHandlerRegistered) return;
  lockExitHandlerRegistered = true;
  process.once('exit', releaseMarketplaceCacheLeases);
}

function withSourceLock<T>(
  sourceName: string,
  marketplacePath: string,
  action: () => T,
  retain = false
): T {
  const lockPath = sourceLockPath(sourceName, marketplacePath);
  if (heldSourceLocks.has(lockPath) || activeSourceLocks.has(lockPath)) return action();
  const release = acquireSourceLock(sourceName, marketplacePath);
  activeSourceLocks.add(lockPath);
  try {
    const result = action();
    activeSourceLocks.delete(lockPath);
    if (retain) retainSourceLock(lockPath, release);
    else release();
    return result;
  } catch (error) {
    activeSourceLocks.delete(lockPath);
    release();
    throw error;
  }
}

export function withMarketplaceSourceLock<T>(
  sourceName: string,
  marketplacePath: string,
  action: () => T
): T {
  const lockPath = sourceLockPath(sourceName, marketplacePath);
  const heldLease = heldSourceLocks.get(lockPath);
  try {
    return withSourceLock(sourceName, marketplacePath, action);
  } finally {
    if (heldLease && heldSourceLocks.get(lockPath) === heldLease) {
      heldLease.release();
      heldSourceLocks.delete(lockPath);
    }
  }
}

export function withMarketplaceSourceReadLease<T>(
  sourceName: string,
  marketplacePath: string,
  ownerIsCurrent: (() => boolean) | undefined,
  action: () => T | null | undefined
): T | null | undefined {
  const lockPath = sourceLockPath(sourceName, marketplacePath);
  if (heldSourceLocks.has(lockPath) || activeSourceLocks.has(lockPath)) {
    if (ownerIsCurrent && !ownerIsCurrent()) {
      throw new Error(`Marketplace source "${sourceName}" is no longer active.`);
    }
    const result = action();
    if (result !== null && result !== undefined && ownerIsCurrent && !ownerIsCurrent()) {
      throw new Error(`Marketplace source "${sourceName}" is no longer active.`);
    }
    return result;
  }
  const release = acquireSourceLock(sourceName, marketplacePath);
  activeSourceLocks.add(lockPath);
  try {
    if (ownerIsCurrent && !ownerIsCurrent()) {
      throw new Error(`Marketplace source "${sourceName}" is no longer active.`);
    }
    const result = action();
    if (result === null || result === undefined) {
      release();
      return result;
    }
    if (ownerIsCurrent && !ownerIsCurrent()) {
      throw new Error(`Marketplace source "${sourceName}" is no longer active.`);
    }
    retainSourceLock(lockPath, release);
    return result;
  } catch (error) {
    release();
    throw error;
  } finally {
    activeSourceLocks.delete(lockPath);
  }
}

export function stageMarketplaceEntryCacheRemoval(
  sourceName: string,
  marketplacePath: string,
  preparedPaths?: MarketplaceCacheRemovalPaths
): MarketplaceCacheRemovalStage {
  const cacheRoot = safeCacheRoot(false);
  const sourcePath = preparedPaths?.activePath ?? sourceCachePath(sourceName, marketplacePath);
  if (!fs.existsSync(sourcePath)) {
    return { commit: () => {}, rollback: () => {} };
  }
  if (preparedPaths) {
    assertMarketplaceEntryCacheRemovalPaths(sourceName, marketplacePath, preparedPaths);
  } else {
    assertNoCacheSymlinks(cacheRoot, sourcePath);
  }
  const stagedPath =
    preparedPaths?.stagedPath ??
    path.join(cacheRoot, `.removing-${path.basename(sourcePath)}-${randomUUID()}`);
  assertNoCacheSymlinks(cacheRoot, stagedPath);
  fs.renameSync(sourcePath, stagedPath);
  let staged = true;
  return {
    commit: () => {
      if (!staged) return;
      fs.rmSync(stagedPath, { recursive: true, force: true });
      staged = false;
    },
    rollback: () => {
      if (!staged) return;
      if (fs.existsSync(sourcePath)) {
        throw new Error(`Marketplace cache rollback target already exists: ${sourcePath}`);
      }
      fs.renameSync(stagedPath, sourcePath);
      staged = false;
    },
  };
}

export function marketplaceEntryCacheRemovalPaths(
  sourceName: string,
  marketplacePath: string,
  transactionId: string
): MarketplaceCacheRemovalPaths {
  const cacheRoot = safeCacheRoot(false);
  const activePath = sourceCachePath(sourceName, marketplacePath);
  const stagedPath = path.join(
    cacheRoot,
    `.removing-${path.basename(activePath)}-${safeSegment(transactionId)}`
  );
  assertNoCacheSymlinks(cacheRoot, activePath);
  assertNoCacheSymlinks(cacheRoot, stagedPath);
  return { activePath, stagedPath };
}

export function assertMarketplaceEntryCacheRemovalPaths(
  sourceName: string,
  marketplacePath: string,
  paths: MarketplaceCacheRemovalPaths
): void {
  const cacheRoot = safeCacheRoot(false);
  const expectedActive = sourceCachePath(sourceName, marketplacePath);
  if (
    path.resolve(paths.activePath) !== path.resolve(expectedActive) ||
    path.dirname(path.resolve(paths.stagedPath)) !== cacheRoot ||
    !path.basename(paths.stagedPath).startsWith(`.removing-${path.basename(expectedActive)}-`)
  ) {
    throw new Error(`Invalid marketplace cache recovery paths for source "${sourceName}".`);
  }
  assertNoCacheSymlinks(cacheRoot, paths.activePath);
  assertNoCacheSymlinks(cacheRoot, paths.stagedPath);
}

export function marketplaceEntryCacheExists(sourceName: string, marketplacePath: string): boolean {
  const cacheRoot = safeCacheRoot(false);
  const sourcePath = sourceCachePath(sourceName, marketplacePath);
  if (!fs.existsSync(sourcePath)) return false;
  assertNoCacheSymlinks(cacheRoot, sourcePath);
  return true;
}

function resolveInside(root: string, subdir: string | undefined): string {
  if (!subdir) return root;
  const resolved = path.resolve(root, subdir);
  assertInside(root, resolved);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Marketplace plugin subdirectory was not found after checkout: ${subdir}`);
  }
  const rootReal = fs.realpathSync.native(root);
  const resolvedReal = fs.realpathSync.native(resolved);
  assertInside(rootReal, resolvedReal);
  return resolved;
}

function checkoutRequest(
  request: MarketplaceEntryCacheRequest,
  repoPath: string
): { commit: string; pluginPath: string } {
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(['init'], repoPath);
  const persistedUrl = credentialFreeGitUrl(request.url);
  const transportEnv = authenticatedGitEnv(request.url, persistedUrl);
  runGit(['remote', 'add', 'origin', persistedUrl], repoPath);

  const targets = request.ref ? marketplaceGitFetchTargets(request.ref) : [request.sha ?? 'HEAD'];
  let fetchError: unknown;
  for (const target of targets) {
    const fetchArgs = ['fetch', '--depth', '1'];
    if (request.subdir) fetchArgs.push('--filter=blob:none');
    fetchArgs.push('origin', target);
    try {
      runGit(fetchArgs, repoPath, transportEnv);
      fetchError = undefined;
      break;
    } catch (error) {
      fetchError = error;
    }
  }
  if (fetchError) throw fetchError;
  const commit = runGit(['rev-parse', 'FETCH_HEAD^{commit}'], repoPath);
  fs.rmSync(path.join(repoPath, '.git', 'FETCH_HEAD'), { force: true });
  if (request.sha && commit !== request.sha) {
    throw new Error(
      `Marketplace plugin pin mismatch: ${request.ref ?? 'fetched commit'} resolved to ${commit}, expected ${request.sha}.`
    );
  }
  runGit(['update-ref', FETCHED_COMMIT_REF, commit], repoPath);

  if (request.subdir) {
    runGit(['sparse-checkout', 'init', '--cone'], repoPath);
    runGit(['sparse-checkout', 'set', '--', request.subdir], repoPath);
  }
  runGit(['checkout', '--detach', commit], repoPath, transportEnv);

  return { commit, pluginPath: resolveInside(repoPath, request.subdir) };
}

function readMetadata(entryPath: string): MarketplaceEntryCacheMetadata | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(entryPath, METADATA_FILE), 'utf-8'));
    const generation = value?.generation;
    if (
      value?.version !== 2 ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof value.identity !== 'string' ||
      typeof value.sourceName !== 'string' ||
      typeof value.marketplacePath !== 'string' ||
      typeof value.pluginName !== 'string' ||
      typeof value.commit !== 'string'
    ) {
      return null;
    }
    return { ...value, generation } as MarketplaceEntryCacheMetadata;
  } catch {
    return null;
  }
}

function nextCacheGeneration(sourcePath: string, identity: string): number {
  let current = 0;
  if (!fs.existsSync(sourcePath)) return 1;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadata = readMetadata(path.join(sourcePath, entry.name));
    if (metadata?.identity !== identity) continue;
    current = Math.max(current, metadata.generation);
  }
  if (!Number.isSafeInteger(current + 1)) {
    throw new Error(`Marketplace cache generation overflow: ${sourcePath}`);
  }
  return current + 1;
}

function selectedCheckoutIsClean(repoPath: string, subdir: string | undefined): boolean {
  const pathspec = subdir ? ['--', `:(literal)${subdir}`] : [];
  if (
    runGit(
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', ...pathspec],
      repoPath
    )
  ) {
    return false;
  }
  return runGit(['ls-files', '-v', '-z', ...pathspec], repoPath)
    .split('\0')
    .filter(Boolean)
    .every((entry) => entry.startsWith('H '));
}

function cachedMaterialization(
  request: MarketplaceEntryCacheRequest,
  identity: string,
  entryPath: string
): MarketplaceEntryMaterialization | null {
  const metadata = readMetadata(entryPath);
  const repoPath = path.join(entryPath, 'repo');
  if (
    metadata?.identity !== identity ||
    metadata.sourceName !== request.sourceName ||
    metadata.marketplacePath !== request.marketplacePath ||
    metadata.pluginName !== request.pluginName ||
    metadata.ref !== request.ref ||
    metadata.sha !== request.sha ||
    metadata.subdir !== request.subdir
  ) {
    return null;
  }
  try {
    const gitPath = path.join(repoPath, '.git');
    if (!fs.lstatSync(gitPath).isDirectory()) return null;
    assertNoCacheSymlinks(configuredCacheRoot(), gitPath);
    const expectedRepoPath = fs.realpathSync.native(repoPath);
    const expectedGitPath = fs.realpathSync.native(gitPath);
    if (
      fs.realpathSync.native(runGit(['rev-parse', '--show-toplevel'], repoPath)) !==
      expectedRepoPath
    ) {
      return null;
    }
    if (
      fs.realpathSync.native(runGit(['rev-parse', '--absolute-git-dir'], repoPath)) !==
      expectedGitPath
    ) {
      return null;
    }
    const head = runGit(['rev-parse', 'HEAD'], repoPath);
    const fetchedCommit = runGit(['rev-parse', `${FETCHED_COMMIT_REF}^{commit}`], repoPath);
    if (
      head !== metadata.commit ||
      head !== fetchedCommit ||
      (request.sha && head !== request.sha)
    ) {
      return null;
    }
    if (runGit(['remote', 'get-url', 'origin'], repoPath) !== credentialFreeGitUrl(request.url)) {
      return null;
    }
    if (!selectedCheckoutIsClean(repoPath, request.subdir)) return null;
    return {
      identity,
      entryPath,
      repoPath,
      pluginPath: resolveInside(repoPath, request.subdir),
      commit: metadata.commit,
    };
  } catch {
    return null;
  }
}

function recoverEntryBackup(
  request: MarketplaceEntryCacheRequest,
  identity: string,
  entryPath: string
): MarketplaceEntryMaterialization | null {
  const sourcePath = path.dirname(entryPath);
  const current = cachedMaterialization(request, identity, entryPath);
  const backups: Array<{
    path: string;
    generation: number;
  }> = [];
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.backup-')) continue;
    const backupPath = path.join(sourcePath, entry.name);
    const metadata = readMetadata(backupPath);
    if (metadata?.identity !== identity) continue;
    const backup = cachedMaterialization(request, identity, backupPath);
    if (!backup) continue;
    backups.push({ path: backupPath, generation: metadata.generation });
  }

  if (current) {
    for (const backup of backups) {
      try {
        fs.rmSync(backup.path, { recursive: true, force: true });
      } catch {
        // A valid current generation does not depend on redundant backup cleanup.
      }
    }
    return current;
  }

  const winner = backups.sort(
    (left, right) => right.generation - left.generation || right.path.localeCompare(left.path)
  )[0];
  if (!winner) return null;

  if (fs.existsSync(entryPath)) fs.rmSync(entryPath, { recursive: true, force: true });
  fs.renameSync(winner.path, entryPath);
  const recovered = cachedMaterialization(request, identity, entryPath);
  if (!recovered) {
    if (!fs.existsSync(winner.path) && fs.existsSync(entryPath)) {
      fs.renameSync(entryPath, winner.path);
    }
    throw new Error(`Marketplace cache recovery failed: ${entryPath}`);
  }
  for (const backup of backups) {
    if (backup.path === winner.path) continue;
    try {
      fs.rmSync(backup.path, { recursive: true, force: true });
    } catch {
      // The recovered highest generation remains authoritative.
    }
  }
  return recovered;
}

function replaceEntry(
  tempPath: string,
  entryPath: string,
  verify: () => MarketplaceEntryMaterialization | null
): MarketplaceEntryMaterialization {
  const backupPath = path.join(path.dirname(entryPath), `.backup-${randomUUID()}`);
  const hadEntry = fs.existsSync(entryPath);
  if (hadEntry) fs.renameSync(entryPath, backupPath);
  let materialized: MarketplaceEntryMaterialization;
  try {
    fs.renameSync(tempPath, entryPath);
    const verified = verify();
    if (!verified) throw new Error(`Marketplace cache verification failed: ${entryPath}`);
    materialized = verified;
  } catch (error) {
    if (fs.existsSync(entryPath)) fs.rmSync(entryPath, { recursive: true, force: true });
    if (hadEntry && fs.existsSync(backupPath)) fs.renameSync(backupPath, entryPath);
    throw error;
  }
  if (hadEntry) {
    try {
      fs.rmSync(backupPath, { recursive: true, force: true });
    } catch {
      // The verified replacement remains authoritative; a later run can clean the backup.
    }
  }
  return materialized;
}

function removeSupersededPluginEntries(
  request: MarketplaceEntryCacheRequest,
  keepIdentity: string
): void {
  const sourcePath = sourceCachePath(request.sourceName, request.marketplacePath);
  if (!fs.existsSync(sourcePath)) return;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const entryPath = path.join(sourcePath, entry.name);
    const metadata = readMetadata(entryPath);
    if (metadata?.pluginName !== request.pluginName || metadata.identity === keepIdentity) continue;
    assertNoCacheSymlinks(configuredCacheRoot(), entryPath);
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
}

function removeSupersededPluginBackups(request: MarketplaceEntryCacheRequest): void {
  const sourcePath = sourceCachePath(request.sourceName, request.marketplacePath);
  if (!fs.existsSync(sourcePath)) return;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.backup-')) continue;
    const entryPath = path.join(sourcePath, entry.name);
    const metadata = readMetadata(entryPath);
    if (metadata && metadata.pluginName !== request.pluginName) continue;
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Backups are derived state and can be retried by a later materialization.
    }
  }
}

export function materializeMarketplaceEntry(
  input: MarketplaceEntryCacheRequest,
  options: { refresh?: boolean; ownerIsCurrent?: () => boolean } = {}
): MarketplaceEntryMaterialization {
  const request = normalizeRequest(input);
  const identity = requestIdentity(request);
  const cacheRoot = safeCacheRoot(true);
  const sourcePath = sourceCachePath(request.sourceName, request.marketplacePath);
  const ownerIdentity = sourceOwnerIdentity(request.sourceName, request.marketplacePath);
  const entryPath = entryCachePath(request, identity);
  const ownerIsCurrent = options.ownerIsCurrent ?? request.ownerIsCurrent;

  return withSourceLock(
    request.sourceName,
    request.marketplacePath,
    () => {
      if (ownerIsCurrent && !ownerIsCurrent()) {
        throw new Error(`Marketplace source "${request.sourceName}" is no longer active.`);
      }
      assertNoCacheSymlinks(cacheRoot, sourcePath);
      fs.mkdirSync(sourcePath, { recursive: true });
      assertNoCacheSymlinks(cacheRoot, entryPath);
      const cached = recoverEntryBackup(request, identity, entryPath);
      if (cached && (!options.refresh || request.sha)) {
        removeSupersededPluginBackups(request);
        return cached;
      }

      const stage = prepareMaterializationStage(cacheRoot, sourcePath, ownerIdentity);
      try {
        const repoPath = path.join(stage.stagePath, 'repo');
        const checkout = checkoutRequest(request, repoPath);
        const metadata: MarketplaceEntryCacheMetadata = {
          version: 2,
          generation: nextCacheGeneration(sourcePath, identity),
          identity,
          sourceName: request.sourceName,
          marketplacePath: request.marketplacePath,
          pluginName: request.pluginName,
          ref: request.ref,
          sha: request.sha,
          subdir: request.subdir,
          commit: checkout.commit,
        };
        fs.writeFileSync(
          path.join(stage.stagePath, METADATA_FILE),
          `${JSON.stringify(metadata, null, 2)}\n`
        );
        if (!cachedMaterialization(request, identity, stage.stagePath)) {
          throw new Error(`Marketplace cache verification failed: ${stage.stagePath}`);
        }
        if (ownerIsCurrent && !ownerIsCurrent()) {
          throw new Error(`Marketplace source "${request.sourceName}" is no longer active.`);
        }
        const materialized = replaceEntry(stage.stagePath, entryPath, () =>
          cachedMaterialization(request, identity, entryPath)
        );
        removeSupersededPluginEntries(request, identity);
        removeSupersededPluginBackups(request);
        return materialized;
      } finally {
        cleanupMaterializationStage(cacheRoot, sourcePath, stage);
      }
    },
    true
  );
}

export function removeMarketplaceEntryCache(sourceName: string, marketplacePath: string): void {
  const cacheRoot = safeCacheRoot(false);
  const sourcePath = sourceCachePath(sourceName, marketplacePath);
  withSourceLock(sourceName, marketplacePath, () => {
    if (!fs.existsSync(sourcePath)) return;
    assertNoCacheSymlinks(cacheRoot, sourcePath);
    fs.rmSync(sourcePath, { recursive: true, force: true });
  });
}

export function refreshMarketplaceEntryCache(
  sourceName: string,
  marketplacePath: string,
  currentRequests: MarketplaceEntryCacheRequest[]
): MarketplaceEntryCacheRefreshResult {
  const cacheRoot = safeCacheRoot(false);
  const canonicalMarketplacePath = canonicalPath(marketplacePath);
  const sourcePath = sourceCachePath(sourceName, canonicalMarketplacePath);
  if (!fs.existsSync(sourcePath)) return { refreshed: 0, removed: 0 };
  assertNoCacheSymlinks(cacheRoot, sourcePath);

  const requests = new Map<string, MarketplaceEntryCacheRequest>();
  for (const input of currentRequests) {
    const source = input.sourceName.trim();
    const root = canonicalPath(input.marketplacePath);
    if (source !== sourceName.trim() || root !== canonicalMarketplacePath) {
      throw new Error('Marketplace cache refresh request does not match its source owner.');
    }
    requests.set(input.pluginName.trim(), input);
  }

  let refreshed = 0;
  let removed = 0;
  const staleEntries: string[] = [];
  const refreshedPlugins = new Set<string>();
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const entryPath = path.join(sourcePath, entry.name);
    if (!fs.existsSync(entryPath)) continue;
    assertNoCacheSymlinks(cacheRoot, entryPath);
    const metadata = readMetadata(entryPath);
    const request = metadata ? requests.get(metadata.pluginName) : undefined;
    if (!request) {
      staleEntries.push(entryPath);
      continue;
    }
    if (refreshedPlugins.has(request.pluginName)) continue;
    materializeMarketplaceEntry(request, { refresh: true });
    refreshedPlugins.add(request.pluginName);
    refreshed++;
  }

  if (staleEntries.length > 0) {
    withSourceLock(sourceName, canonicalMarketplacePath, () => {
      for (const entryPath of staleEntries) {
        if (!fs.existsSync(entryPath)) continue;
        assertNoCacheSymlinks(cacheRoot, entryPath);
        const metadata = readMetadata(entryPath);
        if (metadata && requests.has(metadata.pluginName)) continue;
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed++;
      }
    });
  }

  return { refreshed, removed };
}

export async function withTemporaryMarketplaceEntryCache<T>(action: () => Promise<T>): Promise<T> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-marketplace-cache-'));
  const leaseSnapshot = captureMarketplaceCacheLeaseSnapshot();
  const sourceLockRoot = getPluginSourceLocksDir();
  const stateRoot = path.dirname(sourceLockRoot);
  const sourceLockRootExisted = fs.existsSync(sourceLockRoot);
  const stateRootExisted = fs.existsSync(stateRoot);
  try {
    return await temporaryCacheRoot.run(path.join(tempRoot, 'marketplace-plugins'), action);
  } finally {
    releaseMarketplaceCacheLeasesAfter(leaseSnapshot);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (!sourceLockRootExisted) {
      try {
        fs.rmdirSync(sourceLockRoot);
      } catch {}
    }
    if (!stateRootExisted) {
      try {
        fs.rmdirSync(stateRoot);
      } catch {}
    }
  }
}
