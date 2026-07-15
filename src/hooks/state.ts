/**
 * Managed hook ownership state.
 *
 * Records, per (target, scope), exactly the hook groups ASB last wrote into
 * the application config plus the bundle directory names it manages, so
 * distribution can remove its own output without leaving any ASB metadata
 * inside application configs. Files live under `~/.asb/state/hooks/` and stay
 * machine-portable: commands in `$HOME` form, bare directory names, no
 * absolute paths.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigDir } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import { ensureParentDir } from '../library/fs.js';
import { projectPathToSlug } from '../manifest/store.js';

export type HookStateTarget = 'claude-code' | 'codex';

export interface HookOwnershipState {
  version: 1;
  /** Exactly the matcher groups last written to the app config, per event. */
  events: Record<string, unknown[]>;
  /** Bundle directory names managed under the target's hooks/managed/. */
  bundles: string[];
}

export function hooksStateDir(): string {
  return path.join(getConfigDir(), 'state', 'hooks');
}

export function resolveHookStatePath(target: HookStateTarget, scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    const resolved = path.resolve(projectRoot);
    const slug = projectPathToSlug(resolved);
    // The slug alone is ambiguous (`a--b/c` vs `a/b--c`); a short hash of the
    // home-relative path disambiguates while staying machine-portable.
    const rel = path.relative(os.homedir(), resolved).split(path.sep).join('/');
    const hash = createHash('sha256').update(rel).digest('hex').slice(0, 10);
    return path.join(hooksStateDir(), `${target}--${slug}-${hash}.json`);
  }
  return path.join(hooksStateDir(), `${target}.json`);
}

export function emptyHookState(): HookOwnershipState {
  return { version: 1, events: {}, bundles: [] };
}

export function loadHookState(target: HookStateTarget, scope?: ConfigScope): HookOwnershipState {
  try {
    const raw = fs.readFileSync(resolveHookStatePath(target, scope), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const events: Record<string, unknown[]> = {};
      if (record.events && typeof record.events === 'object' && !Array.isArray(record.events)) {
        for (const [event, groups] of Object.entries(record.events as Record<string, unknown>)) {
          if (Array.isArray(groups) && groups.length > 0) events[event] = groups;
        }
      }
      const bundles = Array.isArray(record.bundles)
        ? record.bundles.filter((b): b is string => typeof b === 'string' && b.length > 0)
        : [];
      return { version: 1, events, bundles };
    }
  } catch {
    // Missing or corrupt state loads as empty; path heuristics still identify
    // bundle-backed groups on the next sync.
  }
  return emptyHookState();
}

export function saveHookState(
  target: HookStateTarget,
  state: HookOwnershipState,
  scope?: ConfigScope
): void {
  const filePath = resolveHookStatePath(target, scope);
  const hasContent = Object.keys(state.events).length > 0 || state.bundles.length > 0;
  if (!hasContent) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

const LEGACY_STATE_FILE_RE = /^(claude-code|codex)-[0-9a-f]{64}\.json$/;

/**
 * Read the hook groups recorded by v0.4.28 state files so they can join the
 * removal candidates, and (outside dry-run) delete the v0.4.28 state litter:
 * hash-named state files, `.legacy-bundles` markers, `.lock*` entries and the
 * `locks/` directory. The state directory is ASB-owned by construction.
 */
export function consumeLegacyManagedState(
  target: HookStateTarget,
  scope: ConfigScope | undefined,
  dryRun: boolean
): Record<string, unknown[]>[] {
  const dirs = [hooksStateDir()];
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    dirs.push(path.join(path.resolve(projectRoot), '.asb', 'state', 'hooks'));
  }

  const recovered: Record<string, unknown[]>[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const match = entry.name.match(LEGACY_STATE_FILE_RE);
      if (match && entry.isFile()) {
        if (match[1] === target) {
          try {
            const parsed = JSON.parse(fs.readFileSync(entryPath, 'utf-8')) as {
              hooks?: Record<string, unknown[]>;
            };
            if (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)) {
              recovered.push(parsed.hooks);
            }
          } catch {
            // Unreadable legacy state carries nothing to remove.
          }
          if (!dryRun) fs.rmSync(entryPath, { force: true });
        }
        continue;
      }
      const isLitter =
        entry.name === 'locks' || /^(claude-code|codex)-[0-9a-f]{64}\./.test(entry.name);
      if (isLitter && !dryRun) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  }
  return recovered;
}
