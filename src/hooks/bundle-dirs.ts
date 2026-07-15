/**
 * Bundle directory lifecycle shared by the hook distributors.
 *
 * Managed bundles live at `<appDir>/hooks/managed/<entry-id>/`. Cleanup only
 * deletes directories ASB can prove it owns: names recorded in the ownership
 * state, names in the active set, or the v0.4.28 hash layout
 * (`<64-hex>/` containing only `<64-hex>/` children). Anything else under the
 * neutral root is reported and left alone. The legacy ASB-branded
 * `hooks/asb/` root deletes only known hook ids and is removed once empty.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BundleDistributionResult } from '../library/distribute-bundle.js';
import {
  assertNoSymlinkAncestor,
  assertUsableBundleRoot,
  resolvedHomeDir,
} from '../library/distribute-bundle.js';

const HEX64_RE = /^[0-9a-f]{64}$/;

export function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function removeHookBundlePath(targetPath: string): void {
  const stat = lstatIfExists(targetPath);
  if (!stat) return;

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      removeHookBundlePath(path.join(targetPath, entry.name));
    }
    fs.rmdirSync(targetPath);
    return;
  }

  fs.unlinkSync(targetPath);
}

export interface BundleCleanupOptions<Platform extends string> {
  platform: Platform;
  parentDir: string;
  safetyRoot: string;
  projectScoped: boolean;
  dryRun: boolean;
}

export function bundleParentError<Platform extends string>(
  opts: BundleCleanupOptions<Platform>
): BundleDistributionResult<Platform> | undefined {
  try {
    assertUsableBundleRoot(opts.safetyRoot);
    assertNoSymlinkAncestor(opts.safetyRoot, opts.parentDir, {
      trustedRoots: opts.projectScoped ? undefined : [resolvedHomeDir()],
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      platform: opts.platform,
      targetDir: opts.parentDir,
      status: 'error',
      error: `Failed to scan bundle parent: ${msg}`,
    };
  }

  const stat = lstatIfExists(opts.parentDir);
  if (!stat) return undefined;
  if (!stat.isDirectory()) {
    return {
      platform: opts.platform,
      targetDir: opts.parentDir,
      status: 'error',
      error: `Failed to scan bundle parent: bundle root exists and is not a directory: ${opts.parentDir}`,
    };
  }
  return undefined;
}

/** True when a directory matches the v0.4.28 namespace shape. */
function isV0428NamespaceDir(dirPath: string): boolean {
  if (!HEX64_RE.test(path.basename(dirPath))) return false;
  const stat = lstatIfExists(dirPath);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  try {
    const children = fs.readdirSync(dirPath, { withFileTypes: true });
    return children.every((child) => child.isDirectory() && HEX64_RE.test(child.name));
  } catch {
    return false;
  }
}

function deletionResult<Platform extends string>(
  opts: BundleCleanupOptions<Platform>,
  dirPath: string,
  entryId: string,
  reason: string
): BundleDistributionResult<Platform> {
  try {
    if (!opts.dryRun) removeHookBundlePath(dirPath);
    return { platform: opts.platform, targetDir: dirPath, status: 'deleted', reason, entryId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      platform: opts.platform,
      targetDir: dirPath,
      status: 'error',
      error: `Failed to delete orphan: ${msg}`,
      entryId,
    };
  }
}

/**
 * Delete provably-owned orphans under `hooks/managed/`; report unknown
 * children without touching them.
 */
export function cleanManagedBundleDirs<Platform extends string>(
  opts: BundleCleanupOptions<Platform>,
  activeIds: ReadonlySet<string>,
  stateBundles: ReadonlySet<string>
): Array<BundleDistributionResult<Platform>> {
  const results: Array<BundleDistributionResult<Platform>> = [];
  const parentError = bundleParentError(opts);
  if (parentError) return [parentError];
  if (!lstatIfExists(opts.parentDir)) return results;

  try {
    for (const entry of fs.readdirSync(opts.parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (activeIds.has(entry.name)) continue;

      const dirPath = path.join(opts.parentDir, entry.name);
      if (stateBundles.has(entry.name)) {
        results.push(deletionResult(opts, dirPath, entry.name, 'orphan'));
      } else if (isV0428NamespaceDir(dirPath)) {
        results.push(deletionResult(opts, dirPath, entry.name, 'v0.4.28 layout'));
      } else {
        results.push({
          platform: opts.platform,
          targetDir: dirPath,
          status: 'skipped',
          reason: 'unmanaged directory',
          entryId: entry.name,
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      platform: opts.platform,
      targetDir: opts.parentDir,
      status: 'error',
      error: `Failed to scan bundle parent: ${msg}`,
    });
  }

  return results;
}

/**
 * Delete known hook ids under the legacy `hooks/asb/` root and remove the
 * root once empty; warn about anything unrecognized.
 */
export function cleanLegacyAsbDir<Platform extends string>(
  opts: BundleCleanupOptions<Platform>,
  knownIds: ReadonlySet<string>
): Array<BundleDistributionResult<Platform>> {
  const results: Array<BundleDistributionResult<Platform>> = [];
  if (!lstatIfExists(opts.parentDir)) return results;
  const parentError = bundleParentError(opts);
  if (parentError) return [parentError];

  try {
    for (const entry of fs.readdirSync(opts.parentDir, { withFileTypes: true })) {
      const dirPath = path.join(opts.parentDir, entry.name);
      if (knownIds.has(entry.name)) {
        results.push(deletionResult(opts, dirPath, entry.name, 'legacy layout'));
      } else {
        results.push({
          platform: opts.platform,
          targetDir: dirPath,
          status: 'skipped',
          reason: 'unrecognized entry in legacy hooks directory',
          entryId: entry.name,
        });
      }
    }
    if (!opts.dryRun && fs.readdirSync(opts.parentDir).length === 0) {
      fs.rmdirSync(opts.parentDir);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      platform: opts.platform,
      targetDir: opts.parentDir,
      status: 'error',
      error: `Failed to clean legacy hooks directory: ${msg}`,
    });
  }

  return results;
}

/**
 * Delete v0.4.28 hash directories referenced by removed config groups. Paths
 * arrive from the config evidence (already `$HOME`-expanded); only the exact
 * `<...>/hooks/managed/<64-hex>` shape is deleted, plus the emptied
 * `managed/` parent.
 */
export function removeV0428BundleDirs<Platform extends string>(
  platform: Platform,
  dirs: ReadonlySet<string>,
  dryRun: boolean
): Array<BundleDistributionResult<Platform>> {
  const results: Array<BundleDistributionResult<Platform>> = [];
  for (const dir of dirs) {
    const parent = path.dirname(dir);
    if (
      !HEX64_RE.test(path.basename(dir)) ||
      path.basename(parent) !== 'managed' ||
      path.basename(path.dirname(parent)) !== 'hooks'
    ) {
      continue;
    }
    const stat = lstatIfExists(dir);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    try {
      if (!dryRun) {
        removeHookBundlePath(dir);
        if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      }
      results.push({
        platform,
        targetDir: dir,
        status: 'deleted',
        reason: 'v0.4.28 layout',
        entryId: path.basename(dir),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        platform,
        targetDir: dir,
        status: 'error',
        error: `Failed to delete v0.4.28 bundle: ${msg}`,
      });
    }
  }
  return results;
}
