import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
import type { CollisionPolicy, ProjectMode } from './distribute.js';
import { assertPathWithinRoot } from './fs.js';
import { type LibrarySection, loadLibraryAgentSync, updateLibraryAgentSync } from './state.js';

export type BundleDistributionStatus = 'written' | 'skipped' | 'error' | 'deleted' | 'conflict';

export interface BundleDistributionResult<Platform extends string> {
  platform: Platform;
  /** Target directory path */
  targetDir: string;
  status: BundleDistributionStatus;
  reason?: string;
  error?: string;
  entryId?: string;
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
  /** Return true to skip orphan cleanup for a directory (e.g. host-app reserved dirs) */
  isReservedDir?: (id: string, platform: Platform) => boolean;
}

/** @deprecated Use ProjectMode from distribute.ts */
export type BundleProjectMode = ProjectMode;
/** @deprecated Use CollisionPolicy from distribute.ts */
export type BundleCollisionPolicy = CollisionPolicy;

export interface DistributeBundleOptions<TEntry, Platform extends string> {
  section: LibrarySection;
  selected: TEntry[];
  platforms: Platform[];
  /** Resolve target directory for a platform and entry */
  resolveTargetDir: (platform: Platform, entry: TEntry) => string;
  /** Resolve the parent directory that owns bundle entry directories */
  resolveBundleRootDir?: (platform: Platform) => string;
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
  /** Project distribution manifest for managed cleanup (project scope only) */
  manifest?: ProjectDistributionManifest;
  /** Project distribution mode (only used when scope.project is set) */
  projectMode?: BundleProjectMode;
  /** Collision policy for managed mode */
  collision?: BundleCollisionPolicy;
  /** When true, compute results without writing files or updating state */
  dryRun?: boolean;
}

export interface DistributeBundleOutcome<Platform extends string> {
  results: BundleDistributionResult<Platform>[];
}

function listRelativeFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(abs, rel));
      continue;
    }
    files.push(rel);
  }

  return files;
}

function bundleFingerprint(dir: string): string | undefined {
  const root = lstatIfExists(dir);
  if (!root?.isDirectory() || root.isSymbolicLink()) return undefined;
  const hash = createHash('sha256');
  const visit = (current: string, prefix = ''): boolean => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filePath = path.join(current, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        hash.update(`d\0${relativePath}\0${stat.mode & 0o777}\0`);
        if (!visit(filePath, relativePath)) return false;
      } else if (stat.isFile()) {
        hash.update(`f\0${relativePath}\0${stat.mode & 0o777}\0`);
        hash.update(fs.readFileSync(filePath));
      } else {
        return false;
      }
    }
    return true;
  };
  if (!visit(dir)) return undefined;
  return `tree:${hash.digest('hex')}`;
}

function hasEmptyDirectory(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (fs.readdirSync(child).length === 0 || hasEmptyDirectory(child)) return true;
  }
  return false;
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function resolvedHomeDir(): string {
  return fs.realpathSync(os.homedir());
}

function statIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function assertTargetWithinRoot(rootPath: string, targetPath: string): void {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`target path escapes root: ${targetPath}`);
  }
}

export function assertUsableBundleRoot(rootPath: string): void {
  const stat = statIfExists(rootPath);
  if (!stat) return;
  if (!stat.isDirectory()) {
    throw new Error(`bundle root exists and is not a directory: ${rootPath}`);
  }
}

function assertSafeBundleTarget(rootPath: string, targetPath: string): void {
  assertUsableBundleRoot(rootPath);
  assertTargetWithinRoot(rootPath, targetPath);
}

function resolveBundleRootDir<TEntry, Platform extends string>(
  opts: DistributeBundleOptions<TEntry, Platform>,
  platform: Platform
): string | undefined {
  const explicitRoot = opts.resolveBundleRootDir?.(platform);
  if (explicitRoot) return explicitRoot;
  const cleanupParent = opts.cleanup?.resolveParentDir(platform);
  return cleanupParent ? path.dirname(cleanupParent) : undefined;
}

