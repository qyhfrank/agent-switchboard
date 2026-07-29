import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LedgerEntry } from './ledger.js';
import { bundleFingerprint, listTargetFiles } from './shapes.js';

/**
 * Hook ownership state: a peer contract, not private engine state. A 0.4.35
 * asb on another machine reads and writes the same
 * `<ASB_HOME>/state/hooks/<target>.json`, so every byte, key order and file
 * lifecycle here is frozen 0.4.35 behavior — the file lives beside the
 * library, not in the machine-local state home the ledger uses. Hook groups
 * carry no ledger entry: this record is their only ownership evidence.
 */

export type HookTarget = 'claude-code' | 'codex';

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

export function peerStatePath(asbHome: string, target: HookTarget): string {
  return path.join(peerStateDir(asbHome), `${target}.json`);
}

export function emptyPeerState(): PeerState {
  return { version: 1, events: {}, bundles: [], legacyBundles: [] };
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

function deviceCopies(asbHome: string, target: HookTarget): string[] {
  const dir = peerStateDir(asbHome);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DEVICE_DIR_PATTERN.test(entry.name))
      .map((entry) => path.join(dir, entry.name, `${target}.json`))
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
export function loadPeerState(asbHome: string, target: HookTarget): PeerState {
  const merged = emptyPeerState();
  const sharedPath = peerStatePath(asbHome, target);
  const sources = [
    ...(fs.existsSync(sharedPath) ? [sharedPath] : []),
    ...deviceCopies(asbHome, target),
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
export function savePeerState(asbHome: string, target: HookTarget, state: PeerState): void {
  const filePath = peerStatePath(asbHome, target);
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
  for (const copy of deviceCopies(asbHome, target)) {
    fs.rmSync(copy, { force: true });
    try {
      fs.rmdirSync(path.dirname(copy));
    } catch {
      // The device directory still holds another target's state.
    }
  }
}

/** Hash-bearing ownership of one project file. Unknown peer fields survive save. */
export interface ProjectManifestFileEntry extends Record<string, unknown> {
  appId: string;
  targetId: string;
  relativePath: string;
  hash: string;
  type: string;
  id: string | null;
  shape?: 'own-file' | 'region';
}

/** Hash-bearing ownership of one project bundle directory. */
export interface ProjectManifestBundleEntry extends Record<string, unknown> {
  appId: string;
  type: string;
  name: string;
  relativePath: string;
  hash: string;
  files?: string[];
}

/** Key-placement-only MCP proof. `serverKey` is always the on-disk identity. */
export interface ManagedMcpEntry extends Record<string, unknown> {
  appId: string;
  relativePath: string;
  targetId: string;
  serverKey: string;
  updatedAt?: string;
}

/**
 * Frozen v1 project peer document. The index signature is intentional: a 0.4
 * or newer peer may add fields this engine does not know, and save must carry
 * those values and their insertion order through unchanged.
 */
export interface ProjectManifest extends Record<string, unknown> {
  version: 1;
  projectRoot: string;
  files: Record<string, ProjectManifestFileEntry>;
  bundles: Record<string, ProjectManifestBundleEntry>;
  mcp: Record<string, ManagedMcpEntry>;
}

export interface ProjectManifestLoad {
  path: string;
  existed: boolean;
  corrupt: boolean;
  manifest: ProjectManifest | null;
  error?: string;
}

/** Frozen device identity: no separators are inserted between the three values. */
export function manifestDeviceId(
  hostname = os.hostname(),
  platform = os.platform(),
  arch = os.arch()
): string {
  return createHash('sha256').update(`${hostname}${platform}${arch}`).digest('hex').slice(0, 12);
}

/** Frozen flat filename transform. Composite keys and slugs are never parsed back. */
export function projectManifestSlug(projectRoot: string): string {
  return path.resolve(projectRoot).replace(/[\\/]/g, '--');
}

export function projectManifestPath(asbHome: string, projectRoot: string): string {
  return path.join(asbHome, 'manifests', `${projectManifestSlug(projectRoot)}.json`);
}

export function manifestFileKey(appId: string, targetId: string): string {
  return `${appId}::${targetId}`;
}

export function manifestBundleKey(appId: string, type: string, name: string): string {
  return `${appId}::${type}::${name}`;
}

export function manifestMcpKey(appId: string, serverKey: string): string {
  return `${appId}::${serverKey}`;
}

export function recordManagedMcpEntry(manifest: ProjectManifest, entry: ManagedMcpEntry): string {
  const key = manifestMcpKey(entry.appId, entry.serverKey);
  manifest.mcp[key] = entry;
  return key;
}

export function removeManagedMcpEntry(manifest: ProjectManifest, opaqueKey: string): void {
  delete manifest.mcp[opaqueKey];
}

export function managedMcpCleanupKeys(
  manifest: ProjectManifest,
  appId: string,
  desiredServerKeys: ReadonlySet<string>
): string[] {
  const stale: string[] = [];
  for (const [opaqueKey, entry] of Object.entries(manifest.mcp)) {
    if (entry.appId === appId && !desiredServerKeys.has(entry.serverKey)) stale.push(opaqueKey);
  }
  return stale;
}

export function ownedManagedMcpServers(manifest: ProjectManifest, appId: string): Set<string> {
  const owned = new Set<string>();
  for (const entry of Object.values(manifest.mcp)) {
    if (entry.appId === appId) owned.add(entry.serverKey);
  }
  return owned;
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
    projectRoot: path.resolve(projectRoot),
    files: {},
    bundles: {},
    mcp: {},
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(
  entry: Record<string, unknown>,
  field: string,
  location: string,
  optional = false
): string | undefined {
  const value = entry[field];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new Error(`${location}.${field} must be a string`);
  return value;
}

function validateManifestMap(
  value: unknown,
  name: 'files' | 'bundles' | 'mcp'
): Record<string, Record<string, unknown>> {
  if (!plainRecord(value)) throw new Error(`${name} must be an object`);
  for (const [key, candidate] of Object.entries(value)) {
    const location = `${name}[${JSON.stringify(key)}]`;
    if (!plainRecord(candidate)) throw new Error(`${location} must be an object`);
    stringField(candidate, 'appId', location);
    stringField(candidate, 'relativePath', location);
    if (name === 'files') {
      stringField(candidate, 'targetId', location);
      stringField(candidate, 'hash', location);
      stringField(candidate, 'type', location);
      if (candidate.id !== null) stringField(candidate, 'id', location);
      if (
        candidate.shape !== undefined &&
        candidate.shape !== 'own-file' &&
        candidate.shape !== 'region'
      ) {
        throw new Error(`${location}.shape must be own-file or region`);
      }
    } else if (name === 'bundles') {
      stringField(candidate, 'type', location);
      stringField(candidate, 'name', location);
      stringField(candidate, 'hash', location);
      if (
        candidate.files !== undefined &&
        (!Array.isArray(candidate.files) ||
          !candidate.files.every((relative) => typeof relative === 'string'))
      ) {
        throw new Error(`${location}.files must be a string array`);
      }
    } else {
      stringField(candidate, 'targetId', location);
      stringField(candidate, 'serverKey', location);
      stringField(candidate, 'updatedAt', location, true);
    }
  }
  return value as Record<string, Record<string, unknown>>;
}

function validateProjectManifest(value: unknown, projectRoot: string): ProjectManifest {
  if (!plainRecord(value)) throw new Error('manifest root must be an object');
  if (value.version !== 1) throw new Error('version must be 1');
  if (typeof value.projectRoot !== 'string') throw new Error('projectRoot must be a string');
  const resolved = path.resolve(projectRoot);
  if (path.resolve(value.projectRoot) !== resolved) {
    throw new Error(`projectRoot must resolve to ${resolved}`);
  }
  validateManifestMap(value.files, 'files');
  validateManifestMap(value.bundles, 'bundles');
  validateManifestMap(value.mcp, 'mcp');
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
      manifest: emptyProjectManifest(root),
    };
  }
  try {
    const manifest = validateProjectManifest(JSON.parse(fs.readFileSync(filePath, 'utf-8')), root);
    return { path: filePath, existed: true, corrupt: false, manifest };
  } catch (error) {
    return {
      path: filePath,
      existed: true,
      corrupt: true,
      manifest: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Preserve insertion order and unknown fields; publish only complete JSON bytes. */
export function saveProjectManifest(filePath: string, manifest: ProjectManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
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

function projectRelative(projectRoot: string, absolutePath: string): string | null {
  const relative = path.relative(projectRoot, absolutePath);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  ) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

/** Project hook ownership rides inside the app's manifest file entry. */
export function projectHookState(manifest: ProjectManifest, appId: string): PeerState {
  const entry = manifest.files[manifestFileKey(appId, 'hooks')];
  if (!entry) return emptyPeerState();
  return {
    version: 1,
    events:
      plainRecord(entry.events) &&
      Object.values(entry.events).every((groups) => Array.isArray(groups))
        ? (entry.events as Record<string, unknown[]>)
        : {},
    bundles: bundleIds(entry.bundles),
    legacyBundles: bundleIds(entry.legacyBundles),
  };
}

/** Mutate the in-memory manifest only after the hook config action succeeds. */
export function recordProjectHookState(
  manifest: ProjectManifest,
  projectRoot: string,
  appId: string,
  configPath: string,
  bundleDir: string,
  state: PeerState,
  hash: string,
  preserveBundles: readonly string[] = []
): void {
  const key = manifestFileKey(appId, 'hooks');
  if (!peerStateHasContent(state)) {
    delete manifest.files[key];
    for (const [bundleKey, entry] of Object.entries(manifest.bundles)) {
      if (entry.appId === appId && entry.type === 'hooks') delete manifest.bundles[bundleKey];
    }
    return;
  }
  const relativePath = projectRelative(path.resolve(projectRoot), path.resolve(configPath));
  if (relativePath === null) throw new Error(`${configPath} is outside ${projectRoot}`);
  manifest.files[key] = {
    ...(manifest.files[key] ?? {}),
    appId,
    targetId: 'hooks',
    type: 'hooks',
    id: null,
    relativePath,
    shape: 'own-file',
    hash,
    events: state.events,
    bundles: state.bundles,
    legacyBundles: state.legacyBundles,
  };
  const active = new Set(state.bundles);
  for (const [bundleKey, entry] of Object.entries(manifest.bundles)) {
    if (entry.appId === appId && entry.type === 'hooks' && !active.has(entry.name)) {
      delete manifest.bundles[bundleKey];
    }
  }
  const preserved = new Set(preserveBundles);
  for (const name of state.bundles) {
    const bundleKey = manifestBundleKey(appId, 'hooks', name);
    if (preserved.has(name)) continue;
    const bundlePath = path.join(bundleDir, name);
    const relativePath = projectRelative(path.resolve(projectRoot), path.resolve(bundlePath));
    const fingerprint = bundleFingerprint(bundlePath);
    const files = listTargetFiles(bundlePath);
    if (relativePath === null || fingerprint === undefined || files === null) {
      throw new Error(`${bundlePath} is outside the project or cannot be proven`);
    }
    manifest.bundles[bundleKey] = {
      ...(manifest.bundles[bundleKey] ?? {}),
      appId,
      type: 'hooks',
      name,
      relativePath,
      hash: fingerprint,
      files: files.map((file) => file.rel),
    };
  }
}

/** Peer hash records join the planner as proof rank 4. MCP stays hash-less. */
export function projectManifestLedgerEntries(
  manifest: ProjectManifest,
  projectRoot: string
): LedgerEntry[] {
  const root = path.resolve(projectRoot);
  const entries: LedgerEntry[] = [];
  for (const entry of Object.values(manifest.files)) {
    const targetPath = path.resolve(root, entry.relativePath);
    if (projectRelative(root, targetPath) === null) continue;
    entries.push({
      app: entry.appId,
      type: entry.type,
      id: entry.id,
      path: targetPath,
      shape: entry.shape ?? 'own-file',
      hash: entry.hash,
      provenance: 'peer-record',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    });
  }
  for (const entry of Object.values(manifest.bundles)) {
    const targetPath = path.resolve(root, entry.relativePath);
    if (projectRelative(root, targetPath) === null) continue;
    entries.push({
      app: entry.appId,
      type: entry.type,
      id: entry.name,
      path: targetPath,
      shape: 'own-dir',
      hash: entry.hash,
      ...(entry.files ? { files: [...entry.files] } : {}),
      provenance: 'peer-record',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    });
  }
  return entries;
}

function manifestTargetId(entry: LedgerEntry, relativePath: string): string {
  return entry.id === null ? entry.type : `${entry.type}:${entry.id}:${relativePath}`;
}

/**
 * Checkpoint surviving project ledger proofs into the peer document. Unknown
 * fields on retained entries survive, while retired proofs disappear only
 * after their apply pass succeeded.
 */
export function checkpointProjectManifest(
  manifest: ProjectManifest,
  projectRoot: string,
  ledgerEntries: readonly LedgerEntry[]
): void {
  const root = path.resolve(projectRoot);
  const files: ProjectManifest['files'] = Object.fromEntries(
    Object.entries(manifest.files).filter(([, entry]) => entry.type === 'hooks')
  );
  const bundles: ProjectManifest['bundles'] = Object.fromEntries(
    Object.entries(manifest.bundles).filter(([, entry]) => entry.type === 'hooks')
  );
  const mcp: ProjectManifest['mcp'] = {};
  for (const entry of ledgerEntries) {
    const relativePath = projectRelative(root, entry.path);
    if (relativePath === null) continue;
    if (entry.shape === 'own-file' || entry.shape === 'region') {
      const targetId = manifestTargetId(entry, relativePath);
      const key = manifestFileKey(entry.app, targetId);
      files[key] = {
        ...(manifest.files[key] ?? {}),
        appId: entry.app,
        targetId,
        type: entry.type,
        id: entry.id,
        relativePath,
        shape: entry.shape,
        hash: entry.hash,
        updatedAt: entry.updatedAt,
      } as ProjectManifestFileEntry;
    } else if (entry.shape === 'own-dir' && entry.id !== null) {
      const key = manifestBundleKey(entry.app, entry.type, entry.id);
      bundles[key] = {
        ...(manifest.bundles[key] ?? {}),
        appId: entry.app,
        type: entry.type,
        name: entry.id,
        relativePath,
        hash: entry.hash,
        ...(entry.files ? { files: [...entry.files] } : {}),
        updatedAt: entry.updatedAt,
      } as ProjectManifestBundleEntry;
    } else if (entry.shape === 'keys' && entry.type === 'mcp' && entry.serverKey) {
      const key = manifestMcpKey(entry.app, entry.serverKey);
      mcp[key] = {
        ...(manifest.mcp[key] ?? {}),
        appId: entry.app,
        relativePath,
        targetId:
          typeof manifest.mcp[key]?.targetId === 'string' ? manifest.mcp[key].targetId : entry.app,
        serverKey: entry.serverKey,
        updatedAt: entry.updatedAt,
      } as ManagedMcpEntry;
    }
  }
  manifest.files = files;
  manifest.bundles = bundles;
  manifest.mcp = mcp;
}
