import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigScope } from '../config/scope.js';
import {
  computeLibraryCleanupSet,
  getLibraryEntry,
  hasOtherLibraryEntryAtPath,
  type LibraryManifestSection,
  recordLibraryEntry,
  removeLibraryEntry,
} from '../manifest/store.js';
import type { ProjectDistributionManifest } from '../manifest/types.js';
import { assertPathWithinRoot, ensureParentDir } from './fs.js';
import { type LibrarySection, loadLibraryAgentSync, updateLibraryAgentSync } from './state.js';

export type DistributionStatus = 'written' | 'skipped' | 'error' | 'deleted' | 'conflict';

export interface DistributionResult<Platform extends string> {
  platform: Platform;
  filePath: string;
  status: DistributionStatus;
  reason?: string;
  error?: string;
  entryId?: string;
}

export interface CleanupConfig<Platform extends string> {
  /** Resolve target directory to scan for orphan files */
  resolveTargetDir: (platform: Platform) => string;
  /** Extract entry ID from filename (without extension). Platform is provided for context. */
  extractId: (filename: string, platform?: Platform) => string | null;
}

export type ProjectMode = 'managed' | 'exclusive' | 'none';
export type CollisionPolicy = 'warn-skip' | 'error' | 'takeover';

/** Options for managed project-level distribution (commands, agents, skills) */
export interface LibraryManagedOptions {
  manifest?: ProjectDistributionManifest;
  projectMode?: ProjectMode;
  collision?: CollisionPolicy;
  /** When true, compute results without writing files or updating state */
  dryRun?: boolean;
}

export interface DistributeOptions<TEntry, Platform extends string> {
  section: LibrarySection;
  selected: TEntry[];
  platforms: Platform[];
  resolveFilePath: (platform: Platform, entry: TEntry) => string;
  render: (platform: Platform, entry: TEntry) => string;
  /** Get entry ID for cleanup matching */
  getId?: (entry: TEntry) => string;
  /** Cleanup config for removing orphan files */
  cleanup?: CleanupConfig<Platform>;
  scope?: ConfigScope;
  /**
   * Filter selected entries for a specific platform.
   * Used for per-agent configuration where each platform may have different active items.
   */
  filterSelected?: (platform: Platform, selected: TEntry[]) => TEntry[];
  /** Project distribution manifest for managed cleanup (project scope only) */
  manifest?: ProjectDistributionManifest;
  /** Project distribution mode (only used when scope.project is set) */
  projectMode?: ProjectMode;
  /** Collision policy for managed mode */
  collision?: CollisionPolicy;
  /** When true, compute results without writing files or updating state */
  dryRun?: boolean;
}

