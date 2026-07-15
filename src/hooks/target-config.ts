/**
 * Application config I/O shared by the hook distributors.
 *
 * Configs are read through symlinks and published atomically by renaming a
 * temp file over the resolved target, so mackup-style layouts keep their
 * symlinks and a crash never leaves a truncated or missing config. This is
 * the only place hook distribution resolves a symlink, and the resolved path
 * is used solely as the rename destination, never to derive other paths.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureParentDir } from '../library/fs.js';

export function readJsonConfig(
  filePath: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  try {
    if (fs.existsSync(filePath)) {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, error: 'config root must be a JSON object' };
      }
      return { ok: true, data: value as Record<string, unknown> };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, data: {} };
}

function resolvePublishTarget(filePath: string): string {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return fs.realpathSync(filePath);
  } catch {
    // New file: publish at the logical path.
  }
  return filePath;
}

export function publishJsonConfig(filePath: string, data: Record<string, unknown>): void {
  ensureParentDir(filePath);
  const target = resolvePublishTarget(filePath);
  // Per-process temp name: concurrent syncs must not interleave writes into a
  // shared temp file before the atomic rename.
  const tmpPath = `${target}.asb-write.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, target);
  removeStaleWriteTmps(target);
}

/** Best-effort removal of temp files a crashed publish left behind. */
function removeStaleWriteTmps(target: string): void {
  const prefix = `${path.basename(target)}.asb-write.`;
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(target));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) {
      fs.rmSync(path.join(path.dirname(target), name), { force: true });
    }
  }
}

/** Delete a config file; a symlinked config is emptied instead so the link survives. */
export function deleteJsonConfig(filePath: string): void {
  let isSymlink = false;
  try {
    isSymlink = fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return;
  }
  if (isSymlink) {
    publishJsonConfig(filePath, {});
  } else {
    fs.unlinkSync(filePath);
  }
}

/**
 * v0.4.28 transactional writes left `<config>.previous.*` / `<config>.tmp.*` /
 * `<config>.failed.*` siblings behind, possibly holding the only copy of the
 * user's config. Distribution refuses to touch such a target; the user
 * restores or deletes the artifacts once.
 */
export function findTransactionArtifacts(filePath: string): string[] {
  const base = path.basename(filePath);
  const prefixes = [`${base}.previous.`, `${base}.tmp.`, `${base}.failed.`];
  let entries: string[];
  try {
    entries = fs.readdirSync(path.dirname(filePath));
  } catch {
    return [];
  }
  return entries
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => path.join(path.dirname(filePath), name))
    .sort();
}

/**
 * Replace the homedir prefix with `$HOME` so distributed commands stay
 * portable across machines sharing the same dotfiles. Boundary-checked:
 * only `<home>/` at the start of a path token is substituted, so neither
 * `/Users/alice2/...` nor `/backup/Users/alice/...` is rewritten by
 * `/Users/alice`.
 */
export function preferHomeVar(command: string): string {
  const home = os.homedir().replace(/\/+$/, '');
  if (home.length === 0) return command;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command.replace(new RegExp(`(^|[\\s"'\`=(:;&|<>])${escaped}/`, 'g'), '$1$HOME/');
}

/** Expand a leading `$HOME/` or `~/` to the current home directory. */
export function expandPortablePath(p: string): string {
  if (p.startsWith('$HOME/')) return path.join(os.homedir(), p.slice('$HOME/'.length));
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
