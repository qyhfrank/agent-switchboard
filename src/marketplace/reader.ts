/**
 * Marketplace reader: detects and parses Claude Code marketplace repositories.
 *
 * A marketplace is a repository containing `.claude-plugin/marketplace.json`.
 * Each plugin is either a relative path within the same repo or a standalone
 * directory with `.claude-plugin/plugin.json`.
 *
 * PhaseB additions:
 *   - `github` / `git` URL source types resolve via shallow clone + cache
 *   - `strict` mode semantics (true => marketplace entry is authoritative)
 *   - `npm` / `pip` sources emit warnings (not yet implemented)
 *   - `ref` / `sha` pin support for reproducible builds
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getSourceCacheDir } from '../config/paths.js';
import {
  type MarketplaceManifest,
  marketplaceManifestSchema,
  type PluginEntry,
  type PluginManifest,
  pluginManifestSchema,
} from './schemas.js';

export interface ResolvedPlugin {
  name: string;
  description?: string;
  version?: string;
  /** Absolute path to the plugin root directory */
  localPath: string;
  /** Plugin manifest if `.claude-plugin/plugin.json` exists */
  manifest?: PluginManifest;
  /** Whether plugin is in strict mode */
  strict: boolean;
  /**
   * Custom component paths from the marketplace entry (strict mode) or
   * plugin.json (non-strict). Used by the plugin loader to override
   * default directory scanning.
   */
  customPaths?: {
    commands?: string[];
    agents?: string[];
  };
  /** MCP servers declared in the marketplace entry or plugin.json */
  mcpServers?: Record<string, unknown>;
}

export interface MarketplaceReadResult {
  name: string;
  owner: { name: string; email?: string };
  plugins: ResolvedPlugin[];
  warnings: string[];
}

const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/**
 * Check whether a local path is a Claude Code marketplace (has .claude-plugin/marketplace.json).
 */
export function isMarketplace(localPath: string): boolean {
  const manifestPath = path.join(localPath, MARKETPLACE_MANIFEST);
  return fs.existsSync(manifestPath);
}

/**
 * Check whether a local path is a formal single plugin (has .claude-plugin/plugin.json
 * but NOT marketplace.json).
 */
export function isFormalPlugin(localPath: string): boolean {
  if (isMarketplace(localPath)) return false;
  const pluginPath = path.join(localPath, PLUGIN_MANIFEST);
  return fs.existsSync(pluginPath);
}

/**
 * Read and resolve a marketplace, returning all resolvable plugins with metadata.
 */
export function readMarketplace(localPath: string): MarketplaceReadResult {
  const manifestPath = path.join(localPath, MARKETPLACE_MANIFEST);
  const warnings: string[] = [];

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const manifest: MarketplaceManifest = marketplaceManifestSchema.parse(raw);

  const pluginRoot = manifest.metadata?.pluginRoot ?? '';
  const plugins: ResolvedPlugin[] = [];
  const marketplaceNamespace = manifest.name.replace(/[^a-zA-Z0-9_-]/g, '-');

  for (const entry of manifest.plugins) {
    const resolved = resolvePluginDir(
      localPath,
      pluginRoot,
      entry.name,
      entry.source,
      marketplaceNamespace,
      entry.ref
    );
    if (!resolved) {
      warnings.push(`Plugin "${entry.name}": unsupported source type, skipped`);
      continue;
    }

    if (!fs.existsSync(resolved)) {
      warnings.push(`Plugin "${entry.name}": directory not found at ${resolved}`);
      continue;
    }

    const pluginManifest = readPluginManifest(resolved);
    const plugin = applyStrictMode(entry, pluginManifest, resolved);

    plugins.push(plugin);
  }

  return {
    name: manifest.name,
    owner: manifest.owner,
    plugins,
    warnings,
  };
}

// ── Strict mode ────────────────────────────────────────────────────

/**
 * Apply strict mode semantics to produce the final ResolvedPlugin.
 *
 * When `strict: true` (default): the marketplace entry is authoritative.
 *   - `commands`, `agents`, `mcpServers` from the entry take precedence.
 *   - `plugin.json` values are only used as fallback.
 *
 * When `strict: false`: `plugin.json` is authoritative.
 *   - The marketplace entry provides the source/name/version only.
 *   - Component paths and mcpServers come from `plugin.json`.
 */
