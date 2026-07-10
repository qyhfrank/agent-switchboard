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
  updateConfigLayer,
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
  stageMarketplaceEntryCacheRemoval,
  withMarketplaceSourceLock,
} from '../marketplace/cache.js';
import {
  getMarketplaceManifestInfo,
  getPluginManifestInfo,
  refreshMarketplacePluginCache,
} from '../marketplace/reader.js';
import {
  beginPluginSourceRemoval,
  clearPluginSourceRemoval,
  deletePluginSourceState,
  ensurePluginSourceState,
  listPendingPluginSourceRemovals,
  type PluginSourceState,
  pluginSourceStateIsCurrent,
  readPluginSourceState,
  rotatePluginSourceState,
  type SourceRemovalPathState,
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
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(url, targetDir);
  runGit(args);
}

function gitPull(repoDir: string): void {
  runGit(['pull'], { cwd: repoDir });
}

function gitSubtreeAdd(repoRoot: string, prefix: string, url: string, ref: string): void {
  runGit(['subtree', 'add', '--prefix', prefix, url, ref], { cwd: repoRoot });
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

function stageOwnedPathRemoval(paths: SourceRemovalPathState): StagedPathRemoval {
  const { activePath: target, stagedPath } = paths;
  if (!fs.existsSync(target)) return { commit: () => {}, rollback: () => {} };
  fs.renameSync(target, stagedPath);
  let staged = true;
  return {
    commit: () => {
      if (!staged) return;
      fs.rmSync(stagedPath, { recursive: true, force: true });
      staged = false;
    },
    rollback: () => {
      if (!staged) return;
      if (fs.existsSync(target))
        throw new Error(`Source rollback target already exists: ${target}`);
      fs.renameSync(stagedPath, target);
      staged = false;
    },
  };
}

// ── URL detection and parsing ──────────────────────────────────────

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/)/.test(source) || isScpGitUrl(source);
}

function isScpGitUrl(source: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(source)) return false;
  return /^(?:[^@/:\\\s]+@)?[^@/:\\\s]+:.+$/.test(source);
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
  recoverPendingSourceRemovals();
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
      let effectivePath = resolveLocalPath(expanded);
      if (value.subdir) effectivePath = path.join(effectivePath, value.subdir);
      return effectivePath;
    }
    let effectivePath = path.join(getPluginsDir(), namespace);
    if (value.subdir) effectivePath = path.join(effectivePath, value.subdir);
    return effectivePath;
  }
  return resolveLocalPath(expandHome(value));
}

// ── Validation helpers ─────────────────────────────────────────────

function validateNamespace(namespace: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}". Use only letters, numbers, hyphens, and underscores.`
    );
  }
}

