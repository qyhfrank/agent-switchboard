/**
 * Library source management utilities.
 * Handles adding, removing, and listing external library sources.
 * Supports both local directory paths and remote git repository URLs.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  getConfigLayerLockPath,
  getWritableConfigLayerPath,
  loadConfigLayerFile,
  resolveConfigWritePath,
  updateConfigLayerFile,
  withConfigFileTransaction,
} from '../config/layered-config.js';
import {
  expandHome,
  getConfigDir,
  getMarketplacePluginCacheDir,
  getPluginSourceLocksDir,
  getPluginSourceStateDir,
  getPluginsDir,
} from '../config/paths.js';
import type { RemoteSource, SourceValue } from '../config/schemas.js';
import { type ConfigScope, scopeToLayerOptions } from '../config/scope.js';
import {
  loadSwitchboardConfig,
  loadSwitchboardConfigWithLayers,
} from '../config/switchboard-config.js';
import {
  assertMarketplaceEntryCacheRemovalPaths,
  isTemporaryMarketplaceEntryCache,
  marketplaceEntryCacheExists,
  marketplaceEntryCacheRemovalPaths,
  redactGitCredentials,
  removeMarketplaceEntryCache,
  withMarketplaceSourceLock,
  withMarketplaceSourceReadLease,
} from '../marketplace/cache.js';
import {
  authenticatedGitEnv,
  credentialFreeGitUrl,
  isScpGitUrl,
  normalizeGitIdentity,
} from '../marketplace/git-identity.js';
import { normalizeMarketplaceGitRef } from '../marketplace/git-ref.js';
import {
  getMarketplaceManifestInfo,
  getPluginManifestInfo,
  refreshMarketplacePluginCache,
} from '../marketplace/reader.js';
import {
  beginPluginSourceAddition,
  beginPluginSourceRemoval,
  clearPluginSourceAddition,
  clearPluginSourceRemoval,
  completePluginSourceAddition,
  deletePluginSourceState,
  ensurePluginSourceState,
  listMalformedPluginSourceNamespaceHints,
  listManagedPluginSourceNamespaceHints,
  listPendingPluginSourceTransactions,
  listPluginSourceStates,
  type PluginSourceState,
  pluginSourceStateIsCurrent,
  readPluginSourceState,
  replacePluginSourceState,
  rotatePluginSourceState,
  type SourceAdditionState,
  type SourceCheckoutState,
  type SourcePathIdentity,
  type SourceRemovalPathState,
  type SourceSubtreeState,
  setPluginSourceCheckout,
  setPluginSourceKind,
  setPluginSourceSubtree,
  updatePluginSourceAddition,
} from './source-state.js';

export interface Source {
  namespace: string;
  path: string;
  remote?: RemoteSource;
}

export interface SourceUpdateResult {
  namespace: string;
  url: string;
  status: 'updated' | 'error';
  error?: string;
}

let sourceRevision = 0;

export function getSourceRevision(): number {
  return sourceRevision;
}

function markSourcesChanged(): void {
  sourceRevision++;
}

// ── Git utilities ──────────────────────────────────────────────────

function runGit(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string {
  try {
    return execFileSync('git', args, {
      ...options,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stderr?: Buffer | string };
    const stderr =
      typeof execError.stderr === 'string'
        ? execError.stderr.trim()
        : (execError.stderr?.toString().trim() ?? '');
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args[0]} failed: ${redactGitCredentials(detail)}`);
  }
}

function ensureGitAvailable(): void {
  try {
    runGit(['--version']);
  } catch {
    throw new Error('git is not available. Install git to use remote sources.');
  }
}

function gitClone(url: string, targetDir: string, ref?: string): void {
  if (pathEntryExists(targetDir)) {
    throw new Error(`Managed source staging path already exists: ${targetDir}`);
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  const persistedUrl = credentialFreeGitUrl(url);
  args.push(persistedUrl, targetDir);
  runGit(args, { env: authenticatedGitEnv(url, persistedUrl) });
  runGit(['config', 'remote.origin.url', persistedUrl], { cwd: targetDir });
}

function gitPull(repoDir: string, branch: string | undefined, url: string, ref?: string): void {
  const authenticatedUrl = expandHome(url);
  const persistedUrl = credentialFreeGitUrl(authenticatedUrl);
  const env = authenticatedGitEnv(authenticatedUrl, persistedUrl);
  if (!branch) {
    if (!ref) throw new Error(`Managed source checkout has no updateable branch.`);
    runGit(['fetch', '--depth', '1', 'origin', ref], { cwd: repoDir, env });
    if (
      runGit(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: repoDir }) !==
      runGit(['rev-parse', 'HEAD'], { cwd: repoDir })
    ) {
      throw new Error(`Managed source configured ref changed; remove and add the source again.`);
    }
    return;
  }
  runGit(['pull', '--ff-only', 'origin', branch], { cwd: repoDir, env });
}

function gitSubtreeAdd(
  repoRoot: string,
  prefix: string,
  url: string,
  ref: string,
  transactionId: string
): void {
  const persistedUrl = credentialFreeGitUrl(url);
  runGit(
    [
      'subtree',
      'add',
      '--prefix',
      prefix,
      '--message',
      subtreeAdditionMessage(transactionId),
      persistedUrl,
      ref,
    ],
    { cwd: repoRoot, env: authenticatedGitEnv(url, persistedUrl) }
  );
}

function gitSubtreePull(
  repoRoot: string,
  prefix: string,
  url: string,
  ref: string,
  transactionId: string
): void {
  const persistedUrl = credentialFreeGitUrl(url);
  runGit(
    [
      'subtree',
      'pull',
      '--prefix',
      prefix,
      '--message',
      subtreeAdditionMessage(transactionId),
      persistedUrl,
      ref,
    ],
    { cwd: repoRoot, env: authenticatedGitEnv(url, persistedUrl) }
  );
}

function isGitRepo(dir: string): boolean {
  try {
    const toplevel = runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    return fs.realpathSync.native(toplevel) === fs.realpathSync.native(dir);
  } catch {
    return false;
  }
}

function tryRunGit(args: string[], cwd: string): string | null {
  try {
    return runGit(args, { cwd });
  } catch {
    return null;
  }
}

function symbolicHead(repoRoot: string): string | null {
  return tryRunGit(['symbolic-ref', '-q', 'HEAD'], repoRoot);
}

function subtreeAdditionMessage(transactionId: string): string {
  return `asb source add ${transactionId}`;
}

function withSubtreeRepoLock<T>(repoRoot: string, action: () => T): T {
  return withMarketplaceSourceLock('__asb_subtree_repo__', canonicalSourcePath(repoRoot), action);
}

function assertCheckoutTracksRevision(
  repoDir: string,
  branch: string,
  head: string,
  requireEquality = false
): void {
  const trackingHead = tryRunGit(['rev-parse', `refs/remotes/origin/${branch}^{commit}`], repoDir);
  if (
    !trackingHead ||
    (trackingHead !== head &&
      (requireEquality ||
        tryRunGit(['merge-base', '--is-ancestor', head, trackingHead], repoDir) === null))
  ) {
    throw new Error(`Managed source checkout does not match its configured revision.`);
  }
}

function ensureCleanTree(dir: string, configPaths: string[]): void {
  const args = ['status', '--porcelain'];
  const canonicalDir = fs.realpathSync.native(dir);
  const excludedPaths = [
    getMarketplacePluginCacheDir(),
    getPluginSourceLocksDir(),
    getPluginSourceStateDir(),
    ...configPaths.map(getConfigLayerLockPath),
  ]
    .map((excluded) => path.relative(canonicalDir, canonicalSourcePath(excluded)))
    .filter((relative) => !relative.startsWith('..') && !path.isAbsolute(relative));
  if (excludedPaths.length > 0) {
    args.push(
      '--',
      '.',
      ...excludedPaths.map((relative) => `:(exclude)${relative.split(path.sep).join('/')}`)
    );
  }
  const status = runGit(args, { cwd: dir });
  if (status.length > 0) {
    throw new Error(
      `ASB_HOME has uncommitted changes. Commit or stash them before subtree operations.`
    );
  }
}

function assertManagedPluginsRoot(): string {
  const pluginsRoot = path.resolve(getPluginsDir());
  assertNoOwnedPathSymlinks(path.resolve(getConfigDir()), pluginsRoot);
  if (fs.existsSync(pluginsRoot) && !fs.lstatSync(pluginsRoot).isDirectory()) {
    throw new Error(`Managed plugin root is not a directory: ${pluginsRoot}`);
  }
  return pluginsRoot;
}

function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function configuredCheckoutBranch(repoDir: string, ref: string | undefined): string | undefined {
  const head = runGit(['rev-parse', 'HEAD'], { cwd: repoDir });
  const headRef = symbolicHead(repoDir);
  const normalizedRef = normalizeMarketplaceGitRef(ref);
  if (!normalizedRef || normalizedRef === 'HEAD') {
    if (!headRef?.startsWith('refs/heads/')) {
      throw new Error(
        `Managed source checkout does not have its configured default branch attached.`
      );
    }
    const branch = headRef.slice('refs/heads/'.length);
    const upstream = tryRunGit(['rev-parse', '--symbolic-full-name', '@{upstream}'], repoDir);
    if (upstream !== `refs/remotes/origin/${branch}`) {
      throw new Error(`Managed source checkout is not tracking its configured origin branch.`);
    }
    assertCheckoutTracksRevision(repoDir, branch, head);
    return branch;
  }

  const branch = normalizedRef.startsWith('refs/heads/')
    ? normalizedRef.slice('refs/heads/'.length)
    : normalizedRef.startsWith('refs/')
      ? undefined
      : normalizedRef;
  if (branch && headRef === `refs/heads/${branch}`) {
    assertCheckoutTracksRevision(repoDir, branch, head);
    return branch;
  }

  const tag = normalizedRef.startsWith('refs/tags/')
    ? normalizedRef
    : !normalizedRef.startsWith('refs/')
      ? `refs/tags/${normalizedRef}`
      : undefined;
  const tagHead = tag ? tryRunGit(['rev-parse', `${tag}^{commit}`], repoDir) : null;
  if (!headRef && tagHead === head) return undefined;
  throw new Error(`Managed source checkout does not match configured ref "${ref}".`);
}

function assertManagedCheckoutIdentity(
  repoDir: string,
  url: string,
  ref: string | undefined
): string | undefined {
  assertManagedPluginsRoot();
  assertNoOwnedPathSymlinks(path.resolve(getPluginsDir()), repoDir);
  const gitDir = path.join(repoDir, '.git');
  if (
    !fs.existsSync(repoDir) ||
    !fs.existsSync(gitDir) ||
    !fs.lstatSync(gitDir).isDirectory() ||
    !isGitRepo(repoDir)
  ) {
    throw new Error(`Managed source checkout is incomplete or corrupt: ${repoDir}`);
  }
  const origin = tryRunGit(['config', '--get', 'remote.origin.url'], repoDir);
  if (
    !origin ||
    normalizeGitIdentity(origin, repoDir) !==
      normalizeGitIdentity(credentialFreeGitUrl(expandHome(url)), process.cwd())
  ) {
    throw new Error(`Managed source checkout origin does not match its configured source.`);
  }
  ensureManagedCheckoutClean(repoDir);
  return configuredCheckoutBranch(repoDir, ref);
}

function assertManagedCheckoutCurrent(repoDir: string, branch: string | undefined): void {
  if (!branch) return;
  const head = runGit(['rev-parse', 'HEAD'], { cwd: repoDir });
  assertCheckoutTracksRevision(repoDir, branch, head, true);
}

function cloneDescriptor(state: PluginSourceState): RemoteSource {
  const descriptor = state.descriptor;
  if (
    !descriptor ||
    typeof descriptor === 'string' ||
    descriptor.type !== 'clone' ||
    !isCloneableSource(expandHome(descriptor.url))
  ) {
    throw new Error(`Managed clone descriptor is missing for "${state.namespace}".`);
  }
  return descriptor;
}

function assertStateManagedCheckoutOwnership(
  state: PluginSourceState,
  checkoutPath: string,
  owner: string,
  identity: SourcePathIdentity
): RemoteSource {
  assertOwnedCheckout(checkoutPath, owner, identity);
  const descriptor = cloneDescriptor(state);
  assertManagedCheckoutIdentity(checkoutPath, descriptor.url, descriptor.ref);
  return descriptor;
}

function assertStateManagedCheckout(
  state: PluginSourceState,
  checkoutPath: string,
  owner: string,
  identity: SourcePathIdentity
): void {
  const descriptor = assertStateManagedCheckoutOwnership(state, checkoutPath, owner, identity);
  resolveSourceSubdir(checkoutPath, descriptor.subdir);
}

function ensureManagedCheckoutClean(repoDir: string): void {
  if (
    runGit(
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignored=matching',
        '--',
        '.',
        ':(top,exclude).asb-source-owner',
      ],
      { cwd: repoDir }
    )
  ) {
    throw new Error(`Managed source checkout has local changes: ${repoDir}`);
  }
  assertNormalGitIndex(repoDir);
}

function assertNormalGitIndex(repoDir: string, pathspec?: string): void {
  const args = ['ls-files', '-v', '-z'];
  if (pathspec) args.push('--', pathspec);
  const unexpected = runGit(args, { cwd: repoDir })
    .split('\0')
    .find((entry) => entry && !entry.startsWith('H '));
  if (unexpected) {
    throw new Error(
      `Managed source contains hidden index state: ${unexpected.slice(2) || unexpected}`
    );
  }
}

interface StagedPathRemoval {
  commit: () => void;
  rollback: () => void;
}

function ownedPathRemovalPaths(
  target: string,
  transactionId: string,
  preserve = false
): SourceRemovalPathState {
  const activePath = path.resolve(target);
  return {
    activePath,
    stagedPath: path.join(
      path.dirname(activePath),
      `.${preserve ? 'preserved' : 'removing'}-${path.basename(activePath)}-${transactionId}`
    ),
    ...(preserve ? { preserve: true } : {}),
  };
}

function sourcePathIdentity(target: string): SourcePathIdentity {
  const stat = fs.lstatSync(target, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function sourceStageMarker(stagePath: string): string {
  return path.join(stagePath, '.asb-stage-owner');
}

function sourceCheckoutMarker(checkoutPath: string): string {
  return path.join(checkoutPath, '.asb-source-owner');
}

function assertPlainPath(candidate: string, kind: 'directory' | 'file'): void {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`Managed checkout Git exclude path is invalid: ${candidate}`);
  }
}

function excludeCheckoutMarker(checkoutPath: string): void {
  const checkoutRoot = fs.realpathSync.native(checkoutPath);
  const gitDir = path.join(checkoutPath, '.git');
  const infoDir = path.join(gitDir, 'info');
  const excludePath = path.join(infoDir, 'exclude');
  assertPlainPath(gitDir, 'directory');
  try {
    fs.mkdirSync(infoDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPlainPath(infoDir, 'directory');
  try {
    fs.writeFileSync(excludePath, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPlainPath(excludePath, 'file');
  const gitRoot = fs.realpathSync.native(gitDir);
  if (
    pathEscapes(checkoutRoot, gitRoot) ||
    pathEscapes(gitRoot, fs.realpathSync.native(infoDir)) ||
    pathEscapes(gitRoot, fs.realpathSync.native(excludePath))
  ) {
    throw new Error(`Managed checkout Git exclude path escapes its checkout: ${excludePath}`);
  }
  const line = '.asb-source-owner';
  const current = fs.readFileSync(excludePath, 'utf-8');
  if (!current.split(/\r?\n/).includes(line)) {
    fs.appendFileSync(
      excludePath,
      `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${line}\n`
    );
  }
}

function prepareOwnedStage(root: string, stagePath: string, owner: string): SourcePathIdentity {
  assertNoOwnedPathSymlinks(root, stagePath);
  if (pathEntryExists(stagePath)) {
    throw new Error(`Managed source staging path already exists: ${stagePath}`);
  }
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(stagePath, { recursive: false });
  fs.writeFileSync(sourceStageMarker(stagePath), `${owner}\n`, { flag: 'wx' });
  return sourcePathIdentity(stagePath);
}

function assertOwnedStage(
  root: string,
  stagePath: string,
  owner: string,
  identity: SourcePathIdentity
): void {
  assertNoOwnedPathSymlinks(root, stagePath);
  assertSourcePathIdentity({ activePath: stagePath, stagedPath: stagePath, identity }, stagePath);
  const marker = sourceStageMarker(stagePath);
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf-8') !== `${owner}\n`) {
    throw new Error(`Plugin source staging ownership changed: ${stagePath}`);
  }
}

function assertOwnedCheckout(
  checkoutPath: string,
  owner: string,
  identity: SourcePathIdentity
): void {
  const pluginsRoot = assertManagedPluginsRoot();
  assertNoOwnedPathSymlinks(pluginsRoot, checkoutPath);
  assertSourcePathIdentity(
    { activePath: checkoutPath, stagedPath: checkoutPath, identity },
    checkoutPath
  );
  const marker = sourceCheckoutMarker(checkoutPath);
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf-8') !== `${owner}\n`) {
    throw new Error(`Plugin source checkout ownership changed: ${checkoutPath}`);
  }
}

function removeOwnedStage(
  root: string,
  stagePath: string,
  owner: string,
  identity: SourcePathIdentity
): void {
  if (!pathEntryExists(stagePath)) return;
  assertOwnedStage(root, stagePath, owner, identity);
  fs.rmSync(stagePath, { recursive: true, force: true });
}

function persistRemovalIdentity(paths: SourceRemovalPathState): SourceRemovalPathState {
  return { ...paths, identity: sourcePathIdentity(paths.activePath) };
}

function assertSourcePathIdentity(paths: SourceRemovalPathState, target: string): void {
  if (!paths.identity) {
    throw new Error(`Plugin source recovery ownership is missing: ${target}`);
  }
  const current = sourcePathIdentity(target);
  if (current.device !== paths.identity.device || current.inode !== paths.identity.inode) {
    throw new Error(`Plugin source recovery ownership changed: ${target}`);
  }
}

function ownedPathAdditionPaths(
  namespace: string,
  transactionId: string,
  purpose: 'add' | 'update' = 'add'
): SourceRemovalPathState {
  const activePath = managedCheckoutPath(namespace);
  return {
    activePath,
    stagedPath: path.join(
      path.dirname(activePath),
      `.${purpose === 'add' ? 'adding' : 'updating'}-${path.basename(activePath)}-${transactionId}`
    ),
  };
}

function stageOwnedPathRemoval(paths: SourceRemovalPathState): StagedPathRemoval {
  const { activePath: target, stagedPath } = paths;
  if (!pathEntryExists(target)) throw new Error(`Source removal path is missing: ${target}`);
  assertSourcePathIdentity(paths, target);
  fs.renameSync(target, stagedPath);
  let staged = true;
  return {
    commit: () => {
      if (!staged) return;
      assertSourcePathIdentity(paths, stagedPath);
      if (!paths.preserve) fs.rmSync(stagedPath, { recursive: true, force: true });
      staged = false;
    },
    rollback: () => {
      if (!staged) return;
      if (pathEntryExists(target))
        throw new Error(`Source rollback target already exists: ${target}`);
      assertSourcePathIdentity(paths, stagedPath);
      fs.renameSync(stagedPath, target);
      staged = false;
    },
  };
}

function preservedOwnedPath(target: string): string {
  return path.join(
    path.dirname(target),
    path.basename(target).replace(/^\.(?:adding|updating|removing)-/, '.preserved-')
  );
}

function preserveOwnedPath(target: string): void {
  const preservedPath = preservedOwnedPath(target);
  if (preservedPath === target) return;
  if (pathEntryExists(preservedPath)) {
    throw new Error(`Managed source preserved path already exists: ${preservedPath}`);
  }
  fs.renameSync(target, preservedPath);
}

function ensureRemovalPathStaged(paths: SourceRemovalPathState): boolean {
  const activeExists = pathEntryExists(paths.activePath);
  const stagedExists = pathEntryExists(paths.stagedPath);
  if (activeExists && stagedExists) {
    throw new Error(`Source recovery target already exists: ${paths.activePath}`);
  }
  if (activeExists) {
    assertSourcePathIdentity(paths, paths.activePath);
    fs.renameSync(paths.activePath, paths.stagedPath);
  } else if (!stagedExists) {
    return false;
  }
  assertSourcePathIdentity(paths, paths.stagedPath);
  return true;
}

function disposeManagedCheckout(
  state: PluginSourceState,
  paths: SourceRemovalPathState,
  owner: string,
  identity: SourcePathIdentity
): void {
  if (!ensureRemovalPathStaged(paths) || paths.preserve) return;
  try {
    assertStateManagedCheckoutOwnership(state, paths.stagedPath, owner, identity);
  } catch {
    preserveOwnedPath(paths.stagedPath);
    return;
  }
  assertSourcePathIdentity(paths, paths.stagedPath);
  fs.rmSync(paths.stagedPath, { recursive: true, force: true });
}

// ── URL detection and parsing ──────────────────────────────────────

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/)/.test(source) || isScpGitUrl(source);
}

/**
 * Determine whether an object-format source URL should be treated as a
 * cloneable Git source with a managed checkout rather than a direct local path.
 * Matches: git transport URLs, file:// URIs, and bare-repo paths (ending in .git).
 */
