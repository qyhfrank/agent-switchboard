/**
 * Project distribution manifest I/O and helpers.
 *
 * The manifest lives at `<project>/.asb/state/distribution.json` and records
 * which artifacts ASB has written, enabling manifest-driven cleanup.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ManagedMcpEntry,
  ManifestEntry,
  ManifestSections,
  ProjectDistributionManifest,
  RulesManifestEntry,
} from './types.js';

const MANIFEST_DIR = '.asb/state';
const MANIFEST_FILENAME = 'distribution.json';

export function resolveManifestPath(projectRoot: string): string {
  return path.join(projectRoot, MANIFEST_DIR, MANIFEST_FILENAME);
}

function emptyManifest(): ProjectDistributionManifest {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sections: {},
  };
}

export interface ManifestLoadResult {
  manifest: ProjectDistributionManifest;
  /** True when the manifest file existed on disk (even if corrupt). */
  existedOnDisk: boolean;
  /** True when the file existed but could not be parsed or had an unsupported version. */
  corrupt: boolean;
}

export function loadManifest(projectRoot: string): ManifestLoadResult {
  const filePath = resolveManifestPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { manifest: emptyManifest(), existedOnDisk: false, corrupt: false };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as ProjectDistributionManifest;
    if (parsed.version !== 1) {
      console.warn(`[asb] Manifest version mismatch at ${filePath} (expected 1, got ${parsed.version})`);
      return { manifest: emptyManifest(), existedOnDisk: true, corrupt: true };
    }
    return { manifest: parsed, existedOnDisk: true, corrupt: false };
  } catch (error) {
    console.warn(`[asb] Failed to parse manifest at ${filePath}: ${error instanceof Error ? error.message : error}`);
    return { manifest: emptyManifest(), existedOnDisk: true, corrupt: true };
  }
}

