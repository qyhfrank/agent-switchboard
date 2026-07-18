/**
 * Ownership matching for ASB-managed hook groups inside application configs.
 *
 * Application configs carry no ASB metadata, so ownership is established from
 * the ASB side: the state file records exactly what was written, and path
 * heuristics recognize ASB bundle references supported by current-device state
 * or intrinsic legacy evidence. A library entry with the same id is not
 * ownership proof because application configs can be shared across devices.
 */

import { isDeepStrictEqual } from 'node:util';
import { commandContainsPathToken, extractPathTokenSegments } from './command-paths.js';

const LEGACY_MARKER_LINES = [
  '# asb-managed-by=agent-switchboard',
  '# asb-hook-id=',
  '# asb-bundle-sha256=',
];

/**
 * v0.4.28 wrote bundles to <root>/hooks/managed/<sha256-ns>/<sha256-key>/.
 * Recognition is bound to path tokens: the match must start a filesystem path
 * (`/`, `~`, or `$HOME` after a token boundary; `//` is excluded so URL
 * authorities such as `https://host/hooks/managed/...` never match).
 */
const V0428_MANAGED_RE =
  /(?:^|[\s"'`=(:;&|<>])(?:\$HOME|~|\/(?!\/))[^\s"'`;|&<>]*\/hooks\/managed\/[0-9a-f]{64}\//;
const V0428_MANAGED_DIR_RE =
  /(?:^|[\s"'`=(:;&|<>])((?:\$HOME|~|\/(?!\/))[^\s"'`;|&<>]*\/hooks\/managed\/[0-9a-f]{64})\//g;

/**
 * Named managed bundles under any home prefix. The known bundle id must come
 * from current-device ownership state; the home prefix is not proof.
 */
const MANAGED_ID_ANY_HOME_RE =
  /(?:^|[\s"'`=(:;&|<>])(?:\$HOME|~|\/(?!\/))[^\s"'`;|&<>]*\/hooks\/managed\/([^/\s"'`;|&<>]+)/g;

/**
 * Legacy ASB-branded `hooks/asb/<id>/` under any home prefix.
 */
const LEGACY_ASB_ID_ANY_HOME_RE =
  /(?:^|[\s"'`=(:;&|<>])(?:\$HOME|~|\/(?!\/))[^\s"'`;|&<>]*\/hooks\/asb\/([^/\s"'`;|&<>]+)/g;

const COMMAND_FIELDS = ['command', 'commandWindows', 'command_windows'] as const;

export interface OwnershipContext {
  /** Legacy `hooks/asb` parent dirs, raw and `$HOME` forms, no trailing slash. */
  legacyAsbRoots: readonly string[];
  /** `hooks/managed` parent dirs, raw and `$HOME` forms, no trailing slash. */
  managedRoots: readonly string[];
  /** Bundle directory names recorded in current-device ownership state. */
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

function isLegacyMarkerLine(line: string): boolean {
  return LEGACY_MARKER_LINES.some((marker) =>
    marker.endsWith('=') ? line.trim().startsWith(marker) : line.trim() === marker
  );
}

function hasLegacyMarker(command: string): boolean {
  return command.split(/\r?\n/).some(isLegacyMarkerLine);
}

/** Strip legacy ASB marker lines from a command imported by an older version. */
export function stripLegacyMarkerLines(command: string): string {
  if (!hasLegacyMarker(command)) return command;
  return command
    .split(/\r?\n/)
    .filter((line) => !isLegacyMarkerLine(line))
    .join('\n');
}

function normalizeRoot(root: string): string {
  return root.split('\\').join('/').replace(/\/+$/, '');
}

function extractIdsByPattern(command: string, pattern: RegExp): string[] {
  const ids: string[] = [];
  for (const match of command.matchAll(pattern)) {
    const id = match[1];
    if (id) ids.push(id);
  }
  return ids;
}

/** Owned by legacy or v0.4.28 evidence: markers, `_asb_source`, asb/ paths, hash dirs. */
function isLegacyOwnedGroup(
  group: unknown,
  legacyAsbRoots: readonly string[],
  knownManagedIds: ReadonlySet<string>
): boolean {
  if (
    group &&
    typeof group === 'object' &&
    (group as Record<string, unknown>)._asb_source === true
  ) {
    return true;
  }
  const commands = groupCommands(group);
  return commands.some(
    (command) =>
      hasLegacyMarker(command) ||
      V0428_MANAGED_RE.test(command) ||
      legacyAsbRoots.some((root) => commandContainsPathToken(command, root)) ||
      // Foreign-home paths require current-device state for the exact id.
      extractIdsByPattern(command, LEGACY_ASB_ID_ANY_HOME_RE).some((id) => knownManagedIds.has(id))
  );
}

/**
 * Owned via the neutral managed root only when every command-bearing handler
 * references a known bundle id under a managed root (and at least one does).
 * Foreign absolute homes count only when current-device state owns the trailing
 * id; an unknown id under `hooks/managed/` stays user-owned.
 */
function isManagedPathOwnedGroup(
  group: unknown,
  managedRoots: readonly string[],
  knownManagedIds: ReadonlySet<string>
): boolean {
  const commands = groupCommands(group);
  if (commands.length === 0) return false;
  return commands.every(
    (command) =>
      managedRoots.some((root) =>
        extractPathTokenSegments(command, root).some((segment) => knownManagedIds.has(segment))
      ) ||
      extractIdsByPattern(command, MANAGED_ID_ANY_HOME_RE).some((id) => knownManagedIds.has(id))
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
        isLegacyOwnedGroup(group, legacyAsbRoots, ctx.knownManagedIds) ||
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