function isCloneableSource(url: string): boolean {
  if (isGitUrl(url)) return true;
  if (/^file:\/\//.test(url)) return true;
  if (url.endsWith('.git')) return true;
  return false;
}

/**
 * Parse a GitHub URL into clone URL + optional ref and subdir.
 * Supported:
 *   https://github.com/org/repo
 *   https://github.com/org/repo/tree/branch
 *   https://github.com/org/repo/tree/branch/sub/dir
 * Non-GitHub git URLs pass through unchanged.
 */
export function parseGitUrl(input: string): { url: string; ref?: string; subdir?: string } {
  const treeMatch = input.match(
    /^(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+))?$/
  );
  if (treeMatch) {
    const result: { url: string; ref?: string; subdir?: string } = {
      url: `${treeMatch[1]}.git`,
      ref: treeMatch[2],
    };
    if (treeMatch[3]) result.subdir = treeMatch[3];
    return result;
  }

  const ghRepo = input.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (ghRepo) {
    return { url: `${ghRepo[1]}.git` };
  }

  return { url: input };
}

/**
 * Infer a namespace from a git URL or local path.
 * Examples:
 *   https://github.com/org/my-repo.git   → "my-repo"
 *   https://github.com/org/repo/tree/main/sub → "repo"
 *   git@github.com:org/repo.git           → "repo"
 *   /path/to/team-library                 → "team-library"
 */
export function inferSourceName(location: string): string {
  if (isGitUrl(location)) {
    const { url } = parseGitUrl(location);
    const httpsMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    const sshMatch = url.match(/:([^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
  }
  return path.basename(path.resolve(location));
}

// ── Config access helpers ──────────────────────────────────────────

function getRawSources(scope?: ConfigScope): Record<string, SourceValue> {
  recoverPendingSourceTransactions();
  const config = loadSwitchboardConfig(scopeToLayerOptions(scope));
  for (const namespace of Object.keys(config.plugins.sources))
    validateConfiguredNamespace(namespace);
  return config.plugins.sources;
}

/**
 * Resolve a local path string using shared rules:
 * - Absolute paths: used as-is
 * - Bare names (no `/`, no `~`): resolve to `~/.asb/plugins/<name>/`
 * - Other relative paths: resolve relative to CWD (legacy)
 */
function resolveLocalPath(expanded: string): string {
  if (path.isAbsolute(expanded)) return expanded;
  if (!expanded.includes('/')) {
    return path.join(getPluginsDir(), expanded);
  }
  return path.resolve(expanded);
}

/**
 * Resolve the effective local path for a plugin source.
 * - Cloneable sources (object with git/file URL or .git suffix): resolve to the managed checkout
 * - Object sources with local path URL: resolve using shared local path rules
 * - String sources: resolve using shared local path rules
 */
function resolveEffectivePath(namespace: string, value: SourceValue): string {
  if (typeof value !== 'string') {
    const expanded = expandHome(value.url);
    if (!isCloneableSource(expanded)) {
      return resolveSourceSubdir(resolveLocalPath(expanded), value.subdir);
    }
    const checkoutPath =
      value.type === 'subtree'
        ? assertManagedSubtreePath(namespace)
        : managedCheckoutPath(namespace);
    return resolveSourceSubdir(checkoutPath, value.subdir);
  }
  return resolveLocalPath(expandHome(value));
}

// ── Validation helpers ─────────────────────────────────────────────

function validateConfiguredNamespace(namespace: string): void {
  if (
    !namespace ||
    namespace === '.' ||
    namespace === '..' ||
    namespace.includes('/') ||
    namespace.includes('\\') ||
    namespace.includes('\0')
  ) {
    throw new Error(`Invalid namespace "${namespace}". Use one safe path segment.`);
  }
}

function validateNewNamespace(namespace: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}". Use only letters, numbers, hyphens, and underscores.`
    );
  }
}