function isAdoptableBundleDir(targetDir: string, files: BundleFile[]): boolean {
  const targetStat = lstatIfExists(targetDir);
  if (!targetStat?.isDirectory()) {
    return false;
  }

  const expected = new Map(files.map((file) => [file.relativePath, file.sourcePath]));
  const actualFiles = listRelativeFiles(targetDir);
  if (actualFiles.length !== files.length) return false;

  for (const rel of actualFiles) {
    const sourcePath = expected.get(rel);
    if (!sourcePath) return false;

    const targetPath = path.join(targetDir, rel);
    if (lstatIfExists(targetPath)?.isSymbolicLink()) return false;

    const sourceContent = fs.readFileSync(sourcePath);
    const targetContent = fs.readFileSync(targetPath);
    if (Buffer.compare(sourceContent, targetContent) !== 0) return false;
  }

  return true;
}

function executableBits(mode: number): number {
  return mode & 0o111;
}

function targetModeMatchesSourceExecutableBits(srcMode: number, dstMode: number): boolean {
  if (executableBits(srcMode) !== 0) {
    return dstMode === srcMode;
  }
  return executableBits(dstMode) === 0;
}

function desiredTargetMode(srcMode: number, currentMode: number): number {
  if (executableBits(srcMode) !== 0) {
    return srcMode;
  }
  return currentMode & 0o666;
}

function ensureDirectoryWithoutFollowingSymlink(
  dirPath: string,
  options?: { recursive?: boolean }
): void {
  const stat = lstatIfExists(dirPath);
  if (!stat) {
    fs.mkdirSync(dirPath, { recursive: options?.recursive === true });
    return;
  }

  if (stat.isDirectory() && !stat.isSymbolicLink()) return;

  if (!stat.isSymbolicLink()) {
    throw new Error(`path exists and is not a directory: ${dirPath}`);
  }

  fs.unlinkSync(dirPath);
  fs.mkdirSync(dirPath);
}

function ensureBundleParentDir(targetDir: string, relativePath: string): void {
  ensureDirectoryWithoutFollowingSymlink(targetDir, { recursive: true });
  const parentRel = path.dirname(relativePath);
  if (parentRel === '.') return;

  let current = targetDir;
  for (const segment of parentRel.split(path.sep)) {
    if (!segment || segment === '.') continue;
    current = path.join(current, segment);
    ensureDirectoryWithoutFollowingSymlink(current);
  }
}

function removeBundlePath(targetPath: string): void {
  const stat = lstatIfExists(targetPath);
  if (!stat) return;

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      removeBundlePath(path.join(targetPath, entry.name));
    }
    fs.rmdirSync(targetPath);
    return;
  }

  fs.unlinkSync(targetPath);
}

/**
 * Distribute skill bundles (directories) to target platforms.
 * Copies all files in each skill directory, preserving structure.
 */
