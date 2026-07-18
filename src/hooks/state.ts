/** Device-scoped ownership; shared predecessor state is recognition-only. */

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
  /** Failed legacy hooks/asb directory removals awaiting retry. */
  legacyBundles: string[];
}

export function hooksStateDir(): string {
  return path.join(getConfigDir(), 'state', 'hooks');
}

function hookStateFileName(target: HookStateTarget, scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    const resolved = path.resolve(projectRoot);
    const slug = projectPathToSlug(resolved);
    // The slug alone is ambiguous (`a--b/c` vs `a/b--c`); a short hash of the
    // home-relative path disambiguates while staying machine-portable.
    const rel = path.relative(os.homedir(), resolved).split(path.sep).join('/');
    const hash = createHash('sha256').update(rel).digest('hex').slice(0, 10);
    return `${target}--${slug}-${hash}.json`;
  }
  return `${target}.json`;
}

export function resolveHookStatePath(target: HookStateTarget, scope?: ConfigScope): string {
  return path.join(hooksStateDir(), deviceStateId(), hookStateFileName(target, scope));
}

export function emptyHookState(): HookOwnershipState {
  return { version: 1, events: {}, bundles: [], legacyBundles: [] };
}

function loadHookStateAt(filePath: string): HookOwnershipState {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
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
      const legacyBundles = Array.isArray(record.legacyBundles)
        ? record.legacyBundles.filter((b): b is string => typeof b === 'string' && b.length > 0)
        : [];
      return { version: 1, events, bundles, legacyBundles };
    }
  } catch {
    // Missing or corrupt state loads as empty and grants no deletion authority.
  }
  return emptyHookState();
}

export function loadHookState(target: HookStateTarget, scope?: ConfigScope): HookOwnershipState {
  return loadHookStateAt(resolveHookStatePath(target, scope));
}

/** Shared predecessor state is read-only evidence and never deletion authority. */
export function loadSharedHookState(
  target: HookStateTarget,
  scope?: ConfigScope
): HookOwnershipState {
  return loadHookStateAt(path.join(hooksStateDir(), hookStateFileName(target, scope)));
}

export function saveHookState(
  target: HookStateTarget,
  state: HookOwnershipState,
  scope?: ConfigScope
): void {
  const filePath = resolveHookStatePath(target, scope);
  const hasContent =
    Object.keys(state.events).length > 0 ||
    state.bundles.length > 0 ||
    state.legacyBundles.length > 0;
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
  /** Event maps recovered from v0.4.28 state files as read-only recognition evidence. */
  groups: Record<string, unknown[]>[];
}

export function retainedCleanupIds(
  candidates: ReadonlySet<string>,
  results: readonly { status: string; entryId?: string }[]
): string[] {
  if (results.some((result) => result.status === 'error' && !result.entryId)) {
    return [...candidates];
  }
  return results.flatMap((result) =>
    result.status === 'error' && result.entryId && candidates.has(result.entryId)
      ? [result.entryId]
      : []
  );
}

/** Read v0.4.28 groups as scope-local recognition evidence. */
export function consumeLegacyManagedState(
  target: HookStateTarget,
  scope?: ConfigScope
): LegacyStateConsumption {
  const projectRoot = scope?.project?.trim();
  const dir =
    projectRoot && projectRoot.length > 0
      ? path.join(path.resolve(projectRoot), '.asb', 'state', 'hooks')
      : hooksStateDir();

  const groups: Record<string, unknown[]>[] = [];

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
      if (match?.[1] === target && entry.isFile()) {
        try {
          const parsed = JSON.parse(fs.readFileSync(entryPath, 'utf-8')) as {
            hooks?: Record<string, unknown[]>;
          };
          if (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)) {
            groups.push(parsed.hooks);
          }
        } catch {
          // Unreadable legacy state carries no recognition evidence.
        }
      }
    }
  }

  return { groups };
}
