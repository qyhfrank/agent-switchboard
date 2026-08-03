/**
 * Who wrote a hook group in an app config, read from the group itself. A
 * command running a file under the app's managed hook directory names the
 * library hook it came from; a predecessor's marker line says asb without
 * saying which hook. Everything else in the config is the user's.
 */

const LEGACY_MARKER_LINES = [
  '# asb-managed-by=agent-switchboard',
  '# asb-hook-id=',
  '# asb-bundle-sha256=',
];

/** v0.4.28 path-token ownership patterns. Keep byte-identical to 0.4.35. */
const V0428_MANAGED_RE =
  /(?:^|[\s"'`=(:;&|<>])(?:\$HOME|~|\/(?!\/))[^\s"'`;|&<>]*\/hooks\/managed\/[0-9a-f]{64}\//;
const MANAGED_ID_ANY_HOME_RE =
  /(?:^|[\s"'`=(:;&|<>])(?:\$HOME|~|\/(?!\/))[^\s"'`;|&<>]*\/hooks\/managed\/([^/\s"'`;|&<>]+)/g;
const LEGACY_ASB_ID_ANY_HOME_RE =
  /(?:^|[\s"'`=(:;&|<>])(?:\$HOME|~|\/(?!\/))[^\s"'`;|&<>]*\/hooks\/asb\/([^/\s"'`;|&<>]+)/g;
const COMMAND_PATH_BOUNDARY = /[\s"'`=(:;&|<>]/;
const COMMAND_FIELDS = ['command', 'commandWindows', 'command_windows'] as const;

export interface OwnershipContext {
  legacyAsbRoots: readonly string[];
  managedRoots: readonly string[];
  knownManagedIds: ReadonlySet<string>;
}

/**
 * Which library hook a group in an app config belongs to. `managed` carries
 * the id a managed path inside the group's commands names; `legacy` is a
 * predecessor's own marker, which proves the group is asb's without saying
 * which hook it came from.
 */
export type HookGroupOwner = { kind: 'managed'; id: string } | { kind: 'legacy' } | null;

function findPathTokenIndexes(command: string, pathPrefix: string): number[] {
  const needle = `${pathPrefix}/`;
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= command.length - needle.length) {
    const index = command.indexOf(needle, offset);
    if (index < 0) break;
    if (index === 0 || COMMAND_PATH_BOUNDARY.test(command[index - 1] ?? '')) {
      indexes.push(index);
    }
    offset = index + 1;
  }
  return indexes;
}

export function commandContainsPathToken(command: string, pathPrefix: string): boolean {
  return findPathTokenIndexes(command, pathPrefix).length > 0;
}

export function extractPathTokenSegments(command: string, pathPrefix: string): string[] {
  const needle = `${pathPrefix}/`;
  const segments: string[] = [];
  for (const index of findPathTokenIndexes(command, pathPrefix)) {
    const rest = command.slice(index + needle.length);
    const end = rest.search(/[/\s"'`]/);
    const segment = end >= 0 ? rest.slice(0, end) : rest;
    if (segment.length > 0) segments.push(segment);
  }
  return segments;
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
      extractIdsByPattern(command, LEGACY_ASB_ID_ANY_HOME_RE).some((id) => knownManagedIds.has(id))
  );
}

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

/** The managed id a group's commands name, when every command names one. */
function managedIdOf(
  group: unknown,
  managedRoots: readonly string[],
  knownManagedIds: ReadonlySet<string>
): string | null {
  for (const command of groupCommands(group)) {
    for (const root of managedRoots) {
      for (const segment of extractPathTokenSegments(command, root)) {
        if (knownManagedIds.has(segment)) return segment;
      }
    }
    for (const id of extractIdsByPattern(command, MANAGED_ID_ANY_HOME_RE)) {
      if (knownManagedIds.has(id)) return id;
    }
  }
  return null;
}

/**
 * A group's owner, from the group alone. A command running a file under the
 * app's managed hook directory, named after a hook the library defines, is
 * asb's doing however it got there; nothing else in the config is.
 */
export function hookGroupOwner(group: unknown, ctx: OwnershipContext): HookGroupOwner {
  const managedRoots = ctx.managedRoots.map(normalizeRoot);
  if (isManagedPathOwnedGroup(group, managedRoots, ctx.knownManagedIds)) {
    const id = managedIdOf(group, managedRoots, ctx.knownManagedIds);
    if (id !== null) return { kind: 'managed', id };
  }
  if (isLegacyOwnedGroup(group, ctx.legacyAsbRoots.map(normalizeRoot), ctx.knownManagedIds)) {
    return { kind: 'legacy' };
  }
  return null;
}