function pathEscapes(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveSourceSubdir(root: string, subdir: string | undefined): string {
  const sourceRoot = path.resolve(root);
  if (!subdir) return sourceRoot;
  const resolved = path.resolve(sourceRoot, subdir);
  if (pathEscapes(sourceRoot, resolved)) {
    throw new Error(`Configured source subdirectory escapes its source checkout: ${subdir}`);
  }
  let existing = resolved;
  while (!pathEntryExists(existing) && existing !== sourceRoot) existing = path.dirname(existing);
  if (!pathEntryExists(sourceRoot)) return resolved;
  try {
    const rootReal = fs.realpathSync.native(sourceRoot);
    const targetReal = fs.realpathSync.native(existing);
    if (pathEscapes(rootReal, targetReal)) {
      throw new Error(`Configured source subdirectory escapes its source checkout: ${subdir}`);
    }
  } catch (error) {
    if (error instanceof Error && /escapes its source checkout/.test(error.message)) throw error;
    throw new Error(
      `Configured source subdirectory cannot be resolved inside its checkout: ${subdir}`
    );
  }
  return resolved;
}

function managedCheckoutPath(namespace: string): string {
  validateConfiguredNamespace(namespace);
  const pluginsRoot = path.resolve(getPluginsDir());
  const checkoutPath = path.resolve(pluginsRoot, namespace);
  if (path.dirname(checkoutPath) !== pluginsRoot) {
    throw new Error(`Managed source checkout must be an immediate child of ${pluginsRoot}.`);
  }
  return checkoutPath;
}

function assertManagedSubtreePath(namespace: string): string {
  const pluginsRoot = assertManagedPluginsRoot();
  const subtreePath = managedCheckoutPath(namespace);
  assertNoOwnedPathSymlinks(pluginsRoot, subtreePath);
  if (pathEntryExists(subtreePath) && !fs.lstatSync(subtreePath).isDirectory()) {
    throw new Error(`Managed subtree source is not a directory: ${subtreePath}`);
  }
  return subtreePath;
}

function ensureNamespaceAvailableCurrent(
  namespace: string,
  configPath: string,
  checkManagedPath = true
): void {
  const configured = loadConfigLayerFile(configPath).config.plugins?.sources ?? {};
  assertManagedPluginsRoot();
  if (
    namespace in configured ||
    (checkManagedPath && pathEntryExists(managedCheckoutPath(namespace)))
  ) {
    throw new Error(
      `Source "${namespace}" already exists. Use a different name or remove it first.`
    );
  }
}

function assertConfiguredCheckoutIfPresent(namespace: string, value: SourceValue): void {
  if (typeof value === 'string' || !isCloneableSource(expandHome(value.url))) {
    return;
  }
  if (value.type === 'subtree') {
    resolveSourceSubdir(assertManagedSubtreePath(namespace), value.subdir);
    return;
  }
  const checkoutPath = managedCheckoutPath(namespace);
  if (pathEntryExists(checkoutPath)) {
    assertManagedCheckoutIdentity(checkoutPath, value.url, value.ref);
  }
}

// ── Auto-discovery ─────────────────────────────────────────────────

function managedLifecycleNamespaces(): Set<string> {
  const managed = listManagedPluginSourceNamespaceHints();
  for (const state of listPluginSourceStates()) {
    if (
      (state.checkout &&
        path.resolve(state.checkout.path) === managedCheckoutPath(state.namespace)) ||
      (state.subtree &&
        path.resolve(state.subtree.repoRoot) === path.resolve(getConfigDir()) &&
        state.subtree.relativePath === `plugins/${state.namespace}`)
    ) {
      managed.add(state.namespace);
    }
  }
  return managed;
}

/**
 * Discover plugin sources from `~/.asb/plugins/`.
 * Each immediate subdirectory (excluding dotfiles) is treated as a source
 * whose namespace equals the directory name.
 */
function discoverLocalSources(): Record<string, string> {
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) return {};

  const result: Record<string, string> = {};
  const managed = managedLifecycleNamespaces();
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (managed.has(entry.name)) continue;
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(pluginsDir, entry.name)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!isDir) continue;
    result[entry.name] = path.join(pluginsDir, entry.name);
  }
  return result;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Get all plugin sources: auto-discovered from `~/.asb/plugins/` merged
 * with explicitly configured `[plugins.<name>] source = "..."` entries. Explicit entries win on conflict.
 */
function collectSources(scope: ConfigScope | undefined, verifyCheckouts: boolean): Source[] {
  const raw = getRawSources(scope);
  const discovered = discoverLocalSources();

  const merged = new Map<string, { value?: SourceValue; path: string }>();

  for (const [ns, effectivePath] of Object.entries(discovered)) {
    merged.set(ns, { path: effectivePath });
  }
  for (const [ns, value] of Object.entries(raw)) {
    if (verifyCheckouts) assertConfiguredCheckoutIfPresent(ns, value);
    merged.set(ns, { value, path: resolveEffectivePath(ns, value) });
  }

  return [...merged.entries()].map(([namespace, entry]) => {
    if (
      entry.value &&
      typeof entry.value !== 'string' &&
      isCloneableSource(expandHome(entry.value.url))
    ) {
      return { namespace, path: entry.path, remote: entry.value };
    }
    return { namespace, path: entry.path };
  });
}

export function getSources(scope?: ConfigScope): Source[] {
  return collectSources(scope, true);
}

/**
 * Get sources as namespace -> effective local path.
 * Merges auto-discovered and explicitly configured sources.
 */
function collectSourcesRecord(
  scope: ConfigScope | undefined,
  verifyCheckouts: boolean
): Record<string, string> {
  const raw = getRawSources(scope);
  const result = discoverLocalSources();
  for (const [namespace, value] of Object.entries(raw)) {
    if (verifyCheckouts) assertConfiguredCheckoutIfPresent(namespace, value);
    result[namespace] = resolveEffectivePath(namespace, value);
  }
  return result;
}

export function getSourcesRecord(scope?: ConfigScope): Record<string, string> {
  return collectSourcesRecord(scope, true);
}

function resolvedSourceOwnerIsCurrent(
  namespace: string,
  expectedPath: string,
  scope: ConfigScope | undefined,
  verifyCheckouts: boolean
): boolean {
  const currentPath = collectSourcesRecord(scope, verifyCheckouts)[namespace];
  if (!currentPath) return false;
  return canonicalSourcePath(currentPath) === canonicalSourcePath(expectedPath);
}

export function sourceOwnerIsCurrent(
  namespace: string,
  expectedPath: string,
  scope?: ConfigScope
): boolean {
  return resolvedSourceOwnerIsCurrent(namespace, expectedPath, scope, true);
}

export function captureSourceOwnerValidator(
  namespace: string,
  expectedPath: string,
  scope?: ConfigScope
): () => boolean {
  const value = getRawSources(scope)[namespace];
  const descriptorKey = sourceDescriptorKey(namespace, value);
  const expectedCanonicalPath = canonicalSourcePath(expectedPath);
  if (isTemporaryMarketplaceEntryCache()) {
    return () =>
      sourceDescriptorKey(namespace, getRawSources(scope)[namespace]) === descriptorKey &&
      sourceOwnerIsCurrent(namespace, expectedCanonicalPath, scope);
  }
  const state = reconcilePluginSourceState(namespace, value, expectedCanonicalPath, scope);
  return () =>
    sourceDescriptorKey(namespace, getRawSources(scope)[namespace]) === descriptorKey &&
    sourceOwnerIsCurrent(namespace, state.marketplacePath, scope) &&
    pluginSourceStateIsCurrent(state);
}

export function recordSourceKind(
  namespace: string,
  expectedPath: string,
  sourceKind: SourceKind,
  scope?: ConfigScope
): void {
  if (isTemporaryMarketplaceEntryCache()) return;
  const value = getRawSources(scope)[namespace];
  const state = reconcilePluginSourceState(
    namespace,
    value,
    canonicalSourcePath(expectedPath),
    scope
  );
  setPluginSourceKind(state, sourceKind);
}

function assertCheckoutProvenance(state: PluginSourceState): SourceCheckoutState {
  const checkout = state.checkout;
  const expectedPath = managedCheckoutPath(state.namespace);
  if (!checkout || path.resolve(checkout.path) !== path.resolve(expectedPath)) {
    throw new Error(`Managed checkout provenance is missing for "${state.namespace}".`);
  }
  assertOwnedCheckout(checkout.path, checkout.owner, checkout.identity);
  return checkout;
}

function ensureCheckoutProvenance(
  state: PluginSourceState,
  url: string,
  ref: string | undefined
): PluginSourceState {
  if (state.checkout) {
    assertCheckoutProvenance(state);
    return state;
  }
  const checkoutPath = managedCheckoutPath(state.namespace);
  assertManagedCheckoutIdentity(checkoutPath, url, ref);
  excludeCheckoutMarker(checkoutPath);
  const markerPath = sourceCheckoutMarker(checkoutPath);
  let owner: string;
  if (pathEntryExists(markerPath)) {
    const marker = fs.lstatSync(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink()) {
      throw new Error(`Managed checkout ownership marker is invalid: ${markerPath}`);
    }
    owner = fs.readFileSync(markerPath, 'utf-8').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)) {
      throw new Error(`Managed checkout ownership marker is invalid: ${markerPath}`);
    }
  } else {
    owner = randomUUID();
    fs.writeFileSync(markerPath, `${owner}\n`, { flag: 'wx' });
  }
  return setPluginSourceCheckout(state, {
    path: checkoutPath,
    owner,
    identity: sourcePathIdentity(checkoutPath),
  });
}

function ensureSubtreeProvenance(state: PluginSourceState): PluginSourceState {
  assertCompatibleSubtreeOwners(state);
  if (state.subtree) {
    assertSubtreeProvenance(state);
    return state;
  }
  const repoRoot = path.resolve(getConfigDir());
  const prefix = `plugins/${state.namespace}`;
  assertManagedSubtreePath(state.namespace);
  const lastPathCommit = tryRunGit(['log', '-1', '--format=%H', '--', prefix], repoRoot);
  const lastSubtreeCommit = tryRunGit(
    [
      'log',
      '-1',
      '--format=%H',
      '--fixed-strings',
      `--grep=git-subtree-dir: ${prefix}`,
      '--',
      prefix,
    ],
    repoRoot
  );
  if (!lastPathCommit || lastPathCommit !== lastSubtreeCommit) {
    throw new Error(`Managed subtree provenance is missing for "${state.namespace}".`);
  }
  const message = runGit(['show', '-s', '--format=%B', lastSubtreeCommit], { cwd: repoRoot });
  const trailers = new Map<string, string>();
  for (const key of ['git-subtree-dir', 'git-subtree-mainline', 'git-subtree-split']) {
    const values = message
      .split('\n')
      .filter((line) => line.startsWith(`${key}: `))
      .map((line) => line.slice(key.length + 2));
    if (values.length !== 1) {
      throw new Error(`Managed subtree provenance is missing for "${state.namespace}".`);
    }
    trailers.set(key, values[0]);
  }
  const mainline = trailers.get('git-subtree-mainline') as string;
  const split = trailers.get('git-subtree-split') as string;
  const parents = runGit(['rev-list', '--parents', '-n', '1', lastSubtreeCommit], {
    cwd: repoRoot,
  }).split(/\s+/);
  if (
    trailers.get('git-subtree-dir') !== prefix ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(mainline) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(split) ||
    parents.length !== 3 ||
    parents[1] !== mainline ||
    parents[2] !== split ||
    subtreeTree(repoRoot, prefix, lastSubtreeCommit) !==
      runGit(['rev-parse', `${split}^{tree}`], { cwd: repoRoot })
  ) {
    throw new Error(`Managed subtree provenance is missing for "${state.namespace}".`);
  }
  return setPluginSourceSubtree(
    state,
    subtreeProvenance(repoRoot, prefix, subtreeTree(repoRoot, prefix))
  );
}

function assertCompatibleSubtreeOwners(state: PluginSourceState): void {
  const descriptor = state.descriptor;
  if (!descriptor || typeof descriptor === 'string' || descriptor.type !== 'subtree') return;
  const expected = sourceManagedCheckoutOwnerIdentity(state.namespace, descriptor);
  const conflict = currentSourceOwners(state.namespace).find((owner) => {
    const identity =
      owner.value === undefined
        ? null
        : sourceManagedCheckoutOwnerIdentity(state.namespace, owner.value);
    return identity !== null && identity !== expected;
  });
  if (conflict) {
    throw new Error(`Managed subtree owner conflicts for "${state.namespace}".`);
  }
}

function retireInactivePluginSourceState(
  namespace: string,
  configPath: string,
  scope?: ConfigScope
): void {
  assertNoMalformedSourceOwnership(namespace);
  const observed = readPluginSourceState(namespace, configPath);
  if (!observed) return;
  const configPaths = sourceConfigPaths(scope, observed.configPath);
  withStableSourceOwners(
    namespace,
    [observed.marketplacePath],
    configPaths,
    (_owners, lockedConfigPaths) => {
      const retire = () =>
        withSourceConfigTransaction(lockedConfigPaths, () => {
          if (
            loadConfigLayerFile(observed.configPath).config.plugins?.sources?.[namespace] !==
            undefined
          ) {
            return;
          }
          const current = readPluginSourceState(namespace, observed.configPath);
          if (!current || current.incarnation !== observed.incarnation) return;
          if (current.addition || current.removal) {
            throw new Error(`Plugin source "${namespace}" has a pending lifecycle transaction.`);
          }
          const survivingOwners = currentSourceOwners(namespace, observed.configPath);
          const retainCache = sourceCacheHasOwner(
            namespace,
            current.marketplacePath,
            survivingOwners
          );
          const retainManagedCheckout = Boolean(
            current.descriptor &&
              sourceManagedCheckoutHasOwner(namespace, current.descriptor, survivingOwners)
          );
          if (
            !retainManagedCheckout &&
            current.subtree &&
            pathEntryExists(path.join(current.subtree.repoRoot, current.subtree.relativePath))
          ) {
            throw new Error(
              `Plugin source "${namespace}" still owns a subtree. Restore its descriptor and remove it first.`
            );
          }
          const transactionId = randomUUID();
          const preparedCache = marketplaceEntryCacheRemovalPaths(
            namespace,
            current.marketplacePath,
            transactionId
          );
          const checkout =
            !retainManagedCheckout && current.checkout && pathEntryExists(current.checkout.path)
              ? assertCheckoutProvenance(current)
              : undefined;
          const removal: NonNullable<PluginSourceState['removal']> = {
            configPath: current.configPath,
            configPaths: lockedConfigPaths,
            ...(!retainCache && pathEntryExists(preparedCache.activePath)
              ? { cache: persistRemovalIdentity(preparedCache) }
              : {}),
            ...(checkout
              ? {
                  checkout: {
                    ...ownedPathRemovalPaths(checkout.path, transactionId),
                    identity: checkout.identity,
                  },
                }
              : {}),
          };
          if (!removal.cache && !removal.checkout) {
            deletePluginSourceState(current);
            return;
          }
          commitInterruptedSourceRemoval(beginPluginSourceRemoval(current, removal));
        });
      if (observed.subtree) withSubtreeRepoLock(observed.subtree.repoRoot, retire);
      else retire();
    }
  );
}

