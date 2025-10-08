import fs from 'node:fs';
import path from 'node:path';
import { getCommandsDir, getConfigDir, getSubagentsDir } from '../config/paths.js';

function ensureDir(dirPath: string, mode: number): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
  try {
    // Normalize permissions (best-effort; subject to OS umask and platform)
    fs.chmodSync(dirPath, mode);
  } catch {
    // Ignore chmod errors on platforms without POSIX perms (e.g., Windows)
  }
}

/**
 * Ensures the Agent Switchboard library directories exist with secure permissions.
 * - Base config dir: created if missing (mode is left to existing defaults)
 * - Commands dir: 0o700
 * - Subagents dir: 0o700
 */
export function ensureLibraryDirectories(): void {
  const base = getConfigDir();
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }

  ensureDir(getCommandsDir(), 0o700);
  ensureDir(getSubagentsDir(), 0o700);
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

// Backup helper removed: policy is write-through without side-by-side backups.
