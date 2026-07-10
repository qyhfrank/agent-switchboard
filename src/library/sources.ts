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
  withConfigLayerTransaction,
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
import { loadSwitchboardConfig } from '../config/switchboard-config.js';
import {
  assertMarketplaceEntryCacheRemovalPaths,
  isTemporaryMarketplaceEntryCache,
  marketplaceEntryCacheExists,
  marketplaceEntryCacheRemovalPaths,
  redactGitCredentials,
  removeMarketplaceEntryCache,
  withMarketplaceSourceLock,
} from '../marketplace/cache.js';
import { isScpGitUrl, normalizeGitIdentity } from '../marketplace/git-identity.js';
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
  deletePluginSourceState,
  ensurePluginSourceState,
  listPendingPluginSourceTransactions,
  type PluginSourceState,
  pluginSourceStateIsCurrent,
  readPluginSourceState,
  rotatePluginSourceState,
  type SourceAdditionState,
  type SourcePathIdentity,
  type SourceRemovalPathState,
  setPluginSourceKind,
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

function runGit(args: string[], options?: { cwd?: string }): string {
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
  args.push(url, targetDir);
  runGit(args);
}

function gitPull(repoDir: string, branch: string | undefined, ref?: string): void {
  if (!branch) {
    if (!ref) throw new Error(`Managed source checkout has no updateable branch.`);
    runGit(['fetch', '--depth', '1', 'origin', ref], { cwd: repoDir });
    if (
      runGit(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: repoDir }) !==
      runGit(['rev-parse', 'HEAD'], { cwd: repoDir })
    ) {
      throw new Error(`Managed source configured ref changed; remove and add the source again.`);
    }
    return;
  }
  runGit(['pull', '--ff-only', 'origin', branch], { cwd: repoDir });
}

function gitSubtreeAdd(
  repoRoot: string,
  prefix: string,
  url: string,
  ref: string,
  transactionId: string
): void {
  runGit(
    [
      'subtree',
      'add',
      '--prefix',
      prefix,
      '--message',
      subtreeAdditionMessage(transactionId),
      url,
      ref,
    ],
    { cwd: repoRoot }
  );
}

function gitSubtreePull(repoRoot: string, prefix: string, url: string, ref: string): void {
  runGit(['subtree', 'pull', '--prefix', prefix, url, ref], { cwd: repoRoot });
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

function assertCheckoutTracksRevision(repoDir: string, branch: string, head: string): void {
  const trackingHead = tryRunGit(['rev-parse', `refs/remotes/origin/${branch}^{commit}`], repoDir);
  if (trackingHead !== head) {
    throw new Error(`Managed source checkout does not match its configured revision.`);
  }
}

function ensureCleanTree(dir: string): void {
  const args = ['status', '--porcelain'];
  const canonicalDir = fs.realpathSync.native(dir);
  const excludedPaths = [
    getMarketplacePluginCacheDir(),
    getPluginSourceLocksDir(),
    getPluginSourceStateDir(),
    getConfigLayerLockPath(getWritableConfigLayerPath()),
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
    normalizeGitIdentity(origin, repoDir) !== normalizeGitIdentity(expandHome(url), process.cwd())
  ) {
    throw new Error(`Managed source checkout origin does not match its configured source.`);
  }
  ensureManagedCheckoutClean(repoDir);
  return configuredCheckoutBranch(repoDir, ref);
}

function ensureManagedCheckoutClean(repoDir: string): void {
  if (runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoDir })) {
    throw new Error(`Managed source checkout has local changes: ${repoDir}`);
  }
}

interface StagedPathRemoval {
  commit: () => void;
  rollback: () => void;
}

function ownedPathRemovalPaths(target: string, transactionId: string): SourceRemovalPathState {
  const activePath = path.resolve(target);
  return {
    activePath,
    stagedPath: path.join(
      path.dirname(activePath),
      `.removing-${path.basename(activePath)}-${transactionId}`
    ),
  };
}