function reconcilePluginSourceState(
  namespace: string,
  descriptor: SourceValue | undefined,
  expectedPath: string,
  scope?: ConfigScope
): PluginSourceState {
  const descriptorKey = sourceDescriptorKey(namespace, descriptor);
  const configPath = sourceOwningConfigPath(namespace, scope);
  let observed = readPluginSourceState(namespace, configPath);
  if (observed?.descriptorKey === descriptorKey && observed.marketplacePath === expectedPath) {
    assertNoMalformedSourceOwnership(namespace);
    return observed;
  }
  if (!observed) {
    observed = withSourceOwnershipLock(namespace, () =>
      ensurePluginSourceState(
        namespace,
        configPath,
        descriptor ?? null,
        descriptorKey,
        expectedPath
      )
    );
    if (observed.descriptorKey === descriptorKey && observed.marketplacePath === expectedPath) {
      return observed;
    }
  }
  const configPaths = sourceConfigPaths(scope, configPath);
  return withStableSourceOwners(
    namespace,
    [expectedPath, ...(observed ? [observed.marketplacePath] : [])],
    configPaths,
    (_owners, lockedConfigPaths) =>
      withSourceConfigTransaction(lockedConfigPaths, () => {
        let state = ensurePluginSourceState(
          namespace,
          configPath,
          descriptor ?? null,
          descriptorKey,
          expectedPath
        );
        if (state.descriptorKey === descriptorKey && state.marketplacePath === expectedPath) {
          return state;
        }
        if (state.addition || state.removal) {
          throw new Error(`Plugin source "${namespace}" has a pending lifecycle transaction.`);
        }
        if (
          sourceDescriptorKey(
            namespace,
            loadSwitchboardConfig(scopeToLayerOptions(scope)).plugins.sources[namespace]
          ) !== descriptorKey ||
          !resolvedSourceOwnerIsCurrent(namespace, expectedPath, scope, false)
        ) {
          throw new Error(`Marketplace source "${namespace}" is no longer active.`);
        }

        const managedPath = managedCheckoutPath(namespace);
        const retainsManagedCheckout = Boolean(
          state.descriptor &&
            descriptor !== undefined &&
            sharesManagedCheckout(namespace, state.descriptor, descriptor)
        );
        const retained: Pick<PluginSourceState, 'checkout' | 'subtree' | 'sourceKind'> = {};
        if (retainsManagedCheckout && descriptor !== undefined && pathEntryExists(managedPath)) {
          if (typeof descriptor !== 'string' && descriptor.type === 'subtree') {
            state = ensureSubtreeProvenance(state);
          } else if (typeof descriptor !== 'string') {
            state = ensureCheckoutProvenance(state, descriptor.url, descriptor.ref);
          }
          if (state.checkout) retained.checkout = state.checkout;
          if (state.subtree) retained.subtree = state.subtree;
        } else {
          const currentPathUsesManagedCheckout = !pathEscapes(managedPath, state.marketplacePath);
          if (pathEntryExists(managedPath) && (state.checkout || currentPathUsesManagedCheckout)) {
            if (state.checkout) assertCheckoutProvenance(state);
            throw new Error(
              `Source "${namespace}" cannot replace its managed checkout while that checkout is owned by ASB.`
            );
          }
          if (
            state.subtree &&
            pathEntryExists(path.join(state.subtree.repoRoot, state.subtree.relativePath))
          ) {
            throw new Error(
              `Source "${namespace}" cannot replace its managed subtree while that subtree is owned by ASB.`
            );
          }
        }

        const sameCacheOwner =
          sourceCacheOwnerIdentity(namespace, state.marketplacePath) ===
          sourceCacheOwnerIdentity(namespace, expectedPath);
        if (sameCacheOwner && state.sourceKind) retained.sourceKind = state.sourceKind;
        if (
          !sameCacheOwner &&
          !sourceCacheHasOwner(
            namespace,
            state.marketplacePath,
            currentSourceOwners(namespace, configPath)
          )
        ) {
          removeMarketplaceEntryCache(namespace, state.marketplacePath);
        }
        return replacePluginSourceState(
          state,
          descriptor ?? null,
          descriptorKey,
          expectedPath,
          retained
        );
      })
  );
}

function canonicalSourcePath(value: string): string {
  const resolved = path.resolve(value);
  let current = resolved;
  const missing: string[] = [];
  try {
    while (!pathEntryExists(current)) {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.unshift(path.basename(current));
      current = parent;
    }
    return path.join(fs.realpathSync.native(current), ...missing);
  } catch {
    return resolved;
  }
}

function sourceDescriptorIdentity(value: SourceValue | undefined): string {
  if (value === undefined) return 'discovered';
  if (typeof value === 'string') return JSON.stringify(['local', value]);
  return JSON.stringify(['remote', value.url, value.type, value.ref ?? null, value.subdir ?? null]);
}

function sourceCacheOwnerIdentity(namespace: string, marketplacePath: string): string {
  return JSON.stringify([namespace, canonicalSourcePath(marketplacePath)]);
}

function sourceManagedCheckoutOwnerIdentity(namespace: string, value: SourceValue): string | null {
  if (typeof value === 'string' || !isCloneableSource(expandHome(value.url))) return null;
  return JSON.stringify([
    'managed',
    canonicalSourcePath(managedCheckoutPath(namespace)),
    value.type,
    normalizeGitIdentity(credentialFreeGitUrl(expandHome(value.url)), process.cwd()),
    normalizeMarketplaceGitRef(value.ref) ?? null,
  ]);
}

function sharesManagedCheckout(namespace: string, left: SourceValue, right: SourceValue): boolean {
  const leftOwner = sourceManagedCheckoutOwnerIdentity(namespace, left);
  return leftOwner !== null && leftOwner === sourceManagedCheckoutOwnerIdentity(namespace, right);
}

function sourceDescriptorKey(namespace: string, value: SourceValue | undefined): string {
  const identity =
    value === undefined
      ? JSON.stringify(['discovered', namespace])
      : sourceDescriptorIdentity(value);
  return createHash('sha256').update(identity).digest('hex');
}

function sourceOwningConfigPath(namespace: string, scope?: ConfigScope): string {
  const options = scopeToLayerOptions(scope);
  const { layers } = loadSwitchboardConfigWithLayers(options);
  for (const layer of [layers.project, layers.profile, layers.user]) {
    if (layer?.config.plugins?.sources && namespace in layer.config.plugins.sources) {
      return resolveConfigWritePath(layer.path);
    }
  }
  return resolveConfigWritePath(getWritableConfigLayerPath(options));
}

function sourceConfigPaths(scope: ConfigScope | undefined, configPath: string): string[] {
  const { layers } = loadSwitchboardConfigWithLayers(scopeToLayerOptions(scope));
  const paths = [layers.project?.path, layers.profile?.path, layers.user.path, configPath]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(resolveConfigWritePath);
  return [...new Set(paths)];
}

interface CurrentSourceOwner {
  state?: PluginSourceState;
  value?: SourceValue;
  marketplacePath: string;
  direct: boolean;
}

function currentRecordedSourceOwner(state: PluginSourceState): CurrentSourceOwner | null {
  if (!state.descriptor) return null;
  const value = loadConfigLayerFile(state.configPath).config.plugins?.sources?.[state.namespace];
  if (value === undefined || sourceDescriptorKey(state.namespace, value) !== state.descriptorKey) {
    return null;
  }
  return { state, value, marketplacePath: state.marketplacePath, direct: false };
}

function currentSourceOwners(namespace: string, excludedConfigPath?: string): CurrentSourceOwner[] {
  const excluded = excludedConfigPath ? resolveConfigWritePath(excludedConfigPath) : undefined;
  const owners = listPluginSourceStates()
    .filter(
      (state) =>
        state.namespace === namespace &&
        (!excluded || resolveConfigWritePath(state.configPath) !== excluded)
    )
    .map(currentRecordedSourceOwner)
    .filter((owner): owner is CurrentSourceOwner => Boolean(owner));
  const directPath = discoverLocalSources()[namespace];
  if (directPath) {
    owners.push({ marketplacePath: canonicalSourcePath(directPath), direct: true });
  }
  return owners;
}

function sourceCacheHasOwner(
  namespace: string,
  marketplacePath: string,
  owners: CurrentSourceOwner[]
): boolean {
  const identity = sourceCacheOwnerIdentity(namespace, marketplacePath);
  return owners.some(
    (owner) => sourceCacheOwnerIdentity(namespace, owner.marketplacePath) === identity
  );
}

function sourceManagedCheckoutHasOwner(
  namespace: string,
  value: SourceValue,
  owners: CurrentSourceOwner[]
): boolean {
  const identity = sourceManagedCheckoutOwnerIdentity(namespace, value);
  return (
    identity !== null &&
    owners.some(
      (owner) =>
        owner.value !== undefined &&
        sourceManagedCheckoutOwnerIdentity(namespace, owner.value) === identity
    )
  );
}

function sourceResourcePaths(namespace: string, extraPaths: string[]): string[] {
  const paths = [
    ...extraPaths,
    ...listPluginSourceStates()
      .filter((state) => state.namespace === namespace)
      .map((state) => state.marketplacePath),
  ];
  const directPath = discoverLocalSources()[namespace];
  if (directPath) paths.push(directPath);
  return [...new Set(paths.map(canonicalSourcePath))];
}

function assertNoMalformedSourceOwnership(namespace: string): void {
  if (listMalformedPluginSourceNamespaceHints().has(namespace)) {
    throw new Error(`Plugin source "${namespace}" has malformed ownership state.`);
  }
}

function withSourceOwnershipLock<T>(namespace: string, action: () => T): T {
  let result: T | undefined;
  withMarketplaceSourceReadLease(
    namespace,
    canonicalSourcePath(managedCheckoutPath(namespace)),
    undefined,
    () => {
      assertNoMalformedSourceOwnership(namespace);
      result = action();
      return undefined;
    }
  );
  return result as T;
}

function withSourceResourceLocks<T>(
  namespace: string,
  resourcePaths: string[],
  action: () => T
): T {
  const physicalPath = canonicalSourcePath(managedCheckoutPath(namespace));
  return withMarketplaceSourceLock(namespace, physicalPath, () => {
    assertNoMalformedSourceOwnership(namespace);
    const paths = sourceResourcePaths(namespace, resourcePaths)
      .filter((candidate) => candidate !== physicalPath)
      .sort();
    const run = (index: number): T =>
      index === paths.length
        ? action()
        : withMarketplaceSourceLock(namespace, paths[index], () => run(index + 1));
    return run(0);
  });
}

function withStableSourceOwners<T>(
  namespace: string,
  resourcePaths: string[],
  configPaths: string[],
  action: (owners: CurrentSourceOwner[], lockedConfigPaths: string[]) => T
): T {
  return withSourceResourceLocks(namespace, resourcePaths, () => {
    const lockedConfigPaths = [
      ...new Set(
        [
          ...configPaths,
          ...listPluginSourceStates()
            .filter((state) => state.namespace === namespace)
            .map((state) => state.configPath),
        ].map(resolveConfigWritePath)
      ),
    ];
    return action(currentSourceOwners(namespace), lockedConfigPaths);
  });
}

function withSourceConfigTransaction<T>(configPaths: string[], action: () => T): T {
  const locks = [...new Set(configPaths.map(resolveConfigWritePath))].sort();
  const run = (index: number): T =>
    index === locks.length
      ? action()
      : withConfigFileTransaction(locks[index], () => run(index + 1));
  return run(0);
}

function effectiveConfiguredSource(
  namespace: string,
  configPaths: string[]
): { configPath: string; value: SourceValue } | null {
  for (const configPath of configPaths) {
    const value = loadConfigLayerFile(configPath).config.plugins?.sources?.[namespace];
    if (value !== undefined) return { configPath: resolveConfigWritePath(configPath), value };
  }
  return null;
}

function transactionSourceIsActive(state: PluginSourceState, configPaths: string[]): boolean {
  const effective = effectiveConfiguredSource(state.namespace, configPaths);
  return (
    effective?.configPath === state.configPath &&
    sourceDescriptorKey(state.namespace, effective.value) === state.descriptorKey
  );
}

function removalOwnerStillConfigured(state: PluginSourceState): boolean {
  const value = loadConfigLayerFile(state.configPath).config.plugins?.sources?.[state.namespace];
  return value !== undefined && sourceDescriptorKey(state.namespace, value) === state.descriptorKey;
}

function sameCheckoutOwner(left: SourceCheckoutState, right: SourceCheckoutState): boolean {
  return (
    canonicalSourcePath(left.path) === canonicalSourcePath(right.path) &&
    left.owner === right.owner &&
    left.identity.device === right.identity.device &&
    left.identity.inode === right.identity.inode
  );
}

function sameSubtreeOwner(left: SourceSubtreeState, right: SourceSubtreeState): boolean {
  return (
    canonicalSourcePath(left.repoRoot) === canonicalSourcePath(right.repoRoot) &&
    left.relativePath === right.relativePath &&
    left.tree === right.tree
  );
}

interface RemovalRetention {
  cache: boolean;
  cacheStates: PluginSourceState[];
  managedCheckout: boolean;
  managedCheckoutStates: PluginSourceState[];
}

