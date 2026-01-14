import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigScope } from '../config/scope.js';
import { ensureParentDir } from './fs.js';
import {
  type LibrarySection,
  loadLibraryStateSection,
  updateLibraryStateSection,
} from './state.js';

export type BundleDistributionStatus = 'written' | 'skipped' | 'error' | 'deleted';

export interface BundleDistributionResult<Platform extends string> {
  platform: Platform;
  /** Target directory path */
  targetDir: string;
  status: BundleDistributionStatus;
  reason?: string;
  error?: string;
  /** Number of files written */
  filesWritten?: number;
  /** Number of files skipped (up-to-date) */
  filesSkipped?: number;
}

export interface BundleFile {
  sourcePath: string;
  relativePath: string;
}

export interface BundleCleanupConfig<Platform extends string> {
  /** Resolve parent directory containing all bundles for a platform */
  resolveParentDir: (platform: Platform) => string;
}

export interface DistributeBundleOptions<TEntry, Platform extends string> {
  section: LibrarySection;
  selected: TEntry[];
  platforms: Platform[];
  /** Resolve target directory for a platform and entry */
  resolveTargetDir: (platform: Platform, entry: TEntry) => string;
  /** List all files in an entry bundle */
  listFiles: (entry: TEntry) => BundleFile[];
  /** Get entry ID for logging */
  getId: (entry: TEntry) => string;
  /** Cleanup config for removing orphan directories */
  cleanup?: BundleCleanupConfig<Platform>;
  scope?: ConfigScope;
  /**
   * Filter selected entries for a specific platform.
   * Used for per-agent configuration where each platform may have different active items.
   */
  filterSelected?: (platform: Platform, selected: TEntry[]) => TEntry[];
}

export interface DistributeBundleOutcome<Platform extends string> {
  results: BundleDistributionResult<Platform>[];
}

/**
 * Recursively delete a directory and all its contents.
 */
function rmDirRecursive(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      rmDirRecursive(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  fs.rmdirSync(dirPath);
}

/**
 * Distribute skill bundles (directories) to target platforms.
 * Copies all files in each skill directory, preserving structure.
 */
export function distributeBundle<TEntry, Platform extends string>(
  opts: DistributeBundleOptions<TEntry, Platform>
): DistributeBundleOutcome<Platform> {
  const state = loadLibraryStateSection(opts.section, opts.scope);
  const results: BundleDistributionResult<Platform>[] = [];
  const timestamp = new Date().toISOString();

  for (const platform of opts.platforms) {
    const platformHash = createHash('sha256');

    // Apply per-platform filter if provided
    const platformSelected = opts.filterSelected
      ? opts.filterSelected(platform, opts.selected)
      : opts.selected;

    for (const entry of platformSelected) {
      const targetDir = opts.resolveTargetDir(platform, entry);
      const files = opts.listFiles(entry);

      let filesWritten = 0;
      let filesSkipped = 0;
      let hadError = false;
      let errorMessage = '';

      for (const file of files) {
        const targetPath = path.join(targetDir, file.relativePath);
        ensureParentDir(targetPath);

        try {
          const srcContent = fs.readFileSync(file.sourcePath);
          let same = false;

          if (fs.existsSync(targetPath)) {
            const dstContent = fs.readFileSync(targetPath);
            same = Buffer.compare(srcContent, dstContent) === 0;
          }

          if (!same) {
            fs.writeFileSync(targetPath, srcContent);
            filesWritten++;

            // Preserve executable permission for scripts
            try {
              const srcMode = fs.statSync(file.sourcePath).mode;
              if (srcMode & 0o111) {
                fs.chmodSync(targetPath, srcMode & 0o777);
              }
            } catch {
              // Ignore permission errors on some platforms
            }
          } else {
            filesSkipped++;
          }

          // Include file in hash
          platformHash.update(`\n# ${targetPath}\n`);
          platformHash.update(srcContent);
        } catch (error) {
          hadError = true;
          errorMessage = error instanceof Error ? error.message : String(error);
          break;
        }
      }

      const entryId = opts.getId(entry);
      if (hadError) {
        results.push({
          platform,
          targetDir,
          status: 'error',
          error: `Failed to copy ${entryId}: ${errorMessage}`,
        });
      } else if (filesWritten > 0) {
        results.push({
          platform,
          targetDir,
          status: 'written',
          reason: 'updated',
          filesWritten,
          filesSkipped,
        });
      } else {
        results.push({
          platform,
          targetDir,
          status: 'skipped',
          reason: 'up-to-date',
          filesWritten: 0,
          filesSkipped,
        });
      }
    }

    // Update sync state
    const aggregateHash = platformHash.digest('hex');
    const prev = state.agentSync[platform]?.hash;
    const hadErrors = results.some((r) => r.platform === platform && r.status === 'error');

    if (!hadErrors && prev !== aggregateHash) {
      updateLibraryStateSection(
        opts.section,
        (current) => ({
          ...current,
          agentSync: {
            ...current.agentSync,
            [platform]: { hash: aggregateHash, updatedAt: timestamp },
          },
        }),
        opts.scope
      );
    }

    // Cleanup orphan directories if cleanup config is provided
    if (opts.cleanup) {
      const activeIds = new Set(platformSelected.map(opts.getId));
      const parentDir = opts.cleanup.resolveParentDir(platform);

      if (fs.existsSync(parentDir)) {
        try {
          const entries = fs.readdirSync(parentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const id = entry.name;
            if (!activeIds.has(id)) {
              const dirPath = path.join(parentDir, id);
              try {
                rmDirRecursive(dirPath);
                results.push({
                  platform,
                  targetDir: dirPath,
                  status: 'deleted',
                  reason: 'orphan',
                });
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                results.push({
                  platform,
                  targetDir: dirPath,
                  status: 'error',
                  error: `Failed to delete orphan: ${msg}`,
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

  return { results };
}
