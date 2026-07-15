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

/**
 * Follow the symlink chain by readlink so a dangling link still resolves to
 * its intended target (publishing there keeps the link alive), instead of
 * silently replacing the link with a regular file.
 */
function resolvePublishTarget(filePath: string): string {
  let current = filePath;
  for (let depth = 0; depth < 8; depth++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  throw new Error(`too many levels of symbolic links: ${filePath}`);
}

export function publishJsonConfig(filePath: string, data: Record<string, unknown>): void {
  ensureParentDir(filePath);
  const target = resolvePublishTarget(filePath);
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // New file: default mode.
  }
  ensureParentDir(target);
  // Per-process temp name: concurrent syncs must not interleave writes into a
  // shared temp file before the atomic rename.
  const tmpPath = `${target}.asb-write.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf-8',
    ...(mode !== undefined ? { mode } : {}),
  });
  fs.renameSync(tmpPath, target);
  removeStaleWriteTmps(target);
}

/**
 * Best-effort removal of temp files a crashed publish left behind. Only
 * entries older than the freshness window are touched, so a concurrent
 * publish keeps its in-flight temp file.
 */
function removeStaleWriteTmps(target: string): void {
  const prefix = `${path.basename(target)}.asb-write.`;
  const cutoff = Date.now() - 10 * 60_000;
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(target));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const stalePath = path.join(path.dirname(target), name);
    try {
      if (fs.lstatSync(stalePath).mtimeMs < cutoff) fs.rmSync(stalePath, { force: true });
    } catch {
      // Already gone or unreadable: nothing to clean.
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
 * user's config. They sit beside the logical path or, for symlinked configs,
 * beside the resolved write target; both locations are checked. Distribution
 * refuses to touch such a target; the user restores or deletes the artifacts
 * once.
 */
export function findTransactionArtifacts(filePath: string): string[] {
  const candidates = new Set([filePath]);
  try {
    candidates.add(resolvePublishTarget(filePath));
  } catch {
    // A broken symlink chain surfaces at publish time.
  }
  const found = new Set<string>();
  for (const candidate of candidates) {
    const base = path.basename(candidate);
    const prefixes = [`${base}.previous.`, `${base}.tmp.`, `${base}.failed.`];
    let entries: string[];
    try {
      entries = fs.readdirSync(path.dirname(candidate));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) {
        found.add(path.join(path.dirname(candidate), name));
      }
    }
  }
  return [...found].sort();
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