function recordedRemovalRetention(
  state: PluginSourceState,
  owners: CurrentSourceOwner[]
): RemovalRetention | null {
  const cacheStates = owners
    .filter(
      (owner) =>
        owner.state &&
        sourceCacheOwnerIdentity(state.namespace, owner.marketplacePath) ===
          sourceCacheOwnerIdentity(state.namespace, state.marketplacePath)
    )
    .map((owner) => owner.state as PluginSourceState);
  const managedCheckoutOwner = state.descriptor
    ? sourceManagedCheckoutOwnerIdentity(state.namespace, state.descriptor)
    : null;
  const managedCheckoutStates = owners
    .filter(
      (owner) =>
        owner.state &&
        owner.value !== undefined &&
        managedCheckoutOwner !== null &&
        sourceManagedCheckoutOwnerIdentity(state.namespace, owner.value) === managedCheckoutOwner
    )
    .map((owner) => owner.state as PluginSourceState);
  const cache = sourceCacheHasOwner(state.namespace, state.marketplacePath, owners);
  const managedCheckout = Boolean(
    state.descriptor && sourceManagedCheckoutHasOwner(state.namespace, state.descriptor, owners)
  );
  if (!cache && !managedCheckout) return null;
  if (
    managedCheckoutStates.some(
      (target) =>
        (state.checkout && target.subtree) ||
        (state.subtree && target.checkout) ||
        (state.checkout &&
          target.checkout &&
          !sameCheckoutOwner(state.checkout, target.checkout)) ||
        (state.subtree && target.subtree && !sameSubtreeOwner(state.subtree, target.subtree))
    )
  ) {
    throw new Error(`Conflicting managed owner recovery state for "${state.namespace}".`);
  }
  return { cache, cacheStates, managedCheckout, managedCheckoutStates };
}

let recoveringSourceTransactions = false;