function applyStrictMode(
  entry: PluginEntry,
  pluginManifest: PluginManifest | null,
  localPath: string
): ResolvedPlugin {
  const isStrict = entry.strict;

  const primary = isStrict ? entry : (pluginManifest ?? entry);
  const fallback = isStrict ? (pluginManifest ?? entry) : entry;

  const customCommands =
    normalizeStringArray(primary.commands) ?? normalizeStringArray(fallback.commands);
  const customAgents =
    normalizeStringArray(primary.agents) ?? normalizeStringArray(fallback.agents);
  const mcpServers =
    (primary.mcpServers as Record<string, unknown> | undefined) ??
    (fallback.mcpServers as Record<string, unknown> | undefined);

  const plugin: ResolvedPlugin = {
    name: entry.name,
    description: entry.description ?? pluginManifest?.description,
    version: entry.version ?? pluginManifest?.version,
    localPath,
    manifest: pluginManifest ?? undefined,
    strict: isStrict,
  };

  if (customCommands || customAgents) {
    plugin.customPaths = {};
    if (customCommands) plugin.customPaths.commands = customCommands;
    if (customAgents) plugin.customPaths.agents = customAgents;
  }

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    plugin.mcpServers = mcpServers;
  }

  return plugin;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return undefined;
}

// ── Source resolution ──────────────────────────────────────────────

function resolvePluginDir(
  marketplaceRoot: string,
  pluginRoot: string,
  pluginName: string,
  source: string | Record<string, unknown>,
  marketplaceNamespace: string,
  pinRef?: string
): string | null {
  if (typeof source === 'string') {
    if (source.startsWith('./') || source.startsWith('../') || !source.includes(':')) {
      return path.resolve(marketplaceRoot, pluginRoot, source);
    }
    return null;
  }

  // Local path source
  if (source.path && typeof source.path === 'string') {
    return path.resolve(marketplaceRoot, pluginRoot, source.path);
  }

  // GitHub shorthand: "org/repo" or full URL
  if (source.github && typeof source.github === 'string') {
    const ghUrl = source.github.includes('/')
      ? source.github.startsWith('http')
        ? source.github
        : `https://github.com/${source.github}`
      : null;
    if (!ghUrl) return null;

    const cloneUrl = ghUrl.endsWith('.git') ? ghUrl : `${ghUrl}.git`;
    const ref = pinRef ?? (source.ref as string | undefined);
    return cloneToCacheDir(marketplaceNamespace, pluginName, cloneUrl, ref);
  }

  // Git URL
  if (source.git && typeof source.git === 'string') {
    const ref = pinRef ?? (source.ref as string | undefined);
    return cloneToCacheDir(marketplaceNamespace, pluginName, source.git, ref);
  }

  // npm / pip: not yet implemented
  if (source.npm && typeof source.npm === 'string') {
    return null;
  }
  if (source.pip && typeof source.pip === 'string') {
    return null;
  }

  return null;
}

// ── Git caching ────────────────────────────────────────────────────

function cloneToCacheDir(
  marketplaceNamespace: string,
  pluginName: string,
  cloneUrl: string,
  ref?: string
): string | null {
  const cacheBase = path.join(
    getSourceCacheDir(),
    '.plugin-cache',
    marketplaceNamespace,
    pluginName
  );

  try {
    if (!fs.existsSync(path.join(cacheBase, '.git'))) {
      fs.mkdirSync(path.dirname(cacheBase), { recursive: true });
      const args = ['clone', '--depth', '1'];
      if (ref) args.push('--branch', ref);
      args.push(cloneUrl, cacheBase);
      runGit(args);
    }
    return cacheBase;
  } catch {
    return null;
  }
}

function runGit(args: string[], options?: { cwd?: string }): string {
  return execFileSync('git', args, {
    ...options,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 120_000,
  }).trim();
}

// ── Plugin manifest ────────────────────────────────────────────────

function readPluginManifest(pluginDir: string): PluginManifest | null {
  const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return pluginManifestSchema.parse(raw);
  } catch {
    return null;
  }
}
