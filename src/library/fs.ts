import fs from 'node:fs';
import path from 'node:path';
import { getAgentsDir, getCommandsDir, getConfigDir, getHooksDir } from '../config/paths.js';

function ensureDir(dirPath: string, mode: number): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
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
  const base = getConfigDir();
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }

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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
