import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/**
 * Hook ownership state: a peer contract, not private engine state. A 0.4.35
 * asb on another machine reads and writes the same
 * `<ASB_HOME>/state/hooks/<target>.json`, so every byte, key order and file
 * lifecycle here is frozen 0.4.35 behavior — the file lives beside the
 * library, not in the machine-local state home the ledger uses. Hook groups
 * carry no ledger entry: this record is their only ownership evidence.
 */

export type HookTarget = 'claude-code' | 'codex';

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
const LEGACY_STATE_FILE_RE = /^(claude-code|codex)-[0-9a-f]{64}\.json$/;

export interface OwnershipContext {
  legacyAsbRoots: readonly string[];
  managedRoots: readonly string[];
  knownManagedIds: ReadonlySet<string>;
  stateGroups: ReadonlyArray<Record<string, unknown[]>>;
}

export interface OwnershipRemoval {
  hooks: Record<string, unknown[]>;
  removed: boolean;
  taken: Record<string, unknown[]>;
}

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

export function removeOwnedHookGroups(
  existingHooks: Record<string, unknown[]>,
  ctx: OwnershipContext
): OwnershipRemoval {
  const legacyAsbRoots = ctx.legacyAsbRoots.map(normalizeRoot);
  const managedRoots = ctx.managedRoots.map(normalizeRoot);
  const hooks: Record<string, unknown[]> = Object.create(null);
  const taken: Record<string, unknown[]> = Object.create(null);
  const removedGroups: unknown[] = [];
  for (const [event, groups] of Object.entries(existingHooks)) {
    if (!Array.isArray(groups)) continue;
    let remaining = [...groups];

    for (const stateEvents of ctx.stateGroups) {
      const stateGroupsForEvent = stateEvents[event];
      if (!Array.isArray(stateGroupsForEvent)) continue;
      for (const stateGroup of stateGroupsForEvent) {
        const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, stateGroup));
        if (index >= 0) {
          const removed = remaining.splice(index, 1);
          removedGroups.push(...removed);
          taken[event] = [...(taken[event] ?? []), ...removed];
        }
      }
    }

    remaining = remaining.filter((group) => {
      const owned =
        isLegacyOwnedGroup(group, legacyAsbRoots, ctx.knownManagedIds) ||
        isManagedPathOwnedGroup(group, managedRoots, ctx.knownManagedIds);
      if (owned) {
        removedGroups.push(group);
        taken[event] = [...(taken[event] ?? []), group];
      }
      return !owned;
    });
    if (remaining.length > 0) hooks[event] = remaining;
  }

  return { hooks, removed: removedGroups.length > 0, taken };
}

export function filterRecognizedDesiredGroups(
  existing: Record<string, unknown[]>,
  desired: Record<string, unknown[]>,
  evidence: ReadonlyArray<Record<string, unknown[]>>
): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = Object.create(null);
  for (const [event, groups] of Object.entries(desired)) {
    const remaining = [...(existing[event] ?? [])];
    const proofs = evidence.flatMap((events) => events[event] ?? []);
    for (const group of groups) {
      const existingIndex = remaining.findIndex((value) => isDeepStrictEqual(value, group));
      const proofIndex = proofs.findIndex((value) => isDeepStrictEqual(value, group));
      if (existingIndex >= 0 && proofIndex >= 0) {
        remaining.splice(existingIndex, 1);
        proofs.splice(proofIndex, 1);
      } else {
        if (!result[event]) result[event] = [];
        result[event].push(group);
      }
    }
  }
  return result;
}

/** Read v0.4.28 groups as scope-local recognition evidence. */
export function consumeLegacyManagedState(
  asbHome: string,
  target: HookTarget,
  projectRoot?: string
): Record<string, unknown[]>[] {
  const project = projectRoot?.trim();
  const dir = project
    ? path.join(path.resolve(project), '.asb', 'state', 'hooks')
    : path.join(asbHome, 'state', 'hooks');
  const groups: Record<string, unknown[]>[] = [];
  let entries: fs.Dirent[] = [];
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return groups;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return groups;
  }
  for (const entry of entries) {
    const match = entry.name.match(LEGACY_STATE_FILE_RE);
    if (match?.[1] !== target || !entry.isFile()) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8')) as {
        hooks?: Record<string, unknown[]>;
      };
      if (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)) {
        groups.push(parsed.hooks);
      }
    } catch {
      // Unreadable legacy state carries no recognition evidence.
    }
  }
  return groups;
}

