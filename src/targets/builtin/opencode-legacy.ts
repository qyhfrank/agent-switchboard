import fs from 'node:fs';
import path from 'node:path';
import type { DistributionResult } from '../../library/distribute.js';
import type { BundleDistributionResult } from '../../library/distribute-bundle.js';
import { rmDirRecursive } from '../../library/fs.js';

export function cleanupLegacyOpencodeFiles(options: {
  platform: string;
  legacyDir: string;
  currentDir: string;
  activeIds: ReadonlySet<string>;
  extractId: (filename: string) => string | null;
  dryRun?: boolean;
}): DistributionResult<string>[] {
  const results: DistributionResult<string>[] = [];
  if (!fs.existsSync(options.legacyDir)) return results;

  try {
    for (const entry of fs.readdirSync(options.legacyDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;

      const id = options.extractId(entry.name);
      if (id === null) continue;

      const legacyPath = path.join(options.legacyDir, entry.name);
      const currentPath = path.join(options.currentDir, entry.name);
      const isDuplicate = options.legacyDir !== options.currentDir && fs.existsSync(currentPath);
      const shouldDelete = !options.activeIds.has(id) || isDuplicate;
      if (!shouldDelete) continue;

      try {
        if (!options.dryRun) fs.unlinkSync(legacyPath);
        results.push({
          platform: options.platform,
          filePath: legacyPath,
          status: 'deleted',
          reason: isDuplicate ? 'legacy duplicate' : 'legacy orphan',
          entryId: id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({
          platform: options.platform,
          filePath: legacyPath,
          status: 'error',
          error: `Failed to delete legacy file: ${msg}`,
          entryId: id,
        });
      }
    }

    if (fs.readdirSync(options.legacyDir).length === 0) {
      if (!options.dryRun) fs.rmdirSync(options.legacyDir);
    }
  } catch {
    // Ignore legacy cleanup scan errors to avoid blocking distribution.
  }

  return results;
}

export function cleanupLegacyOpencodeBundles(options: {
  platform: string;
  legacyParentDir: string;
  currentParentDir: string;
  activeIds: ReadonlySet<string>;
  dryRun?: boolean;
  isReservedDir?: (id: string) => boolean;
}): BundleDistributionResult<string>[] {
  const results: BundleDistributionResult<string>[] = [];
  if (!fs.existsSync(options.legacyParentDir)) return results;

  try {
    for (const entry of fs.readdirSync(options.legacyParentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (options.isReservedDir?.(id)) continue;

      const legacyDir = path.join(options.legacyParentDir, id);
      const currentDir = path.join(options.currentParentDir, id);
      const isDuplicate =
        options.legacyParentDir !== options.currentParentDir && fs.existsSync(currentDir);
      const shouldDelete = !options.activeIds.has(id) || isDuplicate;
      if (!shouldDelete) continue;

      try {
        if (!options.dryRun) rmDirRecursive(legacyDir);
        results.push({
          platform: options.platform,
          targetDir: legacyDir,
          status: 'deleted',
          reason: isDuplicate ? 'legacy duplicate' : 'legacy orphan',
          entryId: id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({
          platform: options.platform,
          targetDir: legacyDir,
          status: 'error',
          error: `Failed to delete legacy directory: ${msg}`,
          entryId: id,
        });
      }
    }

    if (
      fs.existsSync(options.legacyParentDir) &&
      fs.readdirSync(options.legacyParentDir).length === 0
    ) {
      if (!options.dryRun) fs.rmdirSync(options.legacyParentDir);
    }
  } catch {
    // Ignore legacy cleanup scan errors to avoid blocking distribution.
  }

  return results;
}
