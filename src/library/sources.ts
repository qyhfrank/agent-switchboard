/**
 * Library source management utilities.
 * Handles adding, removing, and listing external library sources.
 * Supports both local directory paths and remote git repository URLs.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { updateConfigLayer } from '../config/layered-config.js';
import { expandHome, getConfigDir, getPluginsDir } from '../config/paths.js';
import type { RemoteSource, SourceValue } from '../config/schemas.js';
import { type ConfigScope, scopeToLayerOptions } from '../config/scope.js';
import { loadSwitchboardConfig } from '../config/switchboard-config.js';
import { getMarketplaceManifestInfo, getPluginManifestInfo } from '../marketplace/reader.js';

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
    throw new Error(
      `git ${args[0]} failed: ${stderr || (error instanceof Error ? error.message : String(error))}`
    );
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
  const status = runGit(['status', '--porcelain'], { cwd: dir });
  if (status.length > 0) {
    throw new Error(
      `ASB_HOME has uncommitted changes. Commit or stash them before subtree operations.`
    );
  }
}

// ── URL detection and parsing ──────────────────────────────────────

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(source);
}

/**
 * Determine whether an object-format source URL should be treated as a
 * cloneable git source (resolved via cache) rather than a direct local path.
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
 * - Cloneable sources (object with git/file URL or .git suffix): resolve to cache dir
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

function ensureNamespaceAvailable(namespace: string): void {
  if (namespace in getRawSources()) {
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
  const discovered = discoverLocalSources();
  const raw = getRawSources(scope);

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
  const result = discoverLocalSources();
  const raw = getRawSources(scope);
  for (const [namespace, value] of Object.entries(raw)) {
    result[namespace] = resolveEffectivePath(namespace, value);
  }
  return result;
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
  ensureNamespaceAvailable(namespace);

  const pluginsChild = path.join(getPluginsDir(), namespace);
  const configValue = resolvedPath === pluginsChild ? namespace : resolvedPath;

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
}

/**
 * Add a remote git source. Clones the repo into the local cache.
 */
export function addRemoteSource(namespace: string, remote: RemoteSource): void {
  validateNamespace(namespace);
  ensureNamespaceAvailable(namespace);
  ensureGitAvailable();

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

  try {
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
  } catch (configErr) {
    // Rollback: restore repo to pre-subtree-add state
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
}

/**
 * Remove a source and clean up its cache directory if remote.
 */
export function removeSource(namespace: string): void {
  const raw = getRawSources();
  if (!(namespace in raw)) {
    throw new Error(`Source "${namespace}" not found.`);
  }

  const value = raw[namespace];

  // For subtree sources, perform git rm first to avoid split-brain on failure
  if (typeof value !== 'string' && isCloneableSource(expandHome(value.url))) {
    const pluginDir = path.join(getPluginsDir(), namespace);
    if (value.type === 'subtree') {
      if (!isGitRepo(getConfigDir())) {
        throw new Error(
          `Source "${namespace}" is configured as subtree but ASB_HOME is not a git repo root. Cannot safely remove.`
        );
      }
      if (fs.existsSync(pluginDir)) {
        ensureCleanTree(getConfigDir());
        try {
          runGit(['rm', '-r', `plugins/${namespace}`], { cwd: getConfigDir() });
        } catch (err) {
          throw new Error(
            `Failed to git rm subtree "plugins/${namespace}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } else {
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
    }
  }

  try {
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
  } catch (configErr) {
    // Rollback git rm if config write fails (subtree only)
    if (typeof value !== 'string' && value.type === 'subtree' && isGitRepo(getConfigDir())) {
      try {
        runGit(['checkout', 'HEAD', '--', `plugins/${namespace}`], { cwd: getConfigDir() });
      } catch {
        /* best-effort rollback */
      }
    }
    throw configErr;
  }
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
export function updateRemoteSources(scope?: ConfigScope): SourceUpdateResult[] {
  const raw = getRawSources(scope);
  const results: SourceUpdateResult[] = [];
  let gitChecked = false;

  for (const [namespace, value] of Object.entries(raw)) {
    if (typeof value === 'string') continue;
    if (!isCloneableSource(expandHome(value.url))) continue;

    try {
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

  return results;
}