function ensureNamespaceAvailableCurrent(namespace: string): void {
  const configured = loadSwitchboardConfig().plugins.sources;
  if (namespace in configured || fs.existsSync(path.join(getPluginsDir(), namespace))) {
    throw new Error(
      `Source "${namespace}" already exists. Use a different name or remove it first.`
    );
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
export function getSources(scope?: ConfigScope): Source[] {
  const raw = getRawSources(scope);
  const discovered = discoverLocalSources();

  const merged = new Map<string, { value?: SourceValue; path: string }>();

  for (const [ns, effectivePath] of Object.entries(discovered)) {
    merged.set(ns, { path: effectivePath });
  }
  for (const [ns, value] of Object.entries(raw)) {
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

/**
 * Get sources as namespace -> effective local path.
 * Merges auto-discovered and explicitly configured sources.
 */
export function getSourcesRecord(scope?: ConfigScope): Record<string, string> {
  const raw = getRawSources(scope);
  const result = discoverLocalSources();
  for (const [namespace, value] of Object.entries(raw)) {
    result[namespace] = resolveEffectivePath(namespace, value);
  }
  return result;
}

export function sourceOwnerIsCurrent(
  namespace: string,
  expectedPath: string,
  scope?: ConfigScope
): boolean {
  const currentPath = getSourcesRecord(scope)[namespace];
  if (!currentPath) return false;
  return canonicalSourcePath(currentPath) === canonicalSourcePath(expectedPath);
}

export function captureSourceOwnerValidator(
  namespace: string,
  expectedPath: string,
  scope?: ConfigScope
): () => boolean {
  const value = getRawSources(scope)[namespace];
  const descriptorKey = sourceDescriptorKey(namespace, value, expectedPath);
  const expectedCanonicalPath = canonicalSourcePath(expectedPath);
  if (isTemporaryMarketplaceEntryCache()) {
    return () =>
      sourceDescriptorKey(namespace, getRawSources(scope)[namespace], expectedPath) ===
        descriptorKey && sourceOwnerIsCurrent(namespace, expectedCanonicalPath, scope);
  }
  const state = reconcilePluginSourceState(namespace, descriptorKey, expectedCanonicalPath, scope);
  return () =>
    sourceDescriptorKey(namespace, getRawSources(scope)[namespace], expectedPath) ===
      descriptorKey &&
    sourceOwnerIsCurrent(namespace, state.marketplacePath, scope) &&
    pluginSourceStateIsCurrent(state);
}

function reconcilePluginSourceState(
  namespace: string,
  descriptorKey: string,
  expectedPath: string,
  scope?: ConfigScope
): PluginSourceState {
  let state = ensurePluginSourceState(namespace, descriptorKey, expectedPath);
  while (state.marketplacePath !== expectedPath) {
    const observed = state;
    withMarketplaceSourceLock(namespace, observed.marketplacePath, () => {
      const currentState = readPluginSourceState(namespace, descriptorKey);
      if (!currentState) {
        state = ensurePluginSourceState(namespace, descriptorKey, expectedPath);
        return;
      }
      if (currentState.marketplacePath === expectedPath) {
        state = currentState;
        return;
      }
      if (
        sourceDescriptorKey(namespace, getRawSources(scope)[namespace], expectedPath) !==
          descriptorKey ||
        !sourceOwnerIsCurrent(namespace, expectedPath, scope)
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

function sourceDescriptorKey(
  namespace: string,
  value: SourceValue | undefined,
  expectedPath: string
): string {
  const identity =
    value === undefined
      ? JSON.stringify(['discovered', namespace, canonicalSourcePath(expectedPath)])
      : sourceDescriptorIdentity(value);
  return createHash('sha256').update(identity).digest('hex');
}

let recoveringSourceRemovals = false;

function recoverPendingSourceRemovals(): void {
  if (recoveringSourceRemovals) return;
  recoveringSourceRemovals = true;
  try {
    for (const state of listPendingPluginSourceRemovals()) {
      withMarketplaceSourceLock(state.namespace, state.marketplacePath, () => {
        if (!pluginSourceStateIsCurrent(state) || !state.removal) return;
        const removal = state.removal;
        withConfigFileTransaction(removal.configPath, () => {
          const current = loadConfigLayerFile(removal.configPath).config.plugins?.sources?.[
            state.namespace
          ];
          const sourceIsActive =
            current !== undefined &&
            sourceDescriptorKey(state.namespace, current, state.marketplacePath) ===
              state.descriptorKey;
          if (sourceIsActive) rollbackInterruptedSourceRemoval(state);
          else commitInterruptedSourceRemoval(state);
        });
      });
    }
  } finally {
    recoveringSourceRemovals = false;
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
    const activePath = path.join(pluginsRoot, state.namespace);
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

function rollbackRemovalPath(paths: SourceRemovalPathState): void {
  const activeExists = fs.existsSync(paths.activePath);
  const stagedExists = fs.existsSync(paths.stagedPath);
  if (activeExists && stagedExists) {
    throw new Error(`Source recovery target already exists: ${paths.activePath}`);
  }
  if (stagedExists) fs.renameSync(paths.stagedPath, paths.activePath);
  else if (!activeExists) throw new Error(`Source recovery path is missing: ${paths.activePath}`);
}

function commitRemovalPath(paths: SourceRemovalPathState): void {
  if (fs.existsSync(paths.activePath)) {
    throw new Error(`Source recovery found a new active path: ${paths.activePath}`);
  }
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

  validateNamespace(namespace);
  getRawSources();

  const pluginsChild = path.join(getPluginsDir(), namespace);
  const configValue = resolvedPath === pluginsChild ? namespace : resolvedPath;
  withConfigLayerTransaction(() => {
    ensureNamespaceAvailableCurrent(namespace);
    let state: PluginSourceState | undefined;
    try {
      state = rotatePluginSourceState(
        namespace,
        sourceDescriptorKey(namespace, configValue, resolvedPath),
        canonicalSourcePath(resolvedPath)
      );
      updateConfigLayer((layer) => ({
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
  validateNamespace(namespace);
  getRawSources();
  ensureGitAvailable();
  withConfigLayerTransaction(() => {
    ensureNamespaceAvailableCurrent(namespace);
    let headBefore: string | undefined;

    if (remote.type === 'subtree') {
      if (!isGitRepo(getConfigDir())) {
        throw new Error(
          `Subtree mode requires ASB_HOME to be a git repo root. Current ASB_HOME is not a git repo or is a subdirectory of one.`
        );
      }
      if (!remote.ref) {
        throw new Error(`Subtree sources require an explicit "ref" (e.g. ref = "main").`);
      }
      const repoRoot = getConfigDir();
      ensureCleanTree(repoRoot);
      const prefix = `plugins/${namespace}`;
      headBefore = runGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
      gitSubtreeAdd(repoRoot, prefix, expandHome(remote.url), remote.ref);
    } else {
      const cloneDir = path.join(getPluginsDir(), namespace);
      gitClone(expandHome(remote.url), cloneDir, remote.ref);
    }

    const configValue: RemoteSource = { url: remote.url, type: remote.type };
    if (remote.ref) configValue.ref = remote.ref;
    if (remote.subdir) configValue.subdir = remote.subdir;
    const effectivePath = resolveEffectivePath(namespace, configValue);
    let state: PluginSourceState | undefined;

    try {
      state = rotatePluginSourceState(
        namespace,
        sourceDescriptorKey(namespace, configValue, effectivePath),
        canonicalSourcePath(effectivePath)
      );
      updateConfigLayer((layer) => ({
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
    } catch (configErr) {
      if (state) deletePluginSourceState(state);
      if (remote.type === 'subtree' && headBefore) {
        try {
          runGit(['reset', '--hard', headBefore], { cwd: getConfigDir() });
        } catch {
          /* best-effort rollback */
        }
      } else {
        const cloneDir = path.join(getPluginsDir(), namespace);
        if (fs.existsSync(cloneDir)) {
          fs.rmSync(cloneDir, { recursive: true, force: true });
        }
      }
      throw configErr;
    }
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
  const descriptorKey = sourceDescriptorKey(namespace, value, effectivePath);
  const sourceState =
    readPluginSourceState(namespace, descriptorKey) ??
    ensurePluginSourceState(namespace, descriptorKey, canonicalSourcePath(effectivePath));
  const cacheOwnerPath = sourceState.marketplacePath;
  withMarketplaceSourceLock(namespace, cacheOwnerPath, () => {
    withConfigLayerTransaction((configPath) => {
      const current = loadSwitchboardConfig().plugins.sources[namespace];
      if (
        sourceDescriptorIdentity(current) !== sourceDescriptorIdentity(value) ||
        !pluginSourceStateIsCurrent(sourceState)
      ) {
        throw new Error(`Source "${namespace}" changed while waiting for its lifecycle lock.`);
      }
      const remote = typeof value !== 'string' && isCloneableSource(expandHome(value.url));
      const pluginDir = path.join(getPluginsDir(), namespace);
      if (remote && value.type === 'subtree') {
        if (!isGitRepo(getConfigDir())) {
          throw new Error(
            `Source "${namespace}" is configured as subtree but ASB_HOME is not a git repo root. Cannot safely remove.`
          );
        }
        if (fs.existsSync(pluginDir)) ensureCleanTree(getConfigDir());
      }

      const transactionId = randomUUID();
      const cachePaths = marketplaceEntryCacheRemovalPaths(
        namespace,
        cacheOwnerPath,
        transactionId
      );
      const checkoutPaths = ownedPathRemovalPaths(pluginDir, transactionId);
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
        cacheStage = stageMarketplaceEntryCacheRemoval(namespace, cacheOwnerPath, cachePaths);
        if (remote && value.type === 'subtree' && fs.existsSync(pluginDir)) {
          subtreeTouched = true;
          runGit(['rm', '-r', `plugins/${namespace}`], { cwd: getConfigDir() });
        } else if (remote) {
          checkoutStage = stageOwnedPathRemoval(checkoutPaths);
        }

        updateConfigLayer((layer) => {
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
 * Re-clones if the cache directory is missing or corrupted.
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
      const ownerValidator = captureSourceOwnerValidator(namespace, effectivePath, scope);
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
            gitSubtreeAdd(repoRoot, prefix, expandHome(value.url), value.ref);
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
          const cloneDir = path.join(getPluginsDir(), namespace);
          const gitDir = path.join(cloneDir, '.git');
          if (!fs.existsSync(gitDir)) {
            gitClone(expandHome(value.url), cloneDir, value.ref);
          } else {
            gitPull(cloneDir);
          }
        }
        if (getMarketplaceManifestInfo(effectivePath)) {
          refreshMarketplacePluginCache(effectivePath, namespace, ownerValidator);
        } else {
          removeMarketplaceEntryCache(namespace, effectivePath);
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

  for (const source of getSources(scope)) {
    if (onlyNamespace && source.namespace !== onlyNamespace) continue;
    if (handledNamespaces.has(source.namespace)) continue;
    const value = raw[source.namespace];
    const descriptorKey = sourceDescriptorKey(source.namespace, value, source.path);
    const state = readPluginSourceState(source.namespace, descriptorKey);
    const ownerPath = state?.marketplacePath ?? canonicalSourcePath(source.path);
    const isMarketplace = Boolean(getMarketplaceManifestInfo(source.path));
    if (!isMarketplace && !marketplaceEntryCacheExists(source.namespace, ownerPath)) continue;
    try {
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
