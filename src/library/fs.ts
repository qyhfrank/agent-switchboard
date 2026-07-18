import fs from 'node:fs';
import path from 'node:path';
import { getAgentsDir, getCommandsDir, getConfigDir, getHooksDir } from '../config/paths.js';

function ensureDir(dirPath: string, mode: number): void {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  try {
    fs.chmodSync(dirPath, mode);
  } catch {
    // Ignore chmod errors on platforms without POSIX perms
  }
}

/**
 * Migrate legacy ~/.asb/subagents/ directory to ~/.asb/agents/.
 * Only runs when the old directory exists and the new one does not.
 */
function migrateLegacySubagentsDir(): void {
  const base = getConfigDir();
  const oldDir = path.join(base, 'subagents');
  const newDir = getAgentsDir();

  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try {
      fs.renameSync(oldDir, newDir);
      console.log(`Migrated ${oldDir} → ${newDir}`);
    } catch {
      // Fall through; ensureDir will create the new one
    }
  }
}

/**
 * Ensures the Agent Switchboard library directories exist with secure permissions.
 * Runs legacy migration first, then creates missing directories.
 */
export function ensureLibraryDirectories(): void {
  migrateLegacySubagentsDir();

  ensureDir(getCommandsDir(), 0o700);
  ensureDir(getAgentsDir(), 0o700);
  ensureDir(getHooksDir(), 0o700);
}

/**
 * Securely write a new library file with 0o600 permissions.
 * If the file exists, content is replaced and permissions are normalized best-effort.
 */
export function writeFileSecure(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Create or truncate; ensure mode for new files
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore chmod errors on non-POSIX platforms
  }
}

/** Ensure parent directory for an arbitrary file path exists. */
export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveThroughExistingAncestor(value: string, seen = new Set<string>()): string {
  const resolved = path.resolve(value);
  let existing = resolved;
  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (stat.isSymbolicLink()) {
        if (seen.has(existing)) throw new Error(`symlink loop in path: ${value}`);
        seen.add(existing);
        const target = path.resolve(path.dirname(existing), fs.readlinkSync(existing));
        return resolveThroughExistingAncestor(
          path.join(target, path.relative(existing, resolved)),
          seen
        );
      }
      return path.resolve(fs.realpathSync.native(existing), path.relative(existing, resolved));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      existing = parent;
    }
  }
}

/** Reject lexical escapes and paths redirected outside root by an existing symlink. */
export function assertPathWithinRoot(rootPath: string, targetPath: string): void {
  const root = resolveThroughExistingAncestor(rootPath);
  const target = resolveThroughExistingAncestor(targetPath);
  const lexical = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  const physical = path.relative(root, target);
  if (
    lexical.startsWith('..') ||
    path.isAbsolute(lexical) ||
    physical.startsWith('..') ||
    path.isAbsolute(physical)
  ) {
    throw new Error(`target path escapes root: ${targetPath}`);
  }
}

/** Check if path exists and is a directory. */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Check if path exists and is a file. */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Recursively list files with given extensions (empty = all files). */
export function listFilesRecursively(root: string, filterExts: string[]): string[] {
  const out: string[] = [];
  const exts = new Set(filterExts.map((e) => e.toLowerCase()));
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.size === 0 || exts.has(ext)) out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

/** Recursively copy directory. Preserves executable permissions. */
export function copyDirRecursive(
  src: string,
  dest: string,
  options?: { skipHidden?: boolean }
): void {
  fs.mkdirSync(dest, { recursive: true });
  const skipHidden = options?.skipHidden ?? false;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skipHidden && entry.name.startsWith('.')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, options);
    } else {
      fs.copyFileSync(srcPath, destPath);
      try {
        const mode = fs.statSync(srcPath).mode;
        if (mode & 0o111) fs.chmodSync(destPath, mode & 0o777);
      } catch {
        // Ignore permission errors
      }
    }
  }
}
