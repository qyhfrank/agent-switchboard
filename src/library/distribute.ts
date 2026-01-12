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

export type DistributionStatus = 'written' | 'skipped' | 'error' | 'deleted';

export interface DistributionResult<Platform extends string> {
  platform: Platform;
  filePath: string;
  status: DistributionStatus;
  reason?: string;
  error?: string;
}

export interface CleanupConfig<Platform extends string> {
  /** Resolve target directory to scan for orphan files */
  resolveTargetDir: (platform: Platform) => string;
  /** Extract entry ID from filename (without extension) */
  extractId: (filename: string) => string | null;
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
}

export interface DistributeOutcome<Platform extends string> {
  results: DistributionResult<Platform>[];
}

/**
 * Generic library distributor: writes rendered content per-platform, skipping unchanged files,
 * backing up overwritten files, and updating agentSync hash in section state upon success.
 */
export function distributeLibrary<TEntry, Platform extends string>(
  opts: DistributeOptions<TEntry, Platform>
): DistributeOutcome<Platform> {
  const state = loadLibraryStateSection(opts.section, opts.scope);
  const results: DistributionResult<Platform>[] = [];
  const timestamp = new Date().toISOString();

  for (const platform of opts.platforms) {
    const hash = createHash('sha256');
    const writtenOrSkipped: DistributionResult<Platform>[] = [];

    for (const entry of opts.selected) {
      const filePath = opts.resolveFilePath(platform, entry);
      const content = opts.render(platform, entry);

      ensureParentDir(filePath);

      let existing: string | null = null;
      try {
        if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
      } catch {
        existing = null;
      }

      const same = existing !== null && existing === content;
      if (same) {
        writtenOrSkipped.push({ platform, filePath, status: 'skipped', reason: 'up-to-date' });
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

      hash.update(`\n# ${filePath}\n`);
      hash.update(content);
    }

    const aggregateHash = hash.digest('hex');
    const prev = state.agentSync[platform]?.hash;
    const hadErrors = writtenOrSkipped.some((r) => r.status === 'error');
    if (!hadErrors && prev !== aggregateHash) {
      updateLibraryStateSection(
        opts.section,
        (current) => {
          const agentSync = {
            ...current.agentSync,
            [platform]: { hash: aggregateHash, updatedAt: timestamp },
          };
          return { ...current, agentSync };
        },
        opts.scope
      );
    }

    results.push(...writtenOrSkipped);

    // Cleanup orphan files if cleanup config is provided
    if (opts.cleanup && opts.getId) {
      const activeIds = new Set(opts.selected.map(opts.getId));
      const targetDir = opts.cleanup.resolveTargetDir(platform);

      if (fs.existsSync(targetDir)) {
        try {
          const files = fs.readdirSync(targetDir);
          for (const file of files) {
            const filePath = path.join(targetDir, file);
            // Skip directories
            if (fs.statSync(filePath).isDirectory()) continue;

            const id = opts.cleanup.extractId(file);
            if (id !== null && !activeIds.has(id)) {
              try {
                fs.unlinkSync(filePath);
                results.push({
                  platform,
                  filePath,
                  status: 'deleted',
                  reason: 'orphan',
                });
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                results.push({
                  platform,
                  filePath,
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