export interface DistributeOutcome<Platform extends string> {
  results: DistributionResult<Platform>[];
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Generic library distributor: writes rendered content per-platform, skipping unchanged files,
 * backing up overwritten files, and updating agentSync hash in section state upon success.
 */
export function distributeLibrary<TEntry, Platform extends string>(
  opts: DistributeOptions<TEntry, Platform>
): DistributeOutcome<Platform> {
  if (opts.scope?.project && opts.projectMode === 'none') {
    return { results: [] };
  }

  const dryRun = opts.dryRun === true;
  const agentSync = loadLibraryAgentSync(opts.section);
  const results: DistributionResult<Platform>[] = [];
  const timestamp = new Date().toISOString();
  const collision = opts.collision ?? 'warn-skip';
  // Safe cast: managed mode guard ensures section is never 'hooks' (hooks don't use manifest)
  const manifestSection = opts.section as LibraryManifestSection;
  // Extract managed context with proper narrowing (avoids non-null assertions throughout)
  const managedProjectRoot = opts.scope?.project;
  const requiresManagedManifest =
    managedProjectRoot && (opts.projectMode ?? 'exclusive') === 'managed';
  if (requiresManagedManifest && !opts.manifest) {
    throw new Error('Managed project distribution requires a valid manifest');
  }
  const manifest = requiresManagedManifest ? opts.manifest : undefined;
  for (const platform of opts.platforms) {
    const hash = createHash('sha256');
    const writtenOrSkipped: DistributionResult<Platform>[] = [];

    // Apply per-platform filter if provided
    const platformSelected = opts.filterSelected
      ? opts.filterSelected(platform, opts.selected)
      : opts.selected;

    for (const entry of platformSelected) {
      const filePath = opts.resolveFilePath(platform, entry);
      const content = opts.render(platform, entry);
      const entryId = opts.getId?.(entry);

      if (manifest && managedProjectRoot) {
        try {
          assertPathWithinRoot(managedProjectRoot, filePath);
        } catch (error) {
          results.push({
            platform,
            filePath,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            entryId,
          });
          continue;
        }
      }
      if (!dryRun) ensureParentDir(filePath);

      let existing: string | null = null;
      const existingStat = lstatIfExists(filePath);
      try {
        if (existingStat?.isFile() && !existingStat.isSymbolicLink()) {
          existing = fs.readFileSync(filePath, 'utf-8');
        }
      } catch {
        existing = null;
      }

      const same = existing !== null && existing === content;
      const manifestEntry =
        manifest && entryId
          ? getLibraryEntry(manifest, manifestSection, entryId, platform as string)
          : undefined;
      if (manifest && existingStat && entryId && collision !== 'takeover') {
        const modifiedManagedFile =
          manifestEntry && existing !== null && contentHash(existing) !== manifestEntry.hash;
        if (
          (!manifestEntry && !same) ||
          (manifestEntry && (existing === null || (modifiedManagedFile && !same)))
        ) {
          const isHardError = collision === 'error';
          writtenOrSkipped.push({
            platform,
            filePath,
            status: isHardError ? 'error' : 'conflict',
            ...(isHardError
              ? { error: manifestEntry ? 'managed file was modified' : 'foreign file exists' }
              : { reason: manifestEntry ? 'managed file was modified' : 'foreign file exists' }),
            entryId,
          });
          // Intentionally not included in aggregate hash: content was not
          // written, so it should not affect sync-state comparison.
          continue;
        }
        // 'takeover' or manifestEntry exists: fall through to overwrite
      }

      if (same) {
        writtenOrSkipped.push({ platform, filePath, status: 'skipped', reason: 'up-to-date' });
      } else if (dryRun) {
        writtenOrSkipped.push({
          platform,
          filePath,
          status: 'written',
          reason: existing ? 'updated' : 'created',
        });
      } else {
        try {
          fs.writeFileSync(filePath, content, 'utf-8');
          writtenOrSkipped.push({
            platform,
            filePath,
            status: 'written',
            reason: existing ? 'updated' : 'created',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          writtenOrSkipped.push({ platform, filePath, status: 'error', error: msg });
        }
      }

      // Record in manifest after successful write or skip (up-to-date)
      if (!dryRun && manifest && managedProjectRoot && entryId) {
        const lastResult = writtenOrSkipped[writtenOrSkipped.length - 1];
        if (lastResult.status === 'written' || lastResult.status === 'skipped') {
          recordLibraryEntry(manifest, manifestSection, entryId, {
            relativePath: path.relative(path.resolve(managedProjectRoot), filePath),
            targetId: platform as string,
            hash: contentHash(content),
            updatedAt: timestamp,
          });
        }
      }

      hash.update(`\n# ${filePath}\n`);
      hash.update(content);
    }

    const aggregateHash = hash.digest('hex');
    const prev = agentSync[platform]?.hash;
    const hadErrors = writtenOrSkipped.some((r) => r.status === 'error');
    if (!dryRun && !hadErrors && prev !== aggregateHash) {
      updateLibraryAgentSync(opts.section, (current) => ({
        ...current,
        [platform]: { hash: aggregateHash, updatedAt: timestamp },
      }));
    }

    results.push(...writtenOrSkipped);

    // Cleanup orphan files
    if (opts.cleanup && opts.getId) {
      const activeIds = new Set(platformSelected.map(opts.getId));

      if (manifest && managedProjectRoot) {
        // Manifest-driven cleanup: only delete entries previously owned by ASB
        const toRemove = computeLibraryCleanupSet(
          manifest,
          manifestSection,
          activeIds,
          platform as string
        );
        for (const item of toRemove) {
          const entryPath = path.join(path.resolve(managedProjectRoot), item.entry.relativePath);
          try {
            assertPathWithinRoot(managedProjectRoot, entryPath);
            const sharedPathStillOwned = hasOtherLibraryEntryAtPath(
              manifest,
              manifestSection,
              item.entry.relativePath,
              item.id,
              platform as string
            );
            if (sharedPathStillOwned) {
              results.push({
                platform,
                filePath: entryPath,
                status: 'skipped',
                reason: 'shared path still owned by another target',
                entryId: item.id,
              });
            } else if (lstatIfExists(entryPath)) {
              const stat = fs.lstatSync(entryPath);
              const matches =
                stat.isFile() &&
                !stat.isSymbolicLink() &&
                contentHash(fs.readFileSync(entryPath, 'utf-8')) === item.entry.hash;
              if (!matches) {
                results.push({
                  platform,
                  filePath: entryPath,
                  status: 'conflict',
                  reason: 'managed file was modified',
                  entryId: item.id,
                });
                continue;
              }
              if (!dryRun) {
                assertPathWithinRoot(managedProjectRoot, entryPath);
                fs.unlinkSync(entryPath);
              }
              results.push({
                platform,
                filePath: entryPath,
                status: 'deleted',
                reason: 'orphan',
                entryId: item.id,
              });
            } else {
              results.push({
                platform,
                filePath: entryPath,
                status: 'deleted',
                reason: 'orphan',
                entryId: item.id,
              });
            }
            if (!dryRun) removeLibraryEntry(manifest, manifestSection, item.id, platform as string);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            results.push({
              platform,
              filePath: entryPath,
              status: 'error',
              error: `Failed to delete orphan: ${msg}`,
              entryId: item.id,
            });
          }
        }
      } else {
        // Exclusive mode: scan directory for orphans (existing behavior)
        const targetDir = opts.cleanup.resolveTargetDir(platform);

        if (fs.existsSync(targetDir)) {
          try {
            const files = fs.readdirSync(targetDir);
            for (const file of files) {
              const filePath = path.join(targetDir, file);
              // Skip directories
              if (fs.statSync(filePath).isDirectory()) continue;

              const id = opts.cleanup.extractId(file, platform);
              if (id !== null && !activeIds.has(id)) {
                try {
                  if (!dryRun) fs.unlinkSync(filePath);
                  results.push({
                    platform,
                    filePath,
                    status: 'deleted',
                    reason: 'orphan',
                    entryId: id,
                  });
                } catch (error) {
                  const msg = error instanceof Error ? error.message : String(error);
                  results.push({
                    platform,
                    filePath,
                    status: 'error',
                    error: `Failed to delete orphan: ${msg}`,
                    entryId: id,
                  });
                }
              }
            }
          } catch {
            // Ignore errors reading directory
          }
        }
      }
    }
  }

  return { results };
}