export interface PeerState {
  version: 1;
  /** Exactly the matcher groups last appended to the app config, per event. */
  events: Record<string, unknown[]>;
  /** Bundle directory names owned under `<appRoot>/hooks/managed/`. */
  bundles: string[];
  /** Failed legacy `hooks/asb/` removals awaiting retry. */
  legacyBundles: string[];
}

/** v0.4.32 wrote one copy per device under `<state dir>/<16-hex>/`. */
const DEVICE_DIR_PATTERN = /^[0-9a-f]{16}$/;

export function peerStateDir(asbHome: string): string {
  return path.join(asbHome, 'state', 'hooks');
}

function peerStateFileName(target: HookTarget, projectRoot?: string): string {
  if (!projectRoot) return `${target}.json`;
  const resolved = path.resolve(projectRoot);
  const relative = path.relative(os.homedir(), resolved).split(path.sep).join('/');
  const hash = createHash('sha256').update(relative).digest('hex').slice(0, 10);
  return `${target}--${projectManifestSlug(resolved)}-${hash}.json`;
}

export function peerStatePath(asbHome: string, target: HookTarget, projectRoot?: string): string {
  return path.join(peerStateDir(asbHome), peerStateFileName(target, projectRoot));
}

export function emptyPeerState(): PeerState {
  // Event names come from the app's vocabulary, so the map is keyed by
  // untrusted strings: `__proto__` must read back as a missing event, not as
  // Object.prototype.
  return { version: 1, events: Object.create(null), bundles: [], legacyBundles: [] };
}

export function peerStateHasContent(state: PeerState): boolean {
  return (
    Object.keys(state.events).length > 0 ||
    state.bundles.length > 0 ||
    state.legacyBundles.length > 0
  );
}

/**
 * Bundle ids name one child of the managed parent and nothing else. Any peer
 * on the synced tree writes this file, so a name that could resolve outside
 * that parent is dropped on read rather than turned into a delete target.
 */
function bundleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is string =>
      typeof id === 'string' &&
      id.length > 0 &&
      id !== '.' &&
      id !== '..' &&
      !id.includes('/') &&
      !id.includes('\\') &&
      !id.includes('\0')
  );
}

/**
 * Strict field-by-field reconstruction: only the schema this code writes may
 * serve as deletion evidence, so a foreign version and a corrupt file both
 * load empty — no evidence, no authority — and neither aborts the run.
 */
function loadStateFile(filePath: string): PeerState {
  const state = emptyPeerState();
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return state;
    record = parsed as Record<string, unknown>;
  } catch {
    return state;
  }
  if (record.version !== 1) return state;
  if (record.events && typeof record.events === 'object' && !Array.isArray(record.events)) {
    for (const [event, groups] of Object.entries(record.events as Record<string, unknown>)) {
      if (Array.isArray(groups) && groups.length > 0) state.events[event] = groups;
    }
  }
  state.bundles = bundleIds(record.bundles);
  state.legacyBundles = bundleIds(record.legacyBundles);
  return state;
}

