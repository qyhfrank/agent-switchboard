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

export type BundleDistributionStatus = 'written' | 'skipped' | 'error';

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
  scope?: ConfigScope;
}

export interface DistributeBundleOutcome<Platform extends string> {
  results: BundleDistributionResult<Platform>[];
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

    for (const entry of opts.selected) {
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
  }

  return { results };
}