function sourcePathIdentity(target: string): SourcePathIdentity {
  const stat = fs.lstatSync(target, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
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

function ownedPathAdditionPaths(namespace: string, transactionId: string): SourceRemovalPathState {
  const activePath = managedCheckoutPath(namespace);
  return {
    activePath,
    stagedPath: path.join(
      path.dirname(activePath),
      `.adding-${path.basename(activePath)}-${transactionId}`
    ),
  };
}

function stageOwnedPathRemoval(paths: SourceRemovalPathState): StagedPathRemoval {
  const { activePath: target, stagedPath } = paths;
  if (!fs.existsSync(target)) throw new Error(`Source removal path is missing: ${target}`);
  assertSourcePathIdentity(paths, target);
  fs.renameSync(target, stagedPath);
  let staged = true;
  return {
    commit: () => {
      if (!staged) return;
      assertSourcePathIdentity(paths, stagedPath);
      fs.rmSync(stagedPath, { recursive: true, force: true });
      staged = false;
    },
    rollback: () => {
      if (!staged) return;
      if (fs.existsSync(target))
        throw new Error(`Source rollback target already exists: ${target}`);
      assertSourcePathIdentity(paths, stagedPath);
      fs.renameSync(stagedPath, target);
      staged = false;
    },
  };
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
  const config = loadSwitchboardConfig(scopeToLayerOptions(scope));
  for (const namespace of Object.keys(config.plugins.sources))
    validateConfiguredNamespace(namespace);
  recoverPendingSourceTransactions();
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
    return resolveSourceSubdir(managedCheckoutPath(namespace), value.subdir);
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
  let targetExists = false;
  try {
    fs.lstatSync(resolved);
    targetExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!targetExists) return resolved;
  try {
    const rootReal = fs.realpathSync.native(sourceRoot);
    const targetReal = fs.realpathSync.native(resolved);
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

function ensureNamespaceAvailableCurrent(namespace: string, configPath: string): void {
  const configured = loadConfigLayerFile(configPath).config.plugins?.sources ?? {};
  assertManagedPluginsRoot();
  if (namespace in configured || pathEntryExists(managedCheckoutPath(namespace))) {
    throw new Error(
      `Source "${namespace}" already exists. Use a different name or remove it first.`
    );
  }
}

function assertConfiguredCheckoutIfPresent(namespace: string, value: SourceValue): void {
  if (
    typeof value === 'string' ||
    value.type === 'subtree' ||
    !isCloneableSource(expandHome(value.url))
  ) {
    return;
  }
  const checkoutPath = managedCheckoutPath(namespace);
  if (pathEntryExists(checkoutPath)) {
    assertManagedCheckoutIdentity(checkoutPath, value.url, value.ref);
  }
}

// ── Auto-discovery ─────────────────────────────────────────────────

/**
 * Discover plugin sources from `~/.asb/plugins/`.
 * Each immediate subdirectory (excluding dotfiles) is treated as a source
 * whose namespace equals the directory name.
 */
function discoverLocalSources(): Record<string, string> {
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) return {};

  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() && fs.statSync(path.join(pluginsDir, entry.name)).isDirectory());
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
  const state = reconcilePluginSourceState(namespace, descriptorKey, expectedCanonicalPath, scope);
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
  const descriptorKey = sourceDescriptorKey(namespace, value);
  const state = reconcilePluginSourceState(
    namespace,
    descriptorKey,
    canonicalSourcePath(expectedPath),
    scope
  );
  setPluginSourceKind(state, sourceKind);
}

function reconcilePluginSourceState(
  namespace: string,
  descriptorKey: string,
  expectedPath: string,
  scope?: ConfigScope
): PluginSourceState {
  let state = ensurePluginSourceState(namespace, descriptorKey, expectedPath);
  while (state.descriptorKey !== descriptorKey || state.marketplacePath !== expectedPath) {
    const observed = state;
    withMarketplaceSourceLock(namespace, observed.marketplacePath, () => {
      const currentState = readPluginSourceState(namespace);
      if (!currentState) {
        state = ensurePluginSourceState(namespace, descriptorKey, expectedPath);
        return;
      }
      if (currentState.incarnation !== observed.incarnation) {
        state = currentState;
        return;
      }
      if (
        currentState.descriptorKey === descriptorKey &&
        currentState.marketplacePath === expectedPath
      ) {
        state = currentState;
        return;
      }
      if (
        sourceDescriptorKey(namespace, getRawSources(scope)[namespace]) !== descriptorKey ||
        !resolvedSourceOwnerIsCurrent(namespace, expectedPath, scope, false)
      ) {
        throw new Error(`Marketplace source "${namespace}" is no longer active.`);
      }
      removeMarketplaceEntryCache(namespace, currentState.marketplacePath);
      state = rotatePluginSourceState(namespace, descriptorKey, expectedPath);
    });
  }
  return state;
}

function canonicalSourcePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sourceDescriptorIdentity(value: SourceValue | undefined): string {
  if (value === undefined) return 'discovered';
  if (typeof value === 'string') return JSON.stringify(['local', value]);
  return JSON.stringify(['remote', value.url, value.type, value.ref ?? null, value.subdir ?? null]);
}

function sourceDescriptorKey(namespace: string, value: SourceValue | undefined): string {
  const identity =
    value === undefined
      ? JSON.stringify(['discovered', namespace])
      : sourceDescriptorIdentity(value);
  return createHash('sha256').update(identity).digest('hex');
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
    for (const state of pending) {
      withMarketplaceSourceLock(state.namespace, state.marketplacePath, () => {
        if (!pluginSourceStateIsCurrent(state)) return;
        const transaction = state.addition ?? state.removal;
        if (!transaction) return;
        withConfigFileTransaction(transaction.configPath, () => {
          const current = loadConfigLayerFile(transaction.configPath).config.plugins?.sources?.[
            state.namespace
          ];
          const sourceIsActive =
            current !== undefined &&
            sourceDescriptorKey(state.namespace, current) === state.descriptorKey;
          if (state.addition) {
            if (sourceIsActive) commitInterruptedSourceAddition(state);
            else rollbackInterruptedSourceAddition(state);
          } else if (sourceIsActive) rollbackInterruptedSourceRemoval(state);
          else commitInterruptedSourceRemoval(state);
        });
      });
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
      !path.basename(paths.stagedPath).startsWith(`.removing-${state.namespace}-`)
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
      .startsWith(`.adding-${state.namespace}-${addition.transactionId}`)
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
    addition.prefix !== expectedPrefix
  ) {
    throw new Error(`Invalid subtree addition state for "${state.namespace}".`);
  }
  return addition;
}

function sourceAdditionMarker(checkoutPath: string): string {
  return path.join(checkoutPath, '.git', 'asb-source-owner');
}

function assertSourceAdditionMarker(state: PluginSourceState, checkoutPath: string): string {
  const markerPath = sourceAdditionMarker(checkoutPath);
  if (!fs.existsSync(markerPath)) {
    throw new Error(`Plugin source addition ownership is missing for "${state.namespace}".`);
  }
  if (fs.readFileSync(markerPath, 'utf-8') !== `${state.incarnation}\n`) {
    throw new Error(`Plugin source addition ownership changed for "${state.namespace}".`);
  }
  return markerPath;
}

function commitInterruptedSourceAddition(state: PluginSourceState): void {
  if (state.addition?.kind === 'subtree') {
    commitInterruptedSubtreeAddition(state);
    return;
  }
  const paths = assertAdditionPathState(state);
  if (fs.existsSync(paths.activePath) && fs.existsSync(paths.stagedPath)) {
    throw new Error(`Source addition found both staged and active checkouts: ${state.namespace}`);
  }
  if (!fs.existsSync(paths.activePath)) {
    if (!fs.existsSync(paths.stagedPath)) {
      throw new Error(`Source addition checkout is missing for "${state.namespace}".`);
    }
    assertSourceAdditionMarker(state, paths.stagedPath);
    fs.renameSync(paths.stagedPath, paths.activePath);
  }
  assertSourceAdditionMarker(state, paths.activePath);
  clearPluginSourceAddition(state);
}

function rollbackInterruptedSourceAddition(state: PluginSourceState): void {
  if (state.addition?.kind === 'subtree') {
    rollbackInterruptedSubtreeAddition(state);
    return;
  }
  const paths = assertAdditionPathState(state);
  if (fs.existsSync(paths.activePath)) {
    assertSourceAdditionMarker(state, paths.activePath);
    fs.rmSync(paths.activePath, { recursive: true, force: true });
  }
  if (fs.existsSync(paths.stagedPath)) {
    assertSourceAdditionMarker(state, paths.stagedPath);
    fs.rmSync(paths.stagedPath, { recursive: true, force: true });
  }
  deletePluginSourceState(state);
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

function commitInterruptedSubtreeAddition(state: PluginSourceState): void {
  const addition = assertSubtreeAdditionState(state);
  assertSubtreeHeadRef(state.namespace, addition);
  if (!addition.headAfter) {
    throw new Error(`Subtree addition commit is missing for "${state.namespace}".`);
  }
  assertSubtreeTransactionCommit(state.namespace, addition, addition.headAfter);
  if (
    tryRunGit(['merge-base', '--is-ancestor', addition.headAfter, 'HEAD'], addition.repoRoot) ===
      null ||
    !fs.existsSync(path.join(addition.repoRoot, addition.prefix))
  ) {
    throw new Error(`Subtree addition commit is no longer active for "${state.namespace}".`);
  }
  clearPluginSourceAddition(state);
}

function rollbackInterruptedSubtreeAddition(state: PluginSourceState): void {
  const addition = assertSubtreeAdditionState(state);
  assertSubtreeHeadRef(state.namespace, addition);
  const currentHead = runGit(['rev-parse', 'HEAD'], { cwd: addition.repoRoot });
  if (currentHead === addition.headBefore) {
    ensureCleanTree(addition.repoRoot);
    if (fs.existsSync(path.join(addition.repoRoot, addition.prefix))) {
      throw new Error(`Subtree addition found foreign content for "${state.namespace}".`);
    }
    deletePluginSourceState(state);
    return;
  }
  if (addition.headAfter && currentHead !== addition.headAfter) {
    throw new Error(`Subtree addition rollback refused because repository HEAD changed.`);
  }
  assertSubtreeTransactionCommit(state.namespace, addition, currentHead);
  ensureCleanTree(addition.repoRoot);
  runGit(['reset', '--hard', addition.headBefore], { cwd: addition.repoRoot });
  deletePluginSourceState(state);
}

function rollbackRemovalPath(paths: SourceRemovalPathState): void {
  const activeExists = fs.existsSync(paths.activePath);
  const stagedExists = fs.existsSync(paths.stagedPath);
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
  if (fs.existsSync(paths.activePath)) {
    throw new Error(`Source recovery found a new active path: ${paths.activePath}`);
  }
  if (fs.existsSync(paths.stagedPath)) {
    assertSourcePathIdentity(paths, paths.stagedPath);
    fs.rmSync(paths.stagedPath, { recursive: true, force: true });
  }
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
    if (fs.existsSync(path.join(subtree.repoRoot, subtree.relativePath))) return;
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

function rollbackInterruptedSourceRemoval(state: PluginSourceState): void {
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
  clearPluginSourceRemoval(state);
}

function commitInterruptedSourceRemoval(state: PluginSourceState): void {
  const removal = state.removal;
  if (!removal) return;
  if (removal.checkout) {
    assertRemovalPathState(state, 'checkout', removal.checkout);
    commitRemovalPath(removal.checkout);
  }
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
export function addLocalSource(namespace: string, libraryPath: string): void {
  const resolvedPath = path.resolve(libraryPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }

  validateNewNamespace(namespace);
  getRawSources();

  const pluginsChild = managedCheckoutPath(namespace);
  const configValue = resolvedPath === pluginsChild ? namespace : resolvedPath;
  withConfigLayerTransaction((configCarrier) => {
    const configPath = resolveConfigWritePath(configCarrier);
    ensureNamespaceAvailableCurrent(namespace, configPath);
    let state: PluginSourceState | undefined;
    try {
      state = rotatePluginSourceState(
        namespace,
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
  });
}

/**
 * Add a remote Git source under the first-class plugin source directory.
 */
export function addRemoteSource(namespace: string, remote: RemoteSource): void {
  validateNewNamespace(namespace);
  assertManagedPluginsRoot();
  getRawSources();
  ensureGitAvailable();
  const configValue: RemoteSource = { url: remote.url, type: remote.type };
  if (remote.ref) configValue.ref = remote.ref;
  if (remote.subdir) configValue.subdir = remote.subdir;
  const effectivePath = resolveEffectivePath(namespace, configValue);

  withMarketplaceSourceLock(namespace, effectivePath, () => {
    withConfigLayerTransaction((configCarrier) => {
      const configPath = resolveConfigWritePath(configCarrier);
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
        ensureCleanTree(repoRoot);
        const prefix = `plugins/${namespace}`;
        const transactionId = randomUUID();
        const headBefore = runGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
        const addition: Extract<SourceAdditionState, { kind: 'subtree' }> = {
          kind: 'subtree',
          configPath,
          repoRoot: path.resolve(repoRoot),
          prefix,
          headBefore,
          headRef: symbolicHead(repoRoot),
          transactionId,
        };
        let state = rotatePluginSourceState(
          namespace,
          sourceDescriptorKey(namespace, configValue),
          canonicalSourcePath(effectivePath)
        );
        state = beginPluginSourceAddition(state, addition);
        let configCommitted = false;
        try {
          gitSubtreeAdd(repoRoot, prefix, expandHome(remote.url), remote.ref, transactionId);
          const headAfter = runGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
          state = updatePluginSourceAddition(state, { ...addition, headAfter });
          resolveSourceSubdir(managedCheckoutPath(namespace), remote.subdir);
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
        }
        return;
      }

      const transactionId = randomUUID();
      const checkout = ownedPathAdditionPaths(namespace, transactionId);
      let state: PluginSourceState | undefined;
      let additionState: PluginSourceState | undefined;
      let configCommitted = false;
      try {
        state = rotatePluginSourceState(
          namespace,
          sourceDescriptorKey(namespace, configValue),
          canonicalSourcePath(effectivePath)
        );
        additionState = beginPluginSourceAddition(state, {
          kind: 'clone',
          configPath,
          checkout,
          transactionId,
        });
        gitClone(expandHome(remote.url), checkout.stagedPath, remote.ref);
        fs.writeFileSync(sourceAdditionMarker(checkout.stagedPath), `${state.incarnation}\n`, {
          flag: 'wx',
        });
        assertManagedCheckoutIdentity(checkout.stagedPath, remote.url, remote.ref);
        resolveSourceSubdir(checkout.stagedPath, remote.subdir);
        assertManagedPluginsRoot();
        if (pathEntryExists(checkout.activePath)) {
          throw new Error(`Source checkout appeared during publication: ${checkout.activePath}`);
        }
        fs.renameSync(checkout.stagedPath, checkout.activePath);
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
      }
    });
  });
}

/**
 * Remove a configured source and its source-owned derived state.
 */
export function removeSource(namespace: string): void {
  const raw = getRawSources();
  if (!(namespace in raw)) {
    throw new Error(`Source "${namespace}" not found.`);
  }

  const value = raw[namespace];
  const effectivePath = resolveEffectivePath(namespace, value);
  const descriptorKey = sourceDescriptorKey(namespace, value);
  const sourceState = reconcilePluginSourceState(
    namespace,
    descriptorKey,
    canonicalSourcePath(effectivePath)
  );
  const cacheOwnerPath = sourceState.marketplacePath;
  withMarketplaceSourceLock(namespace, cacheOwnerPath, () => {
    withConfigLayerTransaction((configCarrier) => {
      const configPath = resolveConfigWritePath(configCarrier);
      const current = loadConfigLayerFile(configPath).config.plugins?.sources?.[namespace];
      if (
        sourceDescriptorIdentity(current) !== sourceDescriptorIdentity(value) ||
        !pluginSourceStateIsCurrent(sourceState)
      ) {
        throw new Error(`Source "${namespace}" changed while waiting for its lifecycle lock.`);
      }
      const remote = typeof value !== 'string' && isCloneableSource(expandHome(value.url));
      const pluginDir = managedCheckoutPath(namespace);
      if (remote && value.type === 'subtree') {
        if (!isGitRepo(getConfigDir())) {
          throw new Error(
            `Source "${namespace}" is configured as subtree but ASB_HOME is not a git repo root. Cannot safely remove.`
          );
        }
        if (fs.existsSync(pluginDir)) ensureCleanTree(getConfigDir());
      }

      const transactionId = randomUUID();
      const preparedCachePaths = marketplaceEntryCacheRemovalPaths(
        namespace,
        cacheOwnerPath,
        transactionId
      );
      const preparedCheckoutPaths = ownedPathRemovalPaths(pluginDir, transactionId);
      const cachePaths = fs.existsSync(preparedCachePaths.activePath)
        ? persistRemovalIdentity(preparedCachePaths)
        : preparedCachePaths;
      const checkoutPaths = fs.existsSync(preparedCheckoutPaths.activePath)
        ? persistRemovalIdentity(preparedCheckoutPaths)
        : preparedCheckoutPaths;
      const removal = {
        configPath,
        ...(fs.existsSync(cachePaths.activePath) ? { cache: cachePaths } : {}),
        ...(remote && value.type !== 'subtree' && fs.existsSync(checkoutPaths.activePath)
          ? { checkout: checkoutPaths }
          : {}),
        ...(remote && value.type === 'subtree' && fs.existsSync(pluginDir)
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
        if (remote && value.type === 'subtree' && fs.existsSync(pluginDir)) {
          subtreeTouched = true;
          runGit(['rm', '-r', `plugins/${namespace}`], { cwd: getConfigDir() });
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
        checkoutStage.commit();
        cacheStage.commit();
        deletePluginSourceState(removalState);
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
      withMarketplaceSourceLock(namespace, effectivePath, () => {
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
          ensureCleanTree(repoRoot);
          const prefix = `plugins/${namespace}`;
          const prefixDir = path.join(repoRoot, prefix);
          if (!fs.existsSync(prefixDir)) {
            gitSubtreeAdd(repoRoot, prefix, expandHome(value.url), value.ref, randomUUID());
          } else {
            try {
              gitSubtreePull(repoRoot, prefix, expandHome(value.url), value.ref);
            } catch (pullErr) {
              // Abort merge if conflict left repo in unmerged state
              try {
                const mergeHeadPath = runGit(['rev-parse', '--git-path', 'MERGE_HEAD'], {
                  cwd: repoRoot,
                });
                if (fs.existsSync(path.resolve(repoRoot, mergeHeadPath))) {
                  runGit(['merge', '--abort'], { cwd: repoRoot });
                }
              } catch {
                /* best-effort cleanup */
              }
              throw pullErr;
            }
          }
        } else {
          assertManagedPluginsRoot();
          const cloneDir = managedCheckoutPath(namespace);
          if (!pathEntryExists(cloneDir)) {
            const stagedPath = path.join(
              path.dirname(cloneDir),
              `.updating-${path.basename(cloneDir)}-${randomUUID()}`
            );
            try {
              gitClone(expandHome(value.url), stagedPath, value.ref);
              assertManagedCheckoutIdentity(stagedPath, value.url, value.ref);
              resolveSourceSubdir(stagedPath, value.subdir);
              if (
                sourceDescriptorIdentity(getRawSources(scope)[namespace]) !==
                sourceDescriptorIdentity(value)
              ) {
                throw new Error(`Source "${namespace}" changed before checkout publication.`);
              }
              assertManagedPluginsRoot();
              if (pathEntryExists(cloneDir)) {
                throw new Error(`Source checkout appeared during publication: ${cloneDir}`);
              }
              fs.renameSync(stagedPath, cloneDir);
            } finally {
              if (fs.existsSync(stagedPath)) {
                fs.rmSync(stagedPath, { recursive: true, force: true });
              }
            }
          } else {
            const branch = assertManagedCheckoutIdentity(cloneDir, value.url, value.ref);
            gitPull(cloneDir, branch, value.ref);
            assertManagedCheckoutIdentity(cloneDir, value.url, value.ref);
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
          const descriptorKey = sourceDescriptorKey(namespace, value);
          const state = reconcilePluginSourceState(
            namespace,
            descriptorKey,
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
    const descriptorKey = sourceDescriptorKey(source.namespace, value);
    const state = reconcilePluginSourceState(
      source.namespace,
      descriptorKey,
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
      withMarketplaceSourceLock(source.namespace, ownerPath, () => {
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
