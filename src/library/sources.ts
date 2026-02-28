/**
 * Library source management utilities.
 * Handles adding, removing, and listing external library sources.
 * Supports both local directory paths and remote git repository URLs.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { updateConfigLayer } from '../config/layered-config.js';
import { getSourceCacheDir } from '../config/paths.js';
import type { RemoteSource, SourceValue } from '../config/schemas.js';
import { loadSwitchboardConfig } from '../config/switchboard-config.js';

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

// ── URL detection and parsing ──────────────────────────────────────

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(source);
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

// ── Config access helpers ──────────────────────────────────────────

function getRawSources(): Record<string, SourceValue> {
  const config = loadSwitchboardConfig();
  return config.library.sources;
}

function resolveEffectivePath(namespace: string, value: SourceValue): string {
  if (typeof value === 'string') return value;
  let effectivePath = getSourceCacheDir(namespace);
  if (value.subdir) effectivePath = path.join(effectivePath, value.subdir);
  return effectivePath;
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
  if (hasSource(namespace)) {
    throw new Error(
      `Source "${namespace}" already exists. Use a different name or remove it first.`
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────

export function getSources(): Source[] {
  const raw = getRawSources();
  return Object.entries(raw).map(([namespace, value]) => {
    const effectivePath = resolveEffectivePath(namespace, value);
    if (typeof value === 'string') {
      return { namespace, path: effectivePath };
    }
    return { namespace, path: effectivePath, remote: value };
  });
}

/**
 * Get sources as namespace -> effective local path.
 * Remote sources are transparently resolved to their cache directory.
 */
export function getSourcesRecord(): Record<string, string> {
  const raw = getRawSources();
  const result: Record<string, string> = {};
  for (const [namespace, value] of Object.entries(raw)) {
    result[namespace] = resolveEffectivePath(namespace, value);
  }
  return result;
}

export function hasSource(namespace: string): boolean {
  return namespace in getRawSources();
}

/**
 * Add a local directory source.
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

  updateConfigLayer((layer) => ({
    ...layer,
    library: {
      ...layer.library,
      sources: {
        ...(layer.library?.sources ?? {}),
        [namespace]: resolvedPath,
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

  const cacheDir = getSourceCacheDir(namespace);
  gitClone(remote.url, cacheDir, remote.ref);

  const configValue: RemoteSource = { url: remote.url };
  if (remote.ref) configValue.ref = remote.ref;
  if (remote.subdir) configValue.subdir = remote.subdir;

  updateConfigLayer((layer) => ({
    ...layer,
    library: {
      ...layer.library,
      sources: {
        ...(layer.library?.sources ?? {}),
        [namespace]: configValue,
      },
    },
  }));
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

  updateConfigLayer((layer) => {
    const newSources = { ...(layer.library?.sources ?? {}) };
    delete newSources[namespace];
    return {
      ...layer,
      library: {
        ...layer.library,
        sources: newSources,
      },
    };
  });

  if (typeof value !== 'string') {
    const cacheDir = getSourceCacheDir(namespace);
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }
}

/**
 * Validate a local path has expected library structure.
 */
export function validateSourcePath(libraryPath: string): {
  valid: boolean;
  found: string[];
  missing: string[];
} {
  const resolvedPath = path.resolve(libraryPath);
  const libraryTypes = ['rules', 'commands', 'subagents', 'skills'];
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

  return { valid: found.length > 0, found, missing };
}

/**
 * Pull latest changes for all remote sources.
 * Re-clones if the cache directory is missing or corrupted.
 */
export function updateRemoteSources(): SourceUpdateResult[] {
  const raw = getRawSources();
  const results: SourceUpdateResult[] = [];

  for (const [namespace, value] of Object.entries(raw)) {
    if (typeof value === 'string') continue;

    const cacheDir = getSourceCacheDir(namespace);
    const gitDir = path.join(cacheDir, '.git');

    try {
      ensureGitAvailable();
      if (!fs.existsSync(gitDir)) {
        gitClone(value.url, cacheDir, value.ref);
      } else {
        gitPull(cacheDir);
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
