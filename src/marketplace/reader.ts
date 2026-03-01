/**
 * Marketplace reader: detects and parses Claude Code marketplace repositories.
 *
 * A marketplace is a repository containing `.claude-plugin/marketplace.json`.
 * Each plugin is either a relative path within the same repo or a standalone
 * directory with `.claude-plugin/plugin.json`.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  type MarketplaceManifest,
  marketplaceManifestSchema,
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
 * Read and resolve a marketplace, returning all resolvable plugins with metadata.
 */
export function readMarketplace(localPath: string): MarketplaceReadResult {
  const manifestPath = path.join(localPath, MARKETPLACE_MANIFEST);
  const warnings: string[] = [];

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const manifest: MarketplaceManifest = marketplaceManifestSchema.parse(raw);

  const pluginRoot = manifest.metadata?.pluginRoot ?? '';
  const plugins: ResolvedPlugin[] = [];

  for (const entry of manifest.plugins) {
    const resolved = resolvePluginDir(localPath, pluginRoot, entry.name, entry.source);
    if (!resolved) {
      warnings.push(`Plugin "${entry.name}": unsupported source type, skipped`);
      continue;
    }

    if (!fs.existsSync(resolved)) {
      warnings.push(`Plugin "${entry.name}": directory not found at ${resolved}`);
      continue;
    }

    const pluginManifest = readPluginManifest(resolved);

    plugins.push({
      name: entry.name,
      description: entry.description ?? pluginManifest?.description,
      version: entry.version ?? pluginManifest?.version,
      localPath: resolved,
      manifest: pluginManifest ?? undefined,
      strict: entry.strict,
    });
  }

  return {
    name: manifest.name,
    owner: manifest.owner,
    plugins,
    warnings,
  };
}

/**
 * Resolve a plugin source to a local absolute path.
 * Only supports relative paths and local `path` sources for MVP.
 * GitHub/git/npm/pip sources return null with a warning.
 */
function resolvePluginDir(
  marketplaceRoot: string,
  pluginRoot: string,
  _pluginName: string,
  source: string | Record<string, unknown>
): string | null {
  if (typeof source === 'string') {
    if (source.startsWith('./') || source.startsWith('../') || !source.includes(':')) {
      return path.resolve(marketplaceRoot, pluginRoot, source);
    }
    return null;
  }

  if (source.path && typeof source.path === 'string') {
    return path.resolve(marketplaceRoot, pluginRoot, source.path);
  }

  // npm, pip, github, git sources are not supported in MVP
  return null;
}

/**
 * Read optional `.claude-plugin/plugin.json` from a plugin directory.
 */
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