function recoverPendingSourceTransactions(): void {
  if (recoveringSourceTransactions) return;
  const pending = listPendingPluginSourceTransactions();
  if (isTemporaryMarketplaceEntryCache()) {
    if (pending.length > 0) {
      throw new Error(
        'A pending source transaction requires durable recovery. Run ASB without --dry-run before retrying the preview.'
      );
    }
    return;
  }
  recoveringSourceTransactions = true;
  try {
    for (const observed of pending) {
      const observedTransaction = observed.addition ?? observed.removal;
      if (!observedTransaction) continue;
      withStableSourceOwners(
        observed.namespace,
        [observed.marketplacePath],
        observedTransaction.configPaths,
        (_owners, lockedConfigPaths) => {
          const state = readPluginSourceState(observed.namespace, observed.configPath);
          if (!state || state.incarnation !== observed.incarnation) return;
          const transaction = state.addition ?? state.removal;
          if (!transaction) return;
          const recover = () =>
            withSourceConfigTransaction(lockedConfigPaths, () => {
              if (state.addition) {
                const sourceIsActive = transactionSourceIsActive(state, transaction.configPaths);
                if (sourceIsActive && state.addition.phase === 'validated') {
                  commitInterruptedSourceAddition(state);
                } else {
                  rollbackInterruptedSourceAddition(state);
                }
              } else if (removalOwnerStillConfigured(state)) {
                rollbackInterruptedSourceRemoval(state);
              } else {
                const retention = recordedRemovalRetention(
                  state,
                  currentSourceOwners(state.namespace, state.configPath)
                );
                if (retention) transferInterruptedSourceRemoval(state, retention);
                else commitInterruptedSourceRemoval(state);
              }
            });
          const repoRoot =
            state.addition?.kind === 'subtree'
              ? state.addition.repoRoot
              : state.removal?.subtree?.repoRoot;
          if (repoRoot) withSubtreeRepoLock(repoRoot, recover);
          else recover();
        }
      );
    }
  } finally {
    recoveringSourceTransactions = false;
  }
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Plugin source recovery path escapes its root: ${target}`);
  }
}

function assertNoOwnedPathSymlinks(root: string, target: string): void {
  const trustedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  assertInside(trustedRoot, resolvedTarget);
  let current = trustedRoot;
  for (const segment of path
    .relative(trustedRoot, resolvedTarget)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Plugin source recovery path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function assertRemovalPathState(
  state: PluginSourceState,
  kind: 'cache' | 'checkout',
  paths: SourceRemovalPathState
): void {
  if (kind === 'checkout') {
    const pluginsRoot = path.resolve(getPluginsDir());
    const activePath = managedCheckoutPath(state.namespace);
    if (
      path.resolve(paths.activePath) !== path.resolve(activePath) ||
      path.dirname(path.resolve(paths.stagedPath)) !== path.dirname(activePath) ||
      !path
        .basename(paths.stagedPath)
        .startsWith(`.${paths.preserve ? 'preserved' : 'removing'}-${state.namespace}-`)
    ) {
      throw new Error(`Invalid plugin source checkout recovery paths for "${state.namespace}".`);
    }
    assertNoOwnedPathSymlinks(path.resolve(getConfigDir()), pluginsRoot);
    assertNoOwnedPathSymlinks(pluginsRoot, paths.activePath);
    assertNoOwnedPathSymlinks(pluginsRoot, paths.stagedPath);
    return;
  }

  assertMarketplaceEntryCacheRemovalPaths(state.namespace, state.marketplacePath, paths);
}

function assertAdditionPathState(state: PluginSourceState): SourceRemovalPathState {
  const addition = state.addition;
  if (!addition || addition.kind !== 'clone') {
    throw new Error(`Clone source addition state is missing for "${state.namespace}".`);
  }
  const pluginsRoot = path.resolve(getPluginsDir());
  const activePath = managedCheckoutPath(state.namespace);
  if (
    path.resolve(addition.checkout.activePath) !== activePath ||
    path.dirname(path.resolve(addition.checkout.stagedPath)) !== pluginsRoot ||
    !path
      .basename(addition.checkout.stagedPath)
      .startsWith(
        `.${addition.purpose === 'add' ? 'adding' : 'updating'}-${state.namespace}-${addition.transactionId}`
      ) ||
    !addition.checkout.identity
  ) {
    throw new Error(`Invalid plugin source addition paths for "${state.namespace}".`);
  }
  assertNoOwnedPathSymlinks(path.resolve(getConfigDir()), pluginsRoot);
  assertNoOwnedPathSymlinks(pluginsRoot, addition.checkout.activePath);
  assertNoOwnedPathSymlinks(pluginsRoot, addition.checkout.stagedPath);
  return addition.checkout;
}

function assertSubtreeAdditionState(
  state: PluginSourceState
): Extract<SourceAdditionState, { kind: 'subtree' }> {
  const addition = state.addition;
  const expectedPrefix = `plugins/${state.namespace}`;
  if (
    !addition ||
    addition.kind !== 'subtree' ||
    canonicalSourcePath(addition.repoRoot) !== canonicalSourcePath(getConfigDir()) ||
    addition.prefix !== expectedPrefix ||
    path.dirname(addition.stagePath) !== path.resolve(getPluginSourceStateDir())
  ) {
    throw new Error(`Invalid subtree addition state for "${state.namespace}".`);
  }
  return addition;
}

function subtreeTree(repoRoot: string, prefix: string, commit = 'HEAD'): string {
  return runGit(['rev-parse', `${commit}:${prefix}`], { cwd: repoRoot });
}

function subtreeProvenance(repoRoot: string, prefix: string, tree: string): SourceSubtreeState {
  return { repoRoot: path.resolve(repoRoot), relativePath: prefix, tree };
}

function assertSubtreeProvenance(state: PluginSourceState): SourceSubtreeState {
  const provenance = state.subtree;
  const expectedRoot = canonicalSourcePath(getConfigDir());
  const expectedPrefix = `plugins/${state.namespace}`;
  if (
    !provenance ||
    canonicalSourcePath(provenance.repoRoot) !== expectedRoot ||
    provenance.relativePath !== expectedPrefix
  ) {
    throw new Error(`Managed subtree provenance is missing for "${state.namespace}".`);
  }
  assertManagedSubtreePath(state.namespace);
  if (subtreeTree(provenance.repoRoot, provenance.relativePath) !== provenance.tree) {
    throw new Error(`Managed subtree provenance changed for "${state.namespace}".`);
  }
  return provenance;
}

function prepareSubtreeStage(
  namespace: string,
  transactionId: string
): {
  stagePath: string;
  stageIdentity: SourcePathIdentity;
} {
  const stageRoot = path.resolve(getPluginSourceStateDir());
  assertNoOwnedPathSymlinks(path.resolve(getConfigDir()), stageRoot);
  fs.mkdirSync(stageRoot, { recursive: true });
  const stagePath = path.join(stageRoot, `.subtree-${namespace}-${transactionId}`);
  return {
    stagePath,
    stageIdentity: prepareOwnedStage(stageRoot, stagePath, transactionId),
  };
}

function populateSubtreeStage(
  state: PluginSourceState,
  url: string,
  ref: string
): PluginSourceState {
  const addition = assertSubtreeAdditionState(state);
  const stageRoot = path.resolve(getPluginSourceStateDir());
  assertOwnedStage(stageRoot, addition.stagePath, addition.transactionId, addition.stageIdentity);
  const repoPath = path.join(addition.stagePath, 'repo');
  runGit(['clone', '--no-checkout', '--no-local', addition.repoRoot, repoPath]);
  runGit(['checkout', '--detach', addition.headBefore], { cwd: repoPath });
  runGit(['config', 'user.name', tryRunGit(['config', 'user.name'], addition.repoRoot) || 'ASB'], {
    cwd: repoPath,
  });
  runGit(
    [
      'config',
      'user.email',
      tryRunGit(['config', 'user.email'], addition.repoRoot) || 'asb@localhost',
    ],
    { cwd: repoPath }
  );
  if (addition.purpose === 'update' && addition.hadPrefix) {
    gitSubtreePull(repoPath, addition.prefix, expandHome(url), ref, addition.transactionId);
  } else {
    gitSubtreeAdd(repoPath, addition.prefix, expandHome(url), ref, addition.transactionId);
  }
  const headAfter = runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
  const treeAfter = subtreeTree(repoPath, addition.prefix, headAfter);
  runGit(['fetch', repoPath, headAfter], { cwd: addition.repoRoot });
  return updatePluginSourceAddition(state, { ...addition, headAfter, treeAfter });
}

function validateSubtreeStage(
  state: PluginSourceState,
  subdir: string | undefined
): PluginSourceState {
  const addition = assertSubtreeAdditionState(state);
  if (!addition.headAfter || !addition.treeAfter) {
    throw new Error(`Subtree source stage is incomplete for "${state.namespace}".`);
  }
  assertOwnedStage(
    path.resolve(getPluginSourceStateDir()),
    addition.stagePath,
    addition.transactionId,
    addition.stageIdentity
  );
  resolveSourceSubdir(path.join(addition.stagePath, 'repo', addition.prefix), subdir);
  return updatePluginSourceAddition(state, { ...addition, phase: 'validated' });
}

function subtreeRef(addition: Extract<SourceAdditionState, { kind: 'subtree' }>): string {
  return addition.headRef ?? 'HEAD';
}

function assertRecoverableSubtreePublication(
  addition: Extract<SourceAdditionState, { kind: 'subtree' }>
): 'before' | 'after' {
  const status = runGit(
    [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
      '--',
      addition.prefix,
    ],
    { cwd: addition.repoRoot }
  );
  if (status.split('\n').some((line) => line.startsWith('??') || line.startsWith('!!'))) {
    throw new Error(`Subtree addition recovery found foreign changes beneath its prefix.`);
  }
  const matches = (commit: string): boolean =>
    tryRunGit(['diff', '--quiet', '--cached', commit, '--', addition.prefix], addition.repoRoot) !==
      null &&
    tryRunGit(['diff', '--quiet', commit, '--', addition.prefix], addition.repoRoot) !== null;
  if (matches(addition.headBefore)) return 'before';
  if (addition.headAfter && matches(addition.headAfter)) return 'after';
  throw new Error(`Subtree addition recovery found foreign changes beneath its prefix.`);
}

function publishSubtreeAddition(state: PluginSourceState): void {
  const addition = assertSubtreeAdditionState(state);
  assertSubtreeHeadRef(state.namespace, addition);
  if (!addition.headAfter || !addition.treeAfter) {
    throw new Error(`Subtree addition commit is missing for "${state.namespace}".`);
  }
  if (addition.phase !== 'validated') {
    throw new Error(`Subtree addition is not validated for "${state.namespace}".`);
  }
  if (addition.headAfter === addition.headBefore) {
    if (addition.purpose !== 'update' || !addition.hadPrefix) {
      throw new Error(`Subtree addition commit is missing for "${state.namespace}".`);
    }
    if (runGit(['rev-parse', 'HEAD'], { cwd: addition.repoRoot }) !== addition.headBefore) {
      throw new Error(`Subtree addition publication refused because repository HEAD changed.`);
    }
    assertRecoverableSubtreePublication(addition);
    assertSubtreeProvenance(state);
    return;
  }
  assertSubtreeTransactionCommit(state.namespace, addition, addition.headAfter);
  const currentHead = runGit(['rev-parse', 'HEAD'], { cwd: addition.repoRoot });
  assertRecoverableSubtreePublication(addition);
  if (currentHead === addition.headBefore) {
    runGit(['update-ref', subtreeRef(addition), addition.headAfter, addition.headBefore], {
      cwd: addition.repoRoot,
    });
  } else if (currentHead !== addition.headAfter) {
    throw new Error(`Subtree addition publication refused because repository HEAD changed.`);
  }
  runGit(
    ['restore', '--source', addition.headAfter, '--staged', '--worktree', '--', addition.prefix],
    { cwd: addition.repoRoot }
  );
  if (subtreeTree(addition.repoRoot, addition.prefix) !== addition.treeAfter) {
    throw new Error(`Subtree addition publication changed for "${state.namespace}".`);
  }
}

function stagedClonePath(paths: SourceRemovalPathState): string {
  return path.join(paths.stagedPath, 'checkout');
}

function populateCloneStage(
  state: PluginSourceState,
  url: string,
  ref: string | undefined
): PluginSourceState {
  const addition = state.addition;
  if (!addition || addition.kind !== 'clone' || !addition.checkout.identity) {
    throw new Error(`Clone source addition state is missing for "${state.namespace}".`);
  }
  assertOwnedStage(
    path.resolve(getPluginsDir()),
    addition.checkout.stagedPath,
    addition.transactionId,
    addition.checkout.identity
  );
  const checkoutPath = stagedClonePath(addition.checkout);
  gitClone(expandHome(url), checkoutPath, ref);
  fs.writeFileSync(sourceCheckoutMarker(checkoutPath), `${addition.transactionId}\n`, {
    flag: 'wx',
  });
  excludeCheckoutMarker(checkoutPath);
  const checkoutIdentity = sourcePathIdentity(checkoutPath);
  return updatePluginSourceAddition(state, {
    ...addition,
    checkoutIdentity,
  });
}

function validateCloneStage(state: PluginSourceState): PluginSourceState {
  const addition = state.addition;
  if (!addition || addition.kind !== 'clone' || !addition.checkoutIdentity) {
    throw new Error(`Clone source stage is incomplete for "${state.namespace}".`);
  }
  const checkoutPath = stagedClonePath(addition.checkout);
  assertStateManagedCheckout(
    state,
    checkoutPath,
    addition.transactionId,
    addition.checkoutIdentity
  );
  return updatePluginSourceAddition(state, { ...addition, phase: 'validated' });
}

function publishCloneAddition(state: PluginSourceState): {
  addition: Extract<SourceAdditionState, { kind: 'clone' }>;
  paths: SourceRemovalPathState;
} {
  const paths = assertAdditionPathState(state);
  const addition = state.addition;
  if (
    !addition ||
    addition.kind !== 'clone' ||
    addition.phase !== 'validated' ||
    !addition.checkoutIdentity
  ) {
    throw new Error(`Source addition checkout is incomplete for "${state.namespace}".`);
  }
  if (!pathEntryExists(paths.activePath)) {
    if (!pathEntryExists(paths.stagedPath)) {
      throw new Error(`Source addition checkout is missing for "${state.namespace}".`);
    }
    assertOwnedStage(
      path.resolve(getPluginsDir()),
      paths.stagedPath,
      addition.transactionId,
      paths.identity as SourcePathIdentity
    );
    const checkoutPath = stagedClonePath(paths);
    assertStateManagedCheckout(
      state,
      checkoutPath,
      addition.transactionId,
      addition.checkoutIdentity
    );
    fs.renameSync(checkoutPath, paths.activePath);
  }
  assertStateManagedCheckout(
    state,
    paths.activePath,
    addition.transactionId,
    addition.checkoutIdentity
  );
  return { addition, paths };
}

function commitInterruptedSourceAddition(state: PluginSourceState): void {
  if (state.addition?.kind === 'subtree') {
    commitInterruptedSubtreeAddition(state);
    return;
  }
  const { addition, paths } = publishCloneAddition(state);
  assertStateManagedCheckout(
    state,
    paths.activePath,
    addition.transactionId,
    addition.checkoutIdentity as SourcePathIdentity
  );
  removeOwnedStage(
    path.resolve(getPluginsDir()),
    paths.stagedPath,
    addition.transactionId,
    paths.identity as SourcePathIdentity
  );
  completePluginSourceAddition(state, {
    checkout: {
      path: paths.activePath,
      owner: addition.transactionId,
      identity: addition.checkoutIdentity as SourcePathIdentity,
    },
  });
}

function rollbackInterruptedSourceAddition(state: PluginSourceState): void {
  if (state.addition?.kind === 'subtree') {
    rollbackInterruptedSubtreeAddition(state);
    return;
  }
  const paths = assertAdditionPathState(state);
  const addition = state.addition;
  if (!addition || addition.kind !== 'clone') return;
  if (pathEntryExists(paths.activePath)) {
    if (!addition.checkoutIdentity) {
      throw new Error(`Plugin source addition ownership is missing for "${state.namespace}".`);
    }
    disposeManagedCheckout(
      state,
      {
        ...ownedPathRemovalPaths(paths.activePath, addition.transactionId),
        identity: addition.checkoutIdentity,
      },
      addition.transactionId,
      addition.checkoutIdentity
    );
  }
  if (pathEntryExists(paths.stagedPath)) {
    assertOwnedStage(
      path.resolve(getPluginsDir()),
      paths.stagedPath,
      addition.transactionId,
      paths.identity as SourcePathIdentity
    );
    const checkoutPath = stagedClonePath(paths);
    if (pathEntryExists(checkoutPath)) {
      if (!addition.checkoutIdentity) {
        preserveOwnedPath(paths.stagedPath);
      } else {
        try {
          assertStateManagedCheckoutOwnership(
            state,
            checkoutPath,
            addition.transactionId,
            addition.checkoutIdentity
          );
          removeOwnedStage(
            path.resolve(getPluginsDir()),
            paths.stagedPath,
            addition.transactionId,
            paths.identity as SourcePathIdentity
          );
        } catch {
          preserveOwnedPath(paths.stagedPath);
        }
      }
    } else {
      removeOwnedStage(
        path.resolve(getPluginsDir()),
        paths.stagedPath,
        addition.transactionId,
        paths.identity as SourcePathIdentity
      );
    }
  }
  if (addition.purpose === 'add') deletePluginSourceState(state);
  else clearPluginSourceAddition(state);
}

function assertSubtreeHeadRef(
  namespace: string,
  addition: Extract<SourceAdditionState, { kind: 'subtree' }>
): void {
  if (symbolicHead(addition.repoRoot) !== addition.headRef) {
    throw new Error(`Subtree addition symbolic HEAD changed for "${namespace}".`);
  }
}

function assertSubtreeTransactionCommit(
  namespace: string,
  addition: Extract<SourceAdditionState, { kind: 'subtree' }>,
  commit: string
): void {
  const message = runGit(['show', '-s', '--format=%B', commit], { cwd: addition.repoRoot });
  const parents = runGit(['rev-list', '--parents', '-n', '1', commit], {
    cwd: addition.repoRoot,
  }).split(/\s+/);
  if (
    message.split('\n', 1)[0] !== subtreeAdditionMessage(addition.transactionId) ||
    parents[1] !== addition.headBefore
  ) {
    throw new Error(`Subtree addition ownership changed for "${namespace}".`);
  }
}

function propagateSubtreeProvenance(
  state: PluginSourceState,
  provenance: SourceSubtreeState
): void {
  const descriptor = state.descriptor;
  if (!descriptor || typeof descriptor === 'string') return;
  const identity = sourceManagedCheckoutOwnerIdentity(state.namespace, descriptor);
  for (const owner of currentSourceOwners(state.namespace)) {
    const target = owner.state;
    if (
      !target ||
      target.incarnation === state.incarnation ||
      owner.value === undefined ||
      sourceManagedCheckoutOwnerIdentity(state.namespace, owner.value) !== identity
    ) {
      continue;
    }
    if (target.addition || target.removal || target.checkout) {
      throw new Error(`Managed subtree owner changed for "${state.namespace}".`);
    }
    setPluginSourceSubtree(target, provenance);
  }
}

function commitInterruptedSubtreeAddition(state: PluginSourceState): void {
  const addition = assertSubtreeAdditionState(state);
  if (!addition.headAfter || !addition.treeAfter) {
    throw new Error(`Subtree addition commit is missing for "${state.namespace}".`);
  }
  publishSubtreeAddition(state);
  removeOwnedStage(
    path.resolve(getPluginSourceStateDir()),
    addition.stagePath,
    addition.transactionId,
    addition.stageIdentity
  );
  if (addition.headAfter === addition.headBefore) {
    clearPluginSourceAddition(state);
    return;
  }
  const provenance = subtreeProvenance(addition.repoRoot, addition.prefix, addition.treeAfter);
  propagateSubtreeProvenance(state, provenance);
  completePluginSourceAddition(state, {
    subtree: provenance,
  });
}

function rollbackInterruptedSubtreeAddition(state: PluginSourceState): void {
  const addition = assertSubtreeAdditionState(state);
  assertSubtreeHeadRef(state.namespace, addition);
  const currentHead = runGit(['rev-parse', 'HEAD'], { cwd: addition.repoRoot });
  const prefixState = addition.headAfter
    ? assertRecoverableSubtreePublication(addition)
    : undefined;
  if (currentHead === addition.headBefore) {
    if (prefixState === 'after') {
      if (addition.hadPrefix) {
        runGit(
          [
            'restore',
            '--source',
            addition.headBefore,
            '--staged',
            '--worktree',
            '--',
            addition.prefix,
          ],
          { cwd: addition.repoRoot }
        );
      } else {
        runGit(['rm', '-r', '-f', '--ignore-unmatch', '--', addition.prefix], {
          cwd: addition.repoRoot,
        });
      }
    }
    if (addition.hadPrefix) assertSubtreeProvenance(state);
  } else if (!addition.headAfter || currentHead !== addition.headAfter) {
    throw new Error(`Subtree addition rollback refused because repository HEAD changed.`);
  } else {
    assertSubtreeTransactionCommit(state.namespace, addition, currentHead);
    if (addition.hadPrefix) {
      runGit(['update-ref', subtreeRef(addition), addition.headBefore, addition.headAfter], {
        cwd: addition.repoRoot,
      });
      runGit(
        [
          'restore',
          '--source',
          addition.headBefore,
          '--staged',
          '--worktree',
          '--',
          addition.prefix,
        ],
        { cwd: addition.repoRoot }
      );
    } else {
      runGit(['rm', '-r', '-f', '--ignore-unmatch', '--', addition.prefix], {
        cwd: addition.repoRoot,
      });
      runGit(['update-ref', subtreeRef(addition), addition.headBefore, addition.headAfter], {
        cwd: addition.repoRoot,
      });
      if (pathEntryExists(path.join(addition.repoRoot, addition.prefix))) {
        throw new Error(`Subtree addition rollback left content for "${state.namespace}".`);
      }
    }
  }
  removeOwnedStage(
    path.resolve(getPluginSourceStateDir()),
    addition.stagePath,
    addition.transactionId,
    addition.stageIdentity
  );
  if (addition.purpose === 'add') deletePluginSourceState(state);
  else clearPluginSourceAddition(state);
}

function rollbackRemovalPath(paths: SourceRemovalPathState): void {
  const activeExists = pathEntryExists(paths.activePath);
  const stagedExists = pathEntryExists(paths.stagedPath);
  if (activeExists && stagedExists) {
    throw new Error(`Source recovery target already exists: ${paths.activePath}`);
  }
  if (stagedExists) {
    assertSourcePathIdentity(paths, paths.stagedPath);
    fs.renameSync(paths.stagedPath, paths.activePath);
  } else if (!activeExists) {
    throw new Error(`Source recovery path is missing: ${paths.activePath}`);
  } else {
    assertSourcePathIdentity(paths, paths.activePath);
  }
}

function commitRemovalPath(paths: SourceRemovalPathState): void {
  if (!ensureRemovalPathStaged(paths) || paths.preserve) return;
  fs.rmSync(paths.stagedPath, { recursive: true, force: true });
}

function rollbackSubtreeRemoval(state: PluginSourceState): void {
  const subtree = state.removal?.subtree;
  if (!subtree) return;
  const expected = `plugins/${state.namespace}`;
  if (
    path.resolve(subtree.repoRoot) !== path.resolve(getConfigDir()) ||
    subtree.relativePath !== expected
  ) {
    throw new Error(`Invalid subtree recovery state for "${state.namespace}".`);
  }
  const currentHead = runGit(['rev-parse', 'HEAD'], { cwd: subtree.repoRoot });
  if (currentHead !== subtree.head) {
    throw new Error(`Subtree recovery HEAD changed for "${state.namespace}".`);
  }
  const status = runGit(
    ['status', '--porcelain=v1', '--untracked-files=all', '--', subtree.relativePath],
    { cwd: subtree.repoRoot }
  );
  if (!status) {
    if (pathEntryExists(path.join(subtree.repoRoot, subtree.relativePath))) return;
    throw new Error(`Subtree recovery path is missing for "${state.namespace}".`);
  }
  if (status.split('\n').some((line) => !line.startsWith('D  '))) {
    throw new Error(`Subtree recovery found foreign changes for "${state.namespace}".`);
  }
  runGit(
    ['restore', '--source', subtree.head, '--staged', '--worktree', '--', subtree.relativePath],
    { cwd: subtree.repoRoot }
  );
}

function assertSubtreeRemovalReady(state: PluginSourceState): SourceSubtreeState {
  const provenance = assertSubtreeProvenance(state);
  assertNormalGitIndex(provenance.repoRoot, provenance.relativePath);
  const status = runGit(
    [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
      '--',
      provenance.relativePath,
    ],
    { cwd: provenance.repoRoot }
  );
  if (status) {
    throw new Error(
      `Managed subtree "${state.namespace}" contains modified, untracked, or ignored content.`
    );
  }
  return provenance;
}

function restoreInterruptedSourceRemovalPaths(state: PluginSourceState): void {
  const removal = state.removal;
  if (!removal) return;
  rollbackSubtreeRemoval(state);
  if (removal.checkout) {
    assertRemovalPathState(state, 'checkout', removal.checkout);
    rollbackRemovalPath(removal.checkout);
  }
  if (removal.cache) {
    assertRemovalPathState(state, 'cache', removal.cache);
    rollbackRemovalPath(removal.cache);
  }
}

function rollbackInterruptedSourceRemoval(state: PluginSourceState): void {
  if (!state.removal) return;
  restoreInterruptedSourceRemovalPaths(state);
  clearPluginSourceRemoval(state);
}

function commitInterruptedManagedCheckoutRemoval(state: PluginSourceState): void {
  const removal = state.removal;
  if (!removal) return;
  if (removal.checkout) {
    assertRemovalPathState(state, 'checkout', removal.checkout);
    const checkout = state.checkout;
    if (
      !checkout ||
      path.resolve(checkout.path) !== path.resolve(removal.checkout.activePath) ||
      !removal.checkout.identity ||
      checkout.identity.device !== removal.checkout.identity.device ||
      checkout.identity.inode !== removal.checkout.identity.inode
    ) {
      throw new Error(`Managed checkout provenance is missing for "${state.namespace}".`);
    }
    disposeManagedCheckout(state, removal.checkout, checkout.owner, checkout.identity);
  }
  if (
    removal.subtree &&
    pathEntryExists(path.join(removal.subtree.repoRoot, removal.subtree.relativePath))
  ) {
    throw new Error(`Source recovery found remaining subtree content: ${state.namespace}`);
  }
}

function transferInterruptedSourceRemoval(
  state: PluginSourceState,
  retention: RemovalRetention
): void {
  const removal = state.removal;
  if (!removal) return;
  if (retention.managedCheckout) {
    rollbackSubtreeRemoval(state);
    if (removal.checkout) {
      assertRemovalPathState(state, 'checkout', removal.checkout);
      rollbackRemovalPath(removal.checkout);
    }
  } else {
    commitInterruptedManagedCheckoutRemoval(state);
  }
  if (removal.cache) {
    assertRemovalPathState(state, 'cache', removal.cache);
    if (retention.cache) rollbackRemovalPath(removal.cache);
    else commitRemovalPath(removal.cache);
  }
  if (retention.managedCheckout) {
    for (const target of retention.managedCheckoutStates) {
      if (state.checkout && !target.checkout) {
        setPluginSourceCheckout(target, state.checkout);
      }
      if (state.subtree && !target.subtree) {
        setPluginSourceSubtree(target, state.subtree);
      }
    }
  }
  if (retention.cache && state.sourceKind) {
    for (const target of retention.cacheStates) setPluginSourceKind(target, state.sourceKind);
  }
  deletePluginSourceState(state);
}

function commitInterruptedSourceRemoval(state: PluginSourceState): void {
  const removal = state.removal;
  if (!removal) return;
  commitInterruptedManagedCheckoutRemoval(state);
  if (removal.cache) {
    assertRemovalPathState(state, 'cache', removal.cache);
    commitRemovalPath(removal.cache);
  }
  deletePluginSourceState(state);
}

export function hasSource(namespace: string, scope?: ConfigScope): boolean {
  const raw = getRawSources(scope);
  if (namespace in raw) return true;
  const discovered = discoverLocalSources();
  return namespace in discovered;
}

/**
 * Add a local directory source.
 * If the path is inside `~/.asb/plugins/<namespace>/`, stores the short name only.
 */
export function addLocalSource(namespace: string, libraryPath: string, scope?: ConfigScope): void {
  const resolvedPath = path.resolve(libraryPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }

  validateNewNamespace(namespace);
  getRawSources(scope);
  const options = scopeToLayerOptions(scope);
  const configPath = resolveConfigWritePath(getWritableConfigLayerPath(options));
  retireInactivePluginSourceState(namespace, configPath, scope);

  const pluginsChild = managedCheckoutPath(namespace);
  const configValue = resolvedPath === pluginsChild ? namespace : resolvedPath;
  withSourceResourceLocks(namespace, [resolvedPath], () =>
    withSourceConfigTransaction(sourceConfigPaths(scope, configPath), () => {
      ensureNamespaceAvailableCurrent(namespace, configPath, configValue === namespace);
      let state: PluginSourceState | undefined;
      try {
        state = rotatePluginSourceState(
          namespace,
          configPath,
          configValue,
          sourceDescriptorKey(namespace, configValue),
          canonicalSourcePath(resolvedPath)
        );
        updateConfigLayerFile(configPath, (layer) => ({
          ...layer,
          plugins: {
            ...layer.plugins,
            sources: {
              ...(layer.plugins?.sources ?? {}),
              [namespace]: configValue,
            },
          },
        }));
        markSourcesChanged();
      } catch (error) {
        if (state) deletePluginSourceState(state);
        throw error;
      }
    })
  );
}

/**
 * Add a remote Git source under the first-class plugin source directory.
 */
export function addRemoteSource(
  namespace: string,
  remote: RemoteSource,
  scope?: ConfigScope
): void {
  validateNewNamespace(namespace);
  assertManagedPluginsRoot();
  getRawSources(scope);
  const options = scopeToLayerOptions(scope);
  const configPath = resolveConfigWritePath(getWritableConfigLayerPath(options));
  retireInactivePluginSourceState(namespace, configPath, scope);
  ensureGitAvailable();
  const configValue: RemoteSource = { url: remote.url, type: remote.type };
  if (remote.ref) configValue.ref = remote.ref;
  if (remote.subdir) configValue.subdir = remote.subdir;
  const effectivePath = resolveEffectivePath(namespace, configValue);
  const configPaths = sourceConfigPaths(scope, configPath);

  withSourceResourceLocks(namespace, [effectivePath], () => {
    const add = () =>
      withSourceConfigTransaction(configPaths, () => {
        ensureNamespaceAvailableCurrent(namespace, configPath);
        assertManagedPluginsRoot();

        if (remote.type === 'subtree') {
          if (!isGitRepo(getConfigDir())) {
            throw new Error(
              `Subtree mode requires ASB_HOME to be a git repo root. Current ASB_HOME is not a git repo or is a subdirectory of one.`
            );
          }
          if (!remote.ref) {
            throw new Error(`Subtree sources require an explicit "ref" (e.g. ref = "main").`);
          }
          const repoRoot = fs.realpathSync.native(getConfigDir());
          ensureCleanTree(repoRoot, configPaths);
          const prefix = `plugins/${namespace}`;
          const transactionId = randomUUID();
          const headBefore = runGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
          const stage = prepareSubtreeStage(namespace, transactionId);
          const addition: Extract<SourceAdditionState, { kind: 'subtree' }> = {
            kind: 'subtree',
            purpose: 'add',
            configPath,
            configPaths,
            repoRoot: path.resolve(repoRoot),
            prefix,
            hadPrefix: false,
            ...stage,
            headBefore,
            headRef: symbolicHead(repoRoot),
            phase: 'constructing',
            transactionId,
          };
          let state = rotatePluginSourceState(
            namespace,
            configPath,
            configValue,
            sourceDescriptorKey(namespace, configValue),
            canonicalSourcePath(effectivePath)
          );
          state = beginPluginSourceAddition(state, addition);
          let configCommitted = false;
          try {
            state = populateSubtreeStage(state, remote.url, remote.ref);
            state = validateSubtreeStage(state, remote.subdir);
            publishSubtreeAddition(state);
            updateConfigLayerFile(configPath, (layer) => ({
              ...layer,
              plugins: {
                ...layer.plugins,
                sources: {
                  ...(layer.plugins?.sources ?? {}),
                  [namespace]: configValue,
                },
              },
            }));
            configCommitted = true;
            markSourcesChanged();
            commitInterruptedSourceAddition(state);
          } catch (error) {
            if (configCommitted) throw error;
            try {
              rollbackInterruptedSourceAddition(state);
            } catch (rollbackError) {
              const message = error instanceof Error ? error.message : String(error);
              const rollbackMessage =
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
              throw new Error(`${message}\nRollback refused: ${rollbackMessage}`, {
                cause: error,
              });
            }
            throw error;
          } finally {
            if (!state.addition && pathEntryExists(stage.stagePath)) {
              removeOwnedStage(
                path.resolve(getPluginSourceStateDir()),
                stage.stagePath,
                transactionId,
                stage.stageIdentity
              );
            }
          }
          return;
        }

        const transactionId = randomUUID();
        const preparedCheckout = ownedPathAdditionPaths(namespace, transactionId);
        const checkout = {
          ...preparedCheckout,
          identity: prepareOwnedStage(
            path.resolve(getPluginsDir()),
            preparedCheckout.stagedPath,
            transactionId
          ),
        };
        let state: PluginSourceState | undefined;
        let additionState: PluginSourceState | undefined;
        let configCommitted = false;
        try {
          state = rotatePluginSourceState(
            namespace,
            configPath,
            configValue,
            sourceDescriptorKey(namespace, configValue),
            canonicalSourcePath(effectivePath)
          );
          additionState = beginPluginSourceAddition(state, {
            kind: 'clone',
            purpose: 'add',
            configPath,
            configPaths,
            checkout,
            phase: 'constructing',
            transactionId,
          });
          additionState = populateCloneStage(additionState, remote.url, remote.ref);
          additionState = validateCloneStage(additionState);
          assertManagedPluginsRoot();
          if (pathEntryExists(checkout.activePath)) {
            throw new Error(`Source checkout appeared during publication: ${checkout.activePath}`);
          }
          publishCloneAddition(additionState);
          updateConfigLayerFile(configPath, (layer) => ({
            ...layer,
            plugins: {
              ...layer.plugins,
              sources: {
                ...(layer.plugins?.sources ?? {}),
                [namespace]: configValue,
              },
            },
          }));
          configCommitted = true;
          markSourcesChanged();
          commitInterruptedSourceAddition(additionState);
        } catch (error) {
          if (configCommitted) throw error;
          try {
            if (additionState) rollbackInterruptedSourceAddition(additionState);
            else if (state) deletePluginSourceState(state);
          } catch (rollbackError) {
            const message = error instanceof Error ? error.message : String(error);
            const rollbackMessage =
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`${message}\nRollback failed: ${rollbackMessage}`, { cause: error });
          }
          throw error;
        } finally {
          if (!additionState && pathEntryExists(checkout.stagedPath)) {
            removeOwnedStage(
              path.resolve(getPluginsDir()),
              checkout.stagedPath,
              transactionId,
              checkout.identity
            );
          }
        }
      });
    if (remote.type === 'subtree') withSubtreeRepoLock(getConfigDir(), add);
    else add();
  });
}

/**
 * Remove a configured source and its source-owned derived state.
 */
export function removeSource(namespace: string, scope?: ConfigScope): void {
  const raw = getRawSources(scope);
  if (!(namespace in raw)) {
    throw new Error(`Source "${namespace}" not found.`);
  }

  const value = raw[namespace];
  const effectivePath = resolveEffectivePath(namespace, value);
  const configPath = sourceOwningConfigPath(namespace, scope);
  const configPaths = sourceConfigPaths(scope, configPath);
  let sourceState = reconcilePluginSourceState(
    namespace,
    value,
    canonicalSourcePath(effectivePath),
    scope
  );
  const cacheOwnerPath = sourceState.marketplacePath;
  withStableSourceOwners(namespace, [cacheOwnerPath], configPaths, (_owners, lockedConfigPaths) => {
    const remove = () =>
      withSourceConfigTransaction(lockedConfigPaths, () => {
        const current = effectiveConfiguredSource(namespace, configPaths);
        if (
          current?.configPath !== configPath ||
          sourceDescriptorIdentity(current.value) !== sourceDescriptorIdentity(value) ||
          !pluginSourceStateIsCurrent(sourceState)
        ) {
          throw new Error(`Source "${namespace}" changed while waiting for its lifecycle lock.`);
        }
        const survivingOwners = currentSourceOwners(namespace, configPath);
        const retainCache = sourceCacheHasOwner(namespace, cacheOwnerPath, survivingOwners);
        const retainManagedCheckout = sourceManagedCheckoutHasOwner(
          namespace,
          value,
          survivingOwners
        );
        if (
          retainCache &&
          (sourceManagedCheckoutOwnerIdentity(namespace, value) === null || retainManagedCheckout)
        ) {
          deletePluginSourceState(sourceState);
          updateConfigLayerFile(configPath, (layer) => {
            const newSources = { ...(layer.plugins?.sources ?? {}) };
            delete newSources[namespace];
            return {
              ...layer,
              plugins: {
                ...layer.plugins,
                sources: newSources,
              },
            };
          });
          markSourcesChanged();
          return;
        }
        const remote = typeof value !== 'string' && isCloneableSource(expandHome(value.url));
        const pluginDir = managedCheckoutPath(namespace);
        if (remote && !retainManagedCheckout && value.type === 'subtree') {
          if (!isGitRepo(getConfigDir())) {
            throw new Error(
              `Source "${namespace}" is configured as subtree but ASB_HOME is not a git repo root. Cannot safely remove.`
            );
          }
          assertManagedSubtreePath(namespace);
          if (pathEntryExists(pluginDir)) {
            ensureCleanTree(getConfigDir(), lockedConfigPaths);
            sourceState = ensureSubtreeProvenance(sourceState);
            assertSubtreeRemovalReady(sourceState);
          }
        } else if (remote && !retainManagedCheckout && pathEntryExists(pluginDir)) {
          sourceState = ensureCheckoutProvenance(sourceState, value.url, value.ref);
        }

        let preserveCheckout = false;
        if (
          remote &&
          !retainManagedCheckout &&
          value.type !== 'subtree' &&
          pathEntryExists(pluginDir)
        ) {
          assertCheckoutProvenance(sourceState);
          try {
            assertManagedCheckoutIdentity(pluginDir, value.url, value.ref);
          } catch {
            preserveCheckout = true;
          }
        }

        const transactionId = randomUUID();
        const preparedCachePaths = marketplaceEntryCacheRemovalPaths(
          namespace,
          cacheOwnerPath,
          transactionId
        );
        const preparedCheckoutPaths = ownedPathRemovalPaths(
          pluginDir,
          transactionId,
          preserveCheckout
        );
        const cachePaths = pathEntryExists(preparedCachePaths.activePath)
          ? persistRemovalIdentity(preparedCachePaths)
          : preparedCachePaths;
        const checkoutPaths =
          remote &&
          !retainManagedCheckout &&
          value.type !== 'subtree' &&
          pathEntryExists(preparedCheckoutPaths.activePath)
            ? {
                ...preparedCheckoutPaths,
                identity: assertCheckoutProvenance(sourceState).identity,
              }
            : preparedCheckoutPaths;
        const removal = {
          configPath,
          configPaths: lockedConfigPaths,
          ...(!retainCache && pathEntryExists(cachePaths.activePath) ? { cache: cachePaths } : {}),
          ...(remote &&
          !retainManagedCheckout &&
          value.type !== 'subtree' &&
          pathEntryExists(checkoutPaths.activePath)
            ? { checkout: checkoutPaths }
            : {}),
          ...(remote &&
          !retainManagedCheckout &&
          value.type === 'subtree' &&
          pathEntryExists(pluginDir)
            ? {
                subtree: {
                  repoRoot: path.resolve(getConfigDir()),
                  relativePath: `plugins/${namespace}`,
                  head: runGit(['rev-parse', 'HEAD'], { cwd: getConfigDir() }),
                },
              }
            : {}),
        };
        const removalState = beginPluginSourceRemoval(sourceState, removal);
        let cacheStage = { commit: () => {}, rollback: () => {} };
        let checkoutStage: StagedPathRemoval = { commit: () => {}, rollback: () => {} };
        let subtreeTouched = false;
        let configCommitted = false;
        try {
          if (removal.cache) {
            assertRemovalPathState(removalState, 'cache', cachePaths);
            cacheStage = stageOwnedPathRemoval(cachePaths);
          }
          if (removal.subtree) {
            subtreeTouched = true;
            runGit(['rm', '-r', `plugins/${namespace}`], { cwd: getConfigDir() });
            if (pathEntryExists(pluginDir)) {
              throw new Error(`Subtree removal left content beneath "${namespace}".`);
            }
          } else if (removal.checkout) {
            assertRemovalPathState(removalState, 'checkout', checkoutPaths);
            checkoutStage = stageOwnedPathRemoval(checkoutPaths);
          }

          updateConfigLayerFile(configPath, (layer) => {
            const newSources = { ...(layer.plugins?.sources ?? {}) };
            delete newSources[namespace];
            return {
              ...layer,
              plugins: {
                ...layer.plugins,
                sources: newSources,
              },
            };
          });
          configCommitted = true;
          markSourcesChanged();
          commitInterruptedSourceRemoval(removalState);
        } catch (error) {
          if (configCommitted) throw error;
          const rollbackErrors: string[] = [];
          if (subtreeTouched && isGitRepo(getConfigDir())) {
            try {
              rollbackSubtreeRemoval(removalState);
            } catch (rollbackError) {
              rollbackErrors.push(
                `restore subtree: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
              );
            }
          }
          try {
            checkoutStage.rollback();
          } catch (rollbackError) {
            rollbackErrors.push(
              `restore checkout: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            );
          }
          try {
            cacheStage.rollback();
          } catch (rollbackError) {
            rollbackErrors.push(
              `restore cache: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            );
          }
          if (rollbackErrors.length === 0) {
            try {
              clearPluginSourceRemoval(removalState);
            } catch (rollbackError) {
              rollbackErrors.push(
                `clear recovery record: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
              );
            }
          }
          if (rollbackErrors.length > 0) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${message}\nRollback failed: ${rollbackErrors.join('; ')}`, {
              cause: error,
            });
          }
          throw error;
        }
      });
    if (typeof value !== 'string' && value.type === 'subtree') {
      withSubtreeRepoLock(getConfigDir(), remove);
    } else {
      remove();
    }
  });
}