export function distributeBundle<TEntry, Platform extends string>(
  opts: DistributeBundleOptions<TEntry, Platform>
): DistributeBundleOutcome<Platform> {
  if (opts.scope?.project && opts.projectMode === 'none') {
    return { results: [] };
  }

  const dryRun = opts.dryRun === true;
  const agentSync = loadLibraryAgentSync(opts.section);
  const results: BundleDistributionResult<Platform>[] = [];
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
  // First managed sync: if manifest has no entries for this section, skip
  // conflict detection so existing directories get adopted into the manifest.
  const sectionEntries = manifest?.sections[manifestSection];
  const isBootstrapSync =
    manifest != null && (!sectionEntries || Object.keys(sectionEntries).length === 0);

  for (const platform of opts.platforms) {
    const platformHash = createHash('sha256');
    const bundleRootDir = resolveBundleRootDir(opts, platform);

    // Apply per-platform filter if provided
    const platformSelected = opts.filterSelected
      ? opts.filterSelected(platform, opts.selected)
      : opts.selected;

    for (const entry of platformSelected) {
      const targetDir = opts.resolveTargetDir(platform, entry);
      const files = opts.listFiles(entry);
      const entryId = opts.getId(entry);
      if (managedProjectRoot) {
        try {
          assertPathWithinRoot(managedProjectRoot, targetDir);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({
            platform,
            targetDir,
            status: 'error',
            error: `Failed to prepare ${entryId}: ${msg}`,
            entryId,
          });
          continue;
        }
      }
      if (bundleRootDir) {
        try {
          assertSafeBundleTarget(bundleRootDir, targetDir);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({
            platform,
            targetDir,
            status: 'error',
            error: `Failed to prepare ${entryId}: ${msg}`,
            entryId,
          });
          continue;
        }
      }
      const targetDirStat = lstatIfExists(targetDir);
      const targetDirExists = targetDirStat != null;
      const targetDirIsSymlink = targetDirStat?.isSymbolicLink() === true;
      const manifestEntry = manifest
        ? getLibraryEntry(manifest, manifestSection, entryId, platform as string)
        : undefined;
      const canAdoptBootstrapDir =
        manifest != null &&
        isBootstrapSync &&
        !manifestEntry &&
        targetDirExists &&
        isAdoptableBundleDir(targetDir, files);

      if (
        manifestEntry &&
        targetDirExists &&
        collision !== 'takeover' &&
        bundleFingerprint(targetDir) !== manifestEntry.hash &&
        !(
          !manifestEntry.hash.startsWith('tree:') &&
          isAdoptableBundleDir(targetDir, files) &&
          !hasEmptyDirectory(targetDir)
        )
      ) {
        const isHardError = collision === 'error';
        results.push({
          platform,
          targetDir,
          status: isHardError ? 'error' : 'conflict',
          ...(isHardError
            ? { error: 'managed directory was modified' }
            : { reason: 'managed directory was modified' }),
          entryId,
        });
        continue;
      }

      // Conflict detection in managed mode: check if target dir exists but isn't owned.
      if (manifest && targetDirExists && !manifestEntry && collision !== 'takeover') {
        if (!canAdoptBootstrapDir) {
          const isHardError = collision === 'error';
          results.push({
            platform,
            targetDir,
            status: isHardError ? 'error' : 'conflict',
            ...(isHardError
              ? { error: 'foreign directory exists' }
              : { reason: 'foreign directory exists' }),
            entryId,
          });
          // Intentionally not included in aggregate hash: content was not
          // written, so it should not affect sync-state comparison.
          continue;
        }
      }

      const replaceTargetDir = targetDirIsSymlink;
      if (replaceTargetDir && !dryRun) {
        try {
          fs.unlinkSync(targetDir);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({
            platform,
            targetDir,
            status: 'error',
            error: `Failed to replace ${entryId}: ${msg}`,
            entryId,
          });
          continue;
        }
      }

      let filesWritten = 0;
      let filesSkipped = 0;
      let hadError = false;
      let errorMessage = '';
      for (const file of files) {
        const targetPath = path.join(targetDir, file.relativePath);

        try {
          if (!dryRun) ensureBundleParentDir(targetDir, file.relativePath);

          const srcContent = fs.readFileSync(file.sourcePath);
          const srcMode = fs.statSync(file.sourcePath).mode & 0o777;
          let same = false;
          let modeSame = true;
          let replaceExistingTarget = false;

          if (!replaceTargetDir) {
            const dstStat = lstatIfExists(targetPath);
            replaceExistingTarget = dstStat?.isSymbolicLink() === true;
            if (replaceExistingTarget) {
              modeSame = false;
            } else if (dstStat) {
              const dstContent = fs.readFileSync(targetPath);
              same = Buffer.compare(srcContent, dstContent) === 0;
              if (dstStat.isFile()) {
                const dstMode = dstStat.mode & 0o777;
                modeSame = targetModeMatchesSourceExecutableBits(srcMode, dstMode);
              }
            }
          }

          if (!same || !modeSame) {
            if (!dryRun) {
              if (replaceExistingTarget) fs.unlinkSync(targetPath);
              if (!same) fs.writeFileSync(targetPath, srcContent);

              const currentMode = fs.statSync(targetPath).mode & 0o777;
              if (!targetModeMatchesSourceExecutableBits(srcMode, currentMode)) {
                fs.chmodSync(targetPath, desiredTargetMode(srcMode, currentMode));
              }
            }
            filesWritten++;
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

      // Clean stale files: remove files in target that are no longer in source bundle
      if (!dryRun && !hadError && lstatIfExists(targetDir)?.isDirectory()) {
        const expectedFiles = new Set(files.map((f) => f.relativePath));
        try {
          cleanStaleFiles(targetDir, '', expectedFiles);
        } catch (error) {
          hadError = true;
          const msg = error instanceof Error ? error.message : String(error);
          errorMessage = `Failed to clean stale files: ${msg}`;
        }
      }

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

      // Record the exact installed tree after successful write or skip.
      if (!dryRun && manifest && managedProjectRoot) {
        const lastResult = results[results.length - 1];
        if (lastResult.status === 'written' || lastResult.status === 'skipped') {
          const fingerprint = bundleFingerprint(targetDir);
          if (fingerprint) {
            recordLibraryEntry(manifest, manifestSection, entryId, {
              relativePath: path.relative(path.resolve(managedProjectRoot), targetDir),
              targetId: platform as string,
              hash: fingerprint,
              updatedAt: timestamp,
            });
          }
        }
      }
    }

    const aggregateHash = platformHash.digest('hex');
    const prev = agentSync[platform]?.hash;

    // Cleanup orphan directories
    if (opts.cleanup) {
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
                targetDir: entryPath,
                status: 'skipped',
                reason: 'shared path still owned by another target',
                entryId: item.id,
              });
            } else if (lstatIfExists(entryPath)) {
              if (bundleFingerprint(entryPath) !== item.entry.hash) {
                results.push({
                  platform,
                  targetDir: entryPath,
                  status: 'conflict',
                  reason: 'managed directory was modified',
                  entryId: item.id,
                });
                continue;
              }
              if (!dryRun) {
                assertPathWithinRoot(managedProjectRoot, entryPath);
                removeBundlePath(entryPath);
              }
              results.push({
                platform,
                targetDir: entryPath,
                status: 'deleted',
                reason: 'orphan',
                entryId: item.id,
              });
            } else {
              results.push({
                platform,
                targetDir: entryPath,
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
              targetDir: entryPath,
              status: 'error',
              error: `Failed to delete orphan: ${msg}`,
              entryId: item.id,
            });
          }
        }
      } else {
        // Exclusive mode: scan directory for orphans (existing behavior)
        const parentDir = opts.cleanup.resolveParentDir(platform);

        try {
          if (bundleRootDir) {
            assertSafeBundleTarget(bundleRootDir, parentDir);
          } else {
            assertUsableBundleRoot(parentDir);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({
            platform,
            targetDir: parentDir,
            status: 'error',
            error: `Failed to scan orphan parent: ${msg}`,
          });
          continue;
        }

        if (fs.existsSync(parentDir)) {
          try {
            const dirEntries = fs.readdirSync(parentDir, { withFileTypes: true });
            for (const dirEntry of dirEntries) {
              if (!dirEntry.isDirectory() && !dirEntry.isSymbolicLink()) continue;

              const id = dirEntry.name;
              if (opts.cleanup.isReservedDir?.(id, platform)) continue;
              if (!activeIds.has(id)) {
                const dirPath = path.join(parentDir, id);
                try {
                  if (!dryRun) removeBundlePath(dirPath);
                  results.push({
                    platform,
                    targetDir: dirPath,
                    status: 'deleted',
                    reason: 'orphan',
                    entryId: id,
                  });
                } catch (error) {
                  const msg = error instanceof Error ? error.message : String(error);
                  results.push({
                    platform,
                    targetDir: dirPath,
                    status: 'error',
                    error: `Failed to delete orphan: ${msg}`,
                    entryId: id,
                  });
                }
              }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            results.push({
              platform,
              targetDir: parentDir,
              status: 'error',
              error: `Failed to scan orphan parent: ${msg}`,
            });
          }
        }
      }
    }

    // Update sync state after cleanup, so cleanup failures do not record durable success.
    const hadErrors = results.some((r) => r.platform === platform && r.status === 'error');

    if (!dryRun && !hadErrors && prev !== aggregateHash) {
      updateLibraryAgentSync(opts.section, (current) => ({
        ...current,
        [platform]: { hash: aggregateHash, updatedAt: timestamp },
      }));
    }
  }

  return { results };
}

/** Recursively remove files in targetDir not present in expectedFiles (relative paths). */
function cleanStaleFiles(dir: string, prefix: string, expectedFiles: Set<string>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      cleanStaleFiles(abs, rel, expectedFiles);
      const remaining = fs.readdirSync(abs);
      if (remaining.length === 0) fs.rmdirSync(abs);
    } else if (!expectedFiles.has(rel)) {
      fs.unlinkSync(abs);
    }
  }
}