export function saveManifest(projectRoot: string, manifest: ProjectDistributionManifest): void {
  const filePath = resolveManifestPath(projectRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  manifest.updatedAt = new Date().toISOString();
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ── Composite key helpers ──────────────────────────────────

const KEY_SEP = '::';

/** Build a manifest key that is unique per (id, targetId) pair. */
function manifestKey(id: string, targetId: string): string {
  return `${id}${KEY_SEP}${targetId}`;
}

/** Parse a composite manifest key back to id and targetId. */
function parseManifestKey(key: string): { id: string; targetId: string } {
  const sep = key.indexOf(KEY_SEP);
  if (sep === -1) return { id: key, targetId: '' };
  return { id: key.slice(0, sep), targetId: key.slice(sep + KEY_SEP.length) };
}

// ── Entry-level helpers ────────────────────────────────────

export type LibraryManifestSection = 'skills' | 'commands' | 'agents';

export interface ManifestCleanupItem {
  id: string;
  entry: ManifestEntry;
}

export function recordLibraryEntry(
  manifest: ProjectDistributionManifest,
  section: LibraryManifestSection,
  id: string,
  entry: ManifestEntry
): void {
  const sec = (manifest.sections[section] ?? {}) as Record<string, ManifestEntry>;
  sec[manifestKey(id, entry.targetId)] = entry;
  manifest.sections[section] = sec;
}

export function removeLibraryEntry(
  manifest: ProjectDistributionManifest,
  section: LibraryManifestSection,
  id: string,
  targetId?: string
): void {
  const sec = manifest.sections[section];
  if (!sec) return;
  if (targetId) {
    delete sec[manifestKey(id, targetId)];
  } else {
    for (const key of Object.keys(sec)) {
      if (parseManifestKey(key).id === id) delete sec[key];
    }
  }
}

export function recordMcpEntry(
  manifest: ProjectDistributionManifest,
  serverName: string,
  entry: ManagedMcpEntry
): void {
  const sec = (manifest.sections.mcp ?? {}) as Record<string, ManagedMcpEntry>;
  sec[manifestKey(serverName, entry.targetId)] = entry;
  manifest.sections.mcp = sec;
}

/**
 * Remove an MCP manifest entry by its composite key (as returned by
 * `computeMcpCleanupSet`).
 */
export function removeMcpEntry(manifest: ProjectDistributionManifest, compositeKey: string): void {
  const sec = manifest.sections.mcp;
  if (sec) delete sec[compositeKey];
}

export function recordRulesEntry(
  manifest: ProjectDistributionManifest,
  filePathKey: string,
  entry: RulesManifestEntry
): void {
  const sec = (manifest.sections.rules ?? {}) as Record<string, RulesManifestEntry>;
  sec[filePathKey] = entry;
  manifest.sections.rules = sec;
}

export function removeRulesEntry(manifest: ProjectDistributionManifest, filePathKey: string): void {
  const sec = manifest.sections.rules;
  if (sec) delete sec[filePathKey];
}

// ── Cleanup computation ────────────────────────────────────

/**
 * Compute entries that were previously owned by ASB but are no longer in the
 * current desired set. These are safe to clean up.
 *
 * Returns `ManifestCleanupItem[]` with the bare entry id and the full entry,
 * so callers can resolve file paths and remove the manifest record.
 */
export function computeLibraryCleanupSet(
  manifest: ProjectDistributionManifest,
  section: LibraryManifestSection,
  currentDesiredIds: ReadonlySet<string>,
  targetId?: string
): ManifestCleanupItem[] {
  const sec = manifest.sections[section] as Record<string, ManifestEntry> | undefined;
  if (!sec) return [];
  const toRemove: ManifestCleanupItem[] = [];
  for (const [key, entry] of Object.entries(sec)) {
    if (targetId && entry.targetId !== targetId) continue;
    const { id } = parseManifestKey(key);
    if (!currentDesiredIds.has(id)) {
      toRemove.push({ id, entry });
    }
  }
  return toRemove;
}

/**
 * Compute MCP composite keys that were previously owned but are no longer enabled.
 * Returns composite keys (serverName::targetId) for use with `removeMcpEntry`.
 */
export function computeMcpCleanupSet(
  manifest: ProjectDistributionManifest,
  currentDesiredNames: ReadonlySet<string>,
  targetId?: string
): string[] {
  const sec = manifest.sections.mcp;
  if (!sec) return [];
  const toRemove: string[] = [];
  for (const [key, entry] of Object.entries(sec)) {
    if (targetId && entry.targetId !== targetId) continue;
    const { id: serverName } = parseManifestKey(key);
    if (!currentDesiredNames.has(serverName)) {
      toRemove.push(key);
    }
  }
  return toRemove;
}

/**
 * Get the set of previously-owned MCP server names for a given target.
 * Returns bare server names (not composite keys).
 */
export function getOwnedMcpServers(
  manifest: ProjectDistributionManifest,
  targetId: string
): Set<string> {
  const sec = manifest.sections.mcp;
  if (!sec) return new Set();
  const owned = new Set<string>();
  for (const [key, entry] of Object.entries(sec)) {
    if (entry.targetId === targetId) {
      owned.add(parseManifestKey(key).id);
    }
  }
  return owned;
}

/**
 * Get manifest entry for a library section item, if it exists.
 * When targetId is provided, looks up the composite key directly.
 * Without targetId, scans for the first entry matching the bare id.
 */
export function getLibraryEntry(
  manifest: ProjectDistributionManifest,
  section: LibraryManifestSection,
  id: string,
  targetId?: string
): ManifestEntry | undefined {
  const sec = manifest.sections[section] as Record<string, ManifestEntry> | undefined;
  if (!sec) return undefined;
  if (targetId) {
    return sec[manifestKey(id, targetId)];
  }
  for (const [key, entry] of Object.entries(sec)) {
    if (parseManifestKey(key).id === id) return entry;
  }
  return undefined;
}

/**
 * Resolve the effective sections record, ensuring it exists.
 */
export function ensureSections(manifest: ProjectDistributionManifest): ManifestSections {
  return manifest.sections;
}
