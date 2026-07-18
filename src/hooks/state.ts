/**
 * Managed hook ownership state.
 *
 * Records, per (target, scope), exactly the hook groups ASB last wrote into
 * the application config plus the bundle directory names it manages, so
 * distribution can remove its own output without leaving any ASB metadata
 * inside application configs. Files live under
 * `<ASB_HOME>/state/hooks/<device>/` and stay
 * machine-portable: commands in `$HOME` form, bare directory names, no
 * absolute paths.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deviceStateId } from '../config/device-id.js';
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
  const stateDir = path.join(hooksStateDir(), deviceStateId());
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    const resolved = path.resolve(projectRoot);
    const slug = projectPathToSlug(resolved);
    // The slug alone is ambiguous (`a--b/c` vs `a/b--c`); a short hash of the
    // home-relative path disambiguates while staying machine-portable.
    const rel = path.relative(os.homedir(), resolved).split(path.sep).join('/');
    const hash = createHash('sha256').update(rel).digest('hex').slice(0, 10);
    return path.join(stateDir, `${target}--${slug}-${hash}.json`);
  }
  return path.join(stateDir, `${target}.json`);
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
      // Only the schema this code writes may serve as deletion evidence.
      if (record.version !== 1) return emptyHookState();
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
    // Missing or corrupt state loads as empty and grants no deletion authority.
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
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

const LEGACY_STATE_FILE_RE = /^(claude-code|codex)-[0-9a-f]{64}\.json$/;

export interface LegacyStateConsumption {
  /** Event maps recovered from v0.4.28 state files, as removal candidates. */
  groups: Record<string, unknown[]>[];
  /** Whether any legacy state file or litter entry was found. */
  found: boolean;
  /** Delete the consumed files and litter; call only after the config and new state committed. */
  cleanup: () => void;
}

/**
 * Read the hook groups recorded by v0.4.28 state files so they can join the
 * removal candidates, and plan deletion of the v0.4.28 state litter:
 * hash-named state files, their `.lock`/`.legacy-bundles` variants, and the
 * `locks/` directory. The scan stays inside the current scope's own state
 * directory (global sync never consumes project evidence and vice versa;
 * the file names carry no config identity to match across scopes), and a
 * symlinked state directory is left alone. Deletion is deferred to
 * `cleanup()` so a failed sync keeps its migration evidence.
 */
export function consumeLegacyManagedState(
  target: HookStateTarget,
  scope: ConfigScope | undefined,
  dryRun: boolean
): LegacyStateConsumption {
  const projectRoot = scope?.project?.trim();
  const dir =
    projectRoot && projectRoot.length > 0
      ? path.join(path.resolve(projectRoot), '.asb', 'state', 'hooks')
      : hooksStateDir();

  const groups: Record<string, unknown[]>[] = [];
  const doomed: string[] = [];

  const dirStat = (() => {
    try {
      return fs.lstatSync(dir);
    } catch {
      return undefined;
    }
  })();
  if (dirStat?.isDirectory() && !dirStat.isSymbolicLink()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable state dir: nothing to consume.
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
              groups.push(parsed.hooks);
            }
          } catch {
            // Unreadable legacy state carries nothing to remove.
          }
          doomed.push(entryPath);
        }
        continue;
      }
      const isLitter =
        entry.name === 'locks' || /^(claude-code|codex)-[0-9a-f]{64}\./.test(entry.name);
      if (isLitter) doomed.push(entryPath);
    }
  }

  return {
    groups,
    found: doomed.length > 0,
    cleanup: () => {
      if (dryRun) return;
      for (const entryPath of doomed) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    },
  };
}
