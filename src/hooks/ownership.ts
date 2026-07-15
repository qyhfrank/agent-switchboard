/**
 * Ownership matching for ASB-managed hook groups inside application configs.
 *
 * Application configs carry no ASB metadata, so ownership is established from
 * the ASB side: the state file records exactly what was written, and path
 * heuristics recognize ASB bundle references (including legacy `hooks/asb/`
 * layouts, legacy Codex command markers, and v0.4.28 `hooks/managed/<sha256>`
 * output) without ever treating the neutral `hooks/managed/` root alone as
 * proof of ownership.
 */

import { isDeepStrictEqual } from 'node:util';
import { commandContainsPathToken, extractPathTokenSegments } from './command-paths.js';

const LEGACY_MARKER_LINES = [
  '# asb-managed-by=agent-switchboard',
  '# asb-hook-id=',
  '# asb-bundle-sha256=',
];

/** v0.4.28 wrote bundles to <root>/hooks/managed/<sha256-ns>/<sha256-key>/. */
const V0428_MANAGED_RE = /\/hooks\/managed\/[0-9a-f]{64}\//;
const V0428_MANAGED_DIR_RE =
  /(?:^|[\s"'`=(:;&|<>])((?:\$HOME|~|\/)[^\s"'`;|&<>]*\/hooks\/managed\/[0-9a-f]{64})\//g;

const COMMAND_FIELDS = ['command', 'commandWindows', 'command_windows'] as const;

export interface OwnershipContext {
  /** Legacy `hooks/asb` parent dirs, raw and `$HOME` forms, no trailing slash. */
  legacyAsbRoots: readonly string[];
  /** `hooks/managed` parent dirs, raw and `$HOME` forms, no trailing slash. */
  managedRoots: readonly string[];
  /** Bundle directory names ASB may own under the managed roots. */
  knownManagedIds: ReadonlySet<string>;
  /** Event maps whose groups are removed by count-bounded deep equality. */
  stateGroups: ReadonlyArray<Record<string, unknown[]>>;
}

export interface OwnershipRemoval {
  /** Remaining (user-owned) groups per event; null-prototype record. */
  hooks: Record<string, unknown[]>;
  /** Whether any group was removed. */
  removed: boolean;
  /** Commands of removed groups that reference v0.4.28 hash directories. */
  v0428Commands: string[];
  /** `<id>` segments referenced under the legacy asb roots by removed groups. */
  removedLegacyAsbIds: Set<string>;
}

function groupCommands(group: unknown): string[] {
  if (!group || typeof group !== 'object') return [];
  const handlers = (group as Record<string, unknown>).hooks;
  if (!Array.isArray(handlers)) return [];
  const commands: string[] = [];
  for (const handler of handlers) {
    if (!handler || typeof handler !== 'object') continue;
    for (const field of COMMAND_FIELDS) {
      const value = (handler as Record<string, unknown>)[field];
      if (typeof value === 'string') commands.push(value.split('\\').join('/'));
    }
  }
  return commands;
}

function hasLegacyMarker(command: string): boolean {
  return command
    .split(/\r?\n/)
    .some((line) =>
      LEGACY_MARKER_LINES.some((marker) =>
        marker.endsWith('=') ? line.trim().startsWith(marker) : line.trim() === marker
      )
    );
}

function normalizeRoot(root: string): string {
  return root.split('\\').join('/').replace(/\/+$/, '');
}

/** Owned by legacy or v0.4.28 evidence: markers, `_asb_source`, asb/ paths, hash dirs. */
function isLegacyOwnedGroup(group: unknown, legacyAsbRoots: readonly string[]): boolean {
  if (group && typeof group === 'object' && '_asb_source' in (group as Record<string, unknown>)) {
    return true;
  }
  const commands = groupCommands(group);
  return commands.some(
    (command) =>
      hasLegacyMarker(command) ||
      V0428_MANAGED_RE.test(command) ||
      legacyAsbRoots.some((root) => commandContainsPathToken(command, root))
  );
}

/**
 * Owned via the neutral managed root only when every command-bearing handler
 * references a known bundle id under a managed root (and at least one does).
 */
function isManagedPathOwnedGroup(
  group: unknown,
  managedRoots: readonly string[],
  knownManagedIds: ReadonlySet<string>
): boolean {
  const commands = groupCommands(group);
  if (commands.length === 0) return false;
  return commands.every((command) =>
    managedRoots.some((root) =>
      extractPathTokenSegments(command, root).some((segment) => knownManagedIds.has(segment))
    )
  );
}

export function removeOwnedHookGroups(
  existingHooks: Record<string, unknown[]>,
  ctx: OwnershipContext
): OwnershipRemoval {
  const legacyAsbRoots = ctx.legacyAsbRoots.map(normalizeRoot);
  const managedRoots = ctx.managedRoots.map(normalizeRoot);

  const hooks: Record<string, unknown[]> = Object.create(null);
  const removedGroups: unknown[] = [];
  for (const [event, groups] of Object.entries(existingHooks)) {
    if (!Array.isArray(groups)) continue;
    let remaining = [...groups];

    // (a) count-bounded deep-equal removal of state-recorded instances
    for (const stateEvents of ctx.stateGroups) {
      const stateGroupsForEvent = stateEvents[event];
      if (!Array.isArray(stateGroupsForEvent)) continue;
      for (const stateGroup of stateGroupsForEvent) {
        const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, stateGroup));
        if (index >= 0) removedGroups.push(...remaining.splice(index, 1));
      }
    }

    // (b)-(e) marker and path heuristics
    remaining = remaining.filter((group) => {
      const owned =
        isLegacyOwnedGroup(group, legacyAsbRoots) ||
        isManagedPathOwnedGroup(group, managedRoots, ctx.knownManagedIds);
      if (owned) removedGroups.push(group);
      return !owned;
    });

    if (remaining.length > 0) hooks[event] = remaining;
  }

  const v0428Commands: string[] = [];
  const removedLegacyAsbIds = new Set<string>();
  for (const group of removedGroups) {
    for (const command of groupCommands(group)) {
      if (V0428_MANAGED_RE.test(command)) v0428Commands.push(command);
      for (const root of legacyAsbRoots) {
        for (const segment of extractPathTokenSegments(command, root)) {
          removedLegacyAsbIds.add(segment);
        }
      }
    }
  }

  return { hooks, removed: removedGroups.length > 0, v0428Commands, removedLegacyAsbIds };
}

/** Extract the v0.4.28 hash-directory paths referenced by removed commands. */
export function collectV0428BundleDirs(commands: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const command of commands) {
    for (const match of command.matchAll(V0428_MANAGED_DIR_RE)) {
      dirs.add(match[1]);
    }
  }
  return dirs;
}