/**
 * Validate a local path has expected library structure.
 * Recognizes plugin layout (rules/, commands/, etc.)
 * and native marketplace layouts.
 */
export type SourceKind = 'marketplace' | 'plugin';

export function validateSourcePath(libraryPath: string): {
  valid: boolean;
  found: string[];
  missing: string[];
  kind: SourceKind;
} {
  const resolvedPath = path.resolve(libraryPath);

  if (getMarketplaceManifestInfo(resolvedPath)) {
    return { valid: true, found: ['marketplace'], missing: [], kind: 'marketplace' };
  }

  if (getPluginManifestInfo(resolvedPath)) {
    return { valid: true, found: ['plugin'], missing: [], kind: 'plugin' };
  }

  const libraryTypes = ['rules', 'commands', 'agents', 'skills', 'hooks'];
  const found: string[] = [];
  const missing: string[] = [];

  for (const type of libraryTypes) {
    const typePath = path.join(resolvedPath, type);
    if (fs.existsSync(typePath) && fs.statSync(typePath).isDirectory()) {
      found.push(type);
    } else {
      missing.push(type);
    }
  }

  return { valid: found.length > 0, found, missing, kind: 'plugin' };
}

/**
 * Pull latest changes for all remote sources.
 * Publishes missing managed checkouts from a verified stage and rejects mismatched checkouts.
 */