function deviceCopies(asbHome: string, target: HookTarget, projectRoot?: string): string[] {
  const dir = peerStateDir(asbHome);
  const fileName = peerStateFileName(target, projectRoot);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DEVICE_DIR_PATTERN.test(entry.name))
      .map((entry) => path.join(dir, entry.name, fileName))
      .filter((candidate) => {
        try {
          const stat = fs.lstatSync(candidate);
          return stat.isFile() && !stat.isSymbolicLink();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * The shared file plus every device-scoped copy. Group counts add rather than
 * de-duplicate: two machines that each appended the same group left two
 * copies in the app config, and count-bounded removal must reclaim both.
 */
export function loadPeerState(
  asbHome: string,
  target: HookTarget,
  projectRoot?: string
): PeerState {
  const merged = emptyPeerState();
  const sharedPath = peerStatePath(asbHome, target, projectRoot);
  const sources = [
    ...(fs.existsSync(sharedPath) ? [sharedPath] : []),
    ...deviceCopies(asbHome, target, projectRoot),
  ];
  for (const source of sources) {
    const state = loadStateFile(source);
    for (const [event, groups] of Object.entries(state.events)) {
      merged.events[event] = [...(merged.events[event] ?? []), ...groups];
    }
    merged.bundles.push(...state.bundles);
    merged.legacyBundles.push(...state.legacyBundles);
  }
  merged.bundles = [...new Set(merged.bundles)];
  merged.legacyBundles = [...new Set(merged.legacyBundles)];
  return merged;
}

/**
 * Publish the four-key document whole through a sibling temp file, so a peer
 * never opens a partial one and unknown fields do not survive. An empty state
 * deletes the file instead of leaving a shell that still looks like live
 * evidence. Device-scoped copies are consumed on either path, never created.
 */
export function savePeerState(
  asbHome: string,
  target: HookTarget,
  state: PeerState,
  projectRoot?: string
): void {
  const filePath = peerStatePath(asbHome, target, projectRoot);
  if (peerStateHasContent(state)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const document = {
      version: 1,
      events: state.events,
      bundles: state.bundles,
      legacyBundles: state.legacyBundles,
    };
    const temp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
      fs.renameSync(temp, filePath);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  } else {
    fs.rmSync(filePath, { force: true });
  }
  for (const copy of deviceCopies(asbHome, target, projectRoot)) {
    fs.rmSync(copy, { force: true });
    try {
      fs.rmdirSync(path.dirname(copy));
    } catch {
      // The device directory still holds another target's state.
    }
  }
}

/** Hash-bearing ownership of one project file or bundle directory. */
export interface ProjectManifestEntry extends Record<string, unknown> {
  relativePath: string;
  targetId: string;
  hash: string;
  updatedAt: string;
}

/** Key-placement-only MCP proof. `serverKey` is always the on-disk identity. */
export interface ManagedMcpEntry extends Record<string, unknown> {
  relativePath: string;
  targetId: string;
  serverKey: string;
  updatedAt: string;
}

export interface RulesManifestEntry extends Record<string, unknown> {
  relativePath: string;
  mode: 'block' | 'full';
  targetIds: string[];
  hash: string;
  updatedAt: string;
}

export type ProjectLibrarySection = 'skills' | 'commands' | 'agents';

export interface ProjectManifestSections extends Record<string, unknown> {
  skills?: Record<string, ProjectManifestEntry>;
  commands?: Record<string, ProjectManifestEntry>;
  agents?: Record<string, ProjectManifestEntry>;
  mcp?: Record<string, ManagedMcpEntry>;
  rules?: Record<string, RulesManifestEntry>;
}

/**
 * Frozen v1 project peer document. The index signature is intentional: a 0.4
 * or newer peer may add fields this engine does not know, and save must carry
 * those values and their insertion order through unchanged.
 */
export interface ProjectManifest extends Record<string, unknown> {
  version: 1;
  updatedAt: string;
  sections: ProjectManifestSections;
  projectRoot: string;
}

export interface ProjectManifestLoad {
  path: string;
  existed: boolean;
  corrupt: boolean;
  collision: boolean;
  needsSave: boolean;
  manifest: ProjectManifest | null;
  error?: string;
}

export function manifestDeviceId(
  agentsHome = process.env.ASB_AGENTS_HOME?.trim() || os.homedir(),
  device = process.env.ASB_DEVICE_ID?.trim() || os.hostname()
): string {
  return createHash('sha256')
    .update(`${device}\0${path.resolve(agentsHome)}`)
    .digest('hex')
    .slice(0, 16);
}

export function projectManifestSlug(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const home = os.homedir();
  if (resolved === home || resolved.startsWith(`${home}${path.sep}`)) {
    return path.relative(home, resolved).replace(/\//g, '--');
  }
  const stripped = resolved.startsWith('/') ? resolved.slice(1) : resolved;
  return `_abs--${stripped.replace(/\//g, '--')}`;
}

export function projectManifestPath(asbHome: string, projectRoot: string): string {
  return path.join(
    asbHome,
    'state',
    'manifests',
    manifestDeviceId(),
    `${projectManifestSlug(projectRoot)}.json`
  );
}

const KEY_SEPARATOR = '::';

function projectManifestKey(id: string, targetId: string): string {
  return `${id}${KEY_SEPARATOR}${targetId}`;
}

export function projectManifestKeyParts(key: string): { id: string; targetId: string } {
  const separator = key.indexOf(KEY_SEPARATOR);
  if (separator < 0) return { id: key, targetId: '' };
  return {
    id: key.slice(0, separator),
    targetId: key.slice(separator + KEY_SEPARATOR.length),
  };
}

export function recordProjectLibraryEntry(
  manifest: ProjectManifest,
  section: ProjectLibrarySection,
  componentId: string,
  entry: ProjectManifestEntry
): void {
  const entries = manifest.sections[section] ?? {};
  for (const [key, owned] of Object.entries(entries)) {
    if (
      projectManifestKeyParts(key).id === componentId &&
      owned.relativePath === entry.relativePath
    ) {
      owned.hash = entry.hash;
      owned.updatedAt = entry.updatedAt;
    }
  }
  const key = projectManifestKey(componentId, entry.targetId);
  entries[key] = { ...(entries[key] ?? {}), ...entry };
  manifest.sections[section] = entries;
}

export function removeProjectLibraryEntry(
  manifest: ProjectManifest,
  section: ProjectLibrarySection,
  componentId: string,
  targetId?: string
): void {
  const entries = manifest.sections[section];
  if (!entries) return;
  if (targetId) {
    delete entries[projectManifestKey(componentId, targetId)];
    return;
  }
  for (const key of Object.keys(entries)) {
    if (projectManifestKeyParts(key).id === componentId) delete entries[key];
  }
}

export function getProjectLibraryEntry(
  manifest: ProjectManifest,
  section: ProjectLibrarySection,
  componentId: string,
  targetId?: string
): ProjectManifestEntry | undefined {
  const entries = manifest.sections[section];
  if (!entries) return undefined;
  if (targetId) return entries[projectManifestKey(componentId, targetId)];
  for (const [key, entry] of Object.entries(entries)) {
    if (projectManifestKeyParts(key).id === componentId) return entry;
  }
  return undefined;
}

export interface ProjectManifestCleanupItem {
  id: string;
  entry: ProjectManifestEntry;
}

export function computeProjectLibraryCleanupSet(
  manifest: ProjectManifest,
  section: ProjectLibrarySection,
  currentDesiredIds: ReadonlySet<string>,
  targetId?: string
): ProjectManifestCleanupItem[] {
  const entries = manifest.sections[section];
  if (!entries) return [];
  const stale: ProjectManifestCleanupItem[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (targetId && entry.targetId !== targetId) continue;
    const { id } = projectManifestKeyParts(key);
    if (!currentDesiredIds.has(id)) stale.push({ id, entry });
  }
  return stale;
}

export function recordManagedMcpEntry(
  manifest: ProjectManifest,
  serverName: string,
  entry: ManagedMcpEntry
): string {
  const entries = manifest.sections.mcp ?? {};
  const key = projectManifestKey(serverName, entry.targetId);
  entries[key] = { ...(entries[key] ?? {}), ...entry };
  manifest.sections.mcp = entries;
  return key;
}

export function removeManagedMcpEntry(manifest: ProjectManifest, compositeKey: string): void {
  if (manifest.sections.mcp) delete manifest.sections.mcp[compositeKey];
}

export function computeProjectMcpCleanupSet(
  manifest: ProjectManifest,
  currentDesiredNames: ReadonlySet<string>,
  targetId?: string
): string[] {
  const entries = manifest.sections.mcp;
  if (!entries) return [];
  const stale: string[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (targetId && entry.targetId !== targetId) continue;
    if (!currentDesiredNames.has(projectManifestKeyParts(key).id)) stale.push(key);
  }
  return stale;
}

export function ownedManagedMcpServers(manifest: ProjectManifest, targetId: string): Set<string> {
  const owned = new Set<string>();
  for (const [key, entry] of Object.entries(manifest.sections.mcp ?? {})) {
    if (entry.targetId === targetId) owned.add(projectManifestKeyParts(key).id);
  }
  return owned;
}

export function recordProjectRulesEntry(
  manifest: ProjectManifest,
  entry: RulesManifestEntry
): void {
  const entries = manifest.sections.rules ?? {};
  entries[entry.relativePath] = { ...(entries[entry.relativePath] ?? {}), ...entry };
  manifest.sections.rules = entries;
}

export function removeProjectRulesEntry(manifest: ProjectManifest, relativePath: string): void {
  if (manifest.sections.rules) delete manifest.sections.rules[relativePath];
}

/**
 * Resolve all roots once and reject the frozen slug's aliases before capture.
 * The returned map is also the project planning identity record.
 */
export function uniqueProjectManifestPaths(
  asbHome: string,
  projectRoots: readonly string[]
): Map<string, string> {
  const rootsByPath = new Map<string, string>();
  const result = new Map<string, string>();
  for (const supplied of projectRoots) {
    const root = fs.realpathSync(path.resolve(supplied));
    const manifestPath = projectManifestPath(asbHome, root);
    const prior = rootsByPath.get(manifestPath);
    if (prior !== undefined && prior !== root) {
      throw new Error(
        `Project manifest path alias: ${prior} and ${root} both map to ${manifestPath}`
      );
    }
    rootsByPath.set(manifestPath, root);
    result.set(root, manifestPath);
  }
  return result;
}

export function emptyProjectManifest(projectRoot: string): ProjectManifest {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sections: {},
    projectRoot: path.resolve(projectRoot),
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateProjectManifest(value: unknown): ProjectManifest {
  if (!plainRecord(value)) throw new Error('manifest root must be an object');
  if (value.version !== 1) throw new Error('version must be 1');
  if (!plainRecord(value.sections)) throw new Error('sections must be an object');
  if (typeof value.updatedAt !== 'string') throw new Error('updatedAt must be a string');
  if (value.projectRoot !== undefined && typeof value.projectRoot !== 'string') {
    throw new Error('projectRoot must be a string when present');
  }
  return value as ProjectManifest;
}

/** Corrupt state returns no manifest and therefore grants no ownership authority. */
export function loadProjectManifest(asbHome: string, projectRoot: string): ProjectManifestLoad {
  const root = path.resolve(projectRoot);
  const filePath = projectManifestPath(asbHome, root);
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      existed: false,
      corrupt: false,
      collision: false,
      needsSave: false,
      manifest: emptyProjectManifest(root),
    };
  }
  try {
    const manifest = validateProjectManifest(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    if (manifest.projectRoot !== undefined && path.resolve(manifest.projectRoot) !== root) {
      return {
        path: filePath,
        existed: true,
        corrupt: false,
        collision: true,
        needsSave: false,
        manifest: null,
        error: `project manifest slug collision: ${path.resolve(manifest.projectRoot)} and ${root} both map to ${filePath}`,
      };
    }
    const needsSave = manifest.projectRoot === undefined;
    manifest.projectRoot = root;
    return {
      path: filePath,
      existed: true,
      corrupt: false,
      collision: false,
      needsSave,
      manifest,
    };
  } catch (error) {
    return {
      path: filePath,
      existed: true,
      corrupt: true,
      collision: false,
      needsSave: false,
      manifest: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Preserve insertion order and unknown fields; publish only complete JSON bytes. */
export function saveProjectManifest(filePath: string, manifest: ProjectManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  manifest.updatedAt = new Date().toISOString();
  const temp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(temp, filePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