export function updateRemoteSources(
  scope?: ConfigScope,
  onlyNamespace?: string
): SourceUpdateResult[] {
  const raw = getRawSources(scope);
  const results: SourceUpdateResult[] = [];
  let gitChecked = false;
  let attemptedUpdate = false;
  const handledNamespaces = new Set<string>();

  for (const [namespace, value] of Object.entries(raw)) {
    if (onlyNamespace && namespace !== onlyNamespace) continue;
    if (typeof value === 'string') continue;
    if (!isCloneableSource(expandHome(value.url))) continue;
    attemptedUpdate = true;
    handledNamespaces.add(namespace);
    const effectivePath = resolveEffectivePath(namespace, value);

    try {
      withSourceResourceLocks(namespace, [effectivePath], () => {
        if (
          sourceDescriptorIdentity(getRawSources(scope)[namespace]) !==
          sourceDescriptorIdentity(value)
        ) {
          throw new Error(`Source "${namespace}" changed while waiting for its lifecycle lock.`);
        }
        if (!gitChecked) {
          ensureGitAvailable();
          gitChecked = true;
        }

        if (value.type === 'subtree') {
          withSubtreeRepoLock(getConfigDir(), () => {
            if (!isGitRepo(getConfigDir())) {
              throw new Error(
                `Source "${namespace}" is configured as subtree but ASB_HOME is not a git repo root.`
              );
            }
            if (!value.ref) {
              throw new Error(
                `Subtree source "${namespace}" requires an explicit "ref" in config.toml.`
              );
            }
            const repoRoot = getConfigDir();
            const configPath = sourceOwningConfigPath(namespace, scope);
            const configPaths = sourceConfigPaths(scope, configPath);
            ensureCleanTree(repoRoot, configPaths);
            const prefix = `plugins/${namespace}`;
            const prefixDir = path.join(repoRoot, prefix);
            let sourceState = reconcilePluginSourceState(
              namespace,
              value,
              canonicalSourcePath(effectivePath),
              scope
            );
            if (pathEntryExists(prefixDir)) sourceState = ensureSubtreeProvenance(sourceState);
            const transactionId = randomUUID();
            const stage = prepareSubtreeStage(namespace, transactionId);
            let additionState: PluginSourceState | undefined;
            try {
              additionState = beginPluginSourceAddition(sourceState, {
                kind: 'subtree',
                purpose: 'update',
                configPath,
                configPaths,
                repoRoot: path.resolve(repoRoot),
                prefix,
                hadPrefix: pathEntryExists(prefixDir),
                ...stage,
                headBefore: runGit(['rev-parse', 'HEAD'], { cwd: repoRoot }),
                headRef: symbolicHead(repoRoot),
                phase: 'constructing',
                transactionId,
              });
              additionState = populateSubtreeStage(additionState, value.url, value.ref);
              additionState = validateSubtreeStage(additionState, value.subdir);
              withSourceConfigTransaction(configPaths, () => {
                if (!transactionSourceIsActive(additionState as PluginSourceState, configPaths)) {
                  throw new Error(`Source "${namespace}" changed before subtree publication.`);
                }
                publishSubtreeAddition(additionState as PluginSourceState);
                commitInterruptedSourceAddition(additionState as PluginSourceState);
              });
            } catch (error) {
              if (additionState?.addition) rollbackInterruptedSourceAddition(additionState);
              throw error;
            } finally {
              if (!additionState && pathEntryExists(stage.stagePath)) {
                removeOwnedStage(
                  path.resolve(getPluginSourceStateDir()),
                  stage.stagePath,
                  transactionId,
                  stage.stageIdentity
                );
              }
            }
          });
        } else {
          assertManagedPluginsRoot();
          const cloneDir = managedCheckoutPath(namespace);
          if (!pathEntryExists(cloneDir)) {
            const sourceState = reconcilePluginSourceState(
              namespace,
              value,
              canonicalSourcePath(effectivePath),
              scope
            );
            const transactionId = randomUUID();
            const preparedCheckout = ownedPathAdditionPaths(namespace, transactionId, 'update');
            const checkout = {
              ...preparedCheckout,
              identity: prepareOwnedStage(
                path.resolve(getPluginsDir()),
                preparedCheckout.stagedPath,
                transactionId
              ),
            };
            const configPath = sourceOwningConfigPath(namespace, scope);
            const configPaths = sourceConfigPaths(scope, configPath);
            let additionState: PluginSourceState | undefined;
            try {
              additionState = beginPluginSourceAddition(sourceState, {
                kind: 'clone',
                purpose: 'update',
                configPath,
                configPaths,
                checkout,
                phase: 'constructing',
                transactionId,
              });
              additionState = populateCloneStage(additionState, value.url, value.ref);
              additionState = validateCloneStage(additionState);
              withSourceConfigTransaction(configPaths, () => {
                if (!transactionSourceIsActive(additionState as PluginSourceState, configPaths)) {
                  throw new Error(`Source "${namespace}" changed before checkout publication.`);
                }
                if (!pluginSourceStateIsCurrent(additionState as PluginSourceState)) {
                  throw new Error(`Source "${namespace}" changed before checkout publication.`);
                }
                assertManagedPluginsRoot();
                if (pathEntryExists(cloneDir)) {
                  throw new Error(`Source checkout appeared during publication: ${cloneDir}`);
                }
                publishCloneAddition(additionState as PluginSourceState);
                commitInterruptedSourceAddition(additionState as PluginSourceState);
              });
            } catch (error) {
              if (additionState?.addition) rollbackInterruptedSourceAddition(additionState);
              throw error;
            } finally {
              if (!additionState && pathEntryExists(checkout.stagedPath)) {
                removeOwnedStage(
                  path.resolve(getPluginsDir()),
                  checkout.stagedPath,
                  transactionId,
                  checkout.identity
                );
              }
            }
          } else {
            let sourceState = reconcilePluginSourceState(
              namespace,
              value,
              canonicalSourcePath(effectivePath),
              scope
            );
            sourceState = ensureCheckoutProvenance(sourceState, value.url, value.ref);
            const branch = assertManagedCheckoutIdentity(cloneDir, value.url, value.ref);
            gitPull(cloneDir, branch, value.url, value.ref);
            const currentBranch = assertManagedCheckoutIdentity(cloneDir, value.url, value.ref);
            assertManagedCheckoutCurrent(cloneDir, currentBranch);
          }
        }
        const currentEffectivePath = resolveEffectivePath(namespace, value);
        if (getMarketplaceManifestInfo(currentEffectivePath)) {
          recordSourceKind(namespace, currentEffectivePath, 'marketplace', scope);
          const ownerValidator = captureSourceOwnerValidator(
            namespace,
            currentEffectivePath,
            scope
          );
          refreshMarketplacePluginCache(currentEffectivePath, namespace, ownerValidator);
        } else {
          removeMarketplaceEntryCache(namespace, currentEffectivePath);
          const state = reconcilePluginSourceState(
            namespace,
            value,
            canonicalSourcePath(currentEffectivePath),
            scope
          );
          setPluginSourceKind(state, 'plugin');
        }
      });
      results.push({ namespace, url: value.url, status: 'updated' });
    } catch (err) {
      results.push({
        namespace,
        url: value.url,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const source of collectSources(scope, false)) {
    if (onlyNamespace && source.namespace !== onlyNamespace) continue;
    if (handledNamespaces.has(source.namespace)) continue;
    const value = raw[source.namespace];
    const state = reconcilePluginSourceState(
      source.namespace,
      value,
      canonicalSourcePath(source.path),
      scope
    );
    const ownerPath = state.marketplacePath;
    const isMarketplace = Boolean(getMarketplaceManifestInfo(source.path));
    const hasDerivedCache = marketplaceEntryCacheExists(source.namespace, ownerPath);
    if (!isMarketplace && state.sourceKind !== 'marketplace' && !hasDerivedCache) continue;
    try {
      if (isMarketplace) {
        recordSourceKind(source.namespace, source.path, 'marketplace', scope);
      }
      const ownerValidator = isMarketplace
        ? captureSourceOwnerValidator(source.namespace, source.path, scope)
        : undefined;
      withSourceResourceLocks(source.namespace, [ownerPath], () => {
        if (!sourceOwnerIsCurrent(source.namespace, source.path, scope)) {
          throw new Error(
            `Source "${source.namespace}" changed while waiting for its lifecycle lock.`
          );
        }
        if (isMarketplace) {
          refreshMarketplacePluginCache(source.path, source.namespace, ownerValidator);
        } else {
          removeMarketplaceEntryCache(source.namespace, ownerPath);
          setPluginSourceKind(state, 'plugin');
        }
      });
      attemptedUpdate = true;
      results.push({ namespace: source.namespace, url: source.path, status: 'updated' });
    } catch (err) {
      results.push({
        namespace: source.namespace,
        url: source.path,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (attemptedUpdate) markSourcesChanged();

  return results;
}
