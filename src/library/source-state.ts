import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir, getPluginSourceStateDir } from '../config/paths.js';

export interface SourceRemovalPathState {
  activePath: string;
  stagedPath: string;
}

export interface SourceRemovalState {
  cache?: SourceRemovalPathState;
  checkout?: SourceRemovalPathState;
  subtree?: { repoRoot: string; relativePath: string };
}

export interface PluginSourceState {
  version: 1;
  namespace: string;
  descriptorKey: string;
  marketplacePath: string;
  incarnation: string;
  removal?: SourceRemovalState;
}

function safeSegment(value: string): string {
  return (value.replace(/[^a-zA-Z0-9_-]/g, '-') || 'source').slice(0, 48);
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Plugin source state path escapes its root: ${target}`);
  }
}

function assertNoStateSymlinks(root: string, target: string): void {
  assertInside(root, target);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Plugin source state path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function safeStateRoot(create: boolean): string {
  const trustedRoot = path.resolve(getConfigDir());
  const stateRoot = path.resolve(getPluginSourceStateDir());
  assertInside(trustedRoot, stateRoot);
  let current = trustedRoot;
  for (const segment of path.relative(trustedRoot, stateRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Plugin source state root contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (create) fs.mkdirSync(stateRoot, { recursive: true });
  return stateRoot;
}

function statePath(namespace: string, descriptorKey: string): string {
  const identity = createHash('sha256')
    .update(JSON.stringify([namespace, descriptorKey]))
    .digest('hex');
  return path.join(
    getPluginSourceStateDir(),
    `${safeSegment(namespace)}-${identity.slice(0, 20)}.json`
  );
}

function parseState(value: unknown): PluginSourceState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<PluginSourceState>;
  if (
    state.version !== 1 ||
    typeof state.namespace !== 'string' ||
    state.namespace === '.' ||
    state.namespace === '..' ||
    state.namespace.includes('/') ||
    state.namespace.includes('\\') ||
    typeof state.descriptorKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(state.descriptorKey) ||
    typeof state.marketplacePath !== 'string' ||
    !path.isAbsolute(state.marketplacePath) ||
    typeof state.incarnation !== 'string'
  ) {
    return null;
  }
  if (state.removal !== undefined && !validRemovalState(state.removal)) return null;
  return state as PluginSourceState;
}

function validRemovalPathState(value: unknown): value is SourceRemovalPathState {
  if (!value || typeof value !== 'object') return false;
  const paths = value as Partial<SourceRemovalPathState>;
  return (
    typeof paths.activePath === 'string' &&
    path.isAbsolute(paths.activePath) &&
    typeof paths.stagedPath === 'string' &&
    path.isAbsolute(paths.stagedPath)
  );
}

function validRemovalState(value: unknown): value is SourceRemovalState {
  if (!value || typeof value !== 'object') return false;
  const removal = value as SourceRemovalState;
  if (removal.cache !== undefined && !validRemovalPathState(removal.cache)) return false;
  if (removal.checkout !== undefined && !validRemovalPathState(removal.checkout)) return false;
  if (removal.subtree !== undefined) {
    if (
      typeof removal.subtree.repoRoot !== 'string' ||
      !path.isAbsolute(removal.subtree.repoRoot) ||
      typeof removal.subtree.relativePath !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

function readStateFile(filePath: string): PluginSourceState | null {
  const stateRoot = safeStateRoot(false);
  assertNoStateSymlinks(stateRoot, filePath);
  try {
    return parseState(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeStateFile(filePath: string, state: PluginSourceState): void {
  const stateRoot = safeStateRoot(true);
  assertNoStateSymlinks(stateRoot, filePath);
  const tempPath = path.join(stateRoot, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  assertNoStateSymlinks(stateRoot, tempPath);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function newState(
  namespace: string,
  descriptorKey: string,
  marketplacePath: string
): PluginSourceState {
  return {
    version: 1,
    namespace,
    descriptorKey,
    marketplacePath: path.resolve(marketplacePath),
    incarnation: randomUUID(),
  };
}

export function ensurePluginSourceState(
  namespace: string,
  descriptorKey: string,
  marketplacePath: string
): PluginSourceState {
  const filePath = statePath(namespace, descriptorKey);
  const expectedPath = path.resolve(marketplacePath);
  const existing = readStateFile(filePath);
  if (existing?.marketplacePath === expectedPath) return existing;

  const state = newState(namespace, descriptorKey, expectedPath);
  if (existing) {
    writeStateFile(filePath, state);
    return state;
  }

  const stateRoot = safeStateRoot(true);
  assertNoStateSymlinks(stateRoot, filePath);
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readStateFile(filePath);
    if (!winner) throw new Error(`Plugin source state is unreadable: ${filePath}`);
    return winner.marketplacePath === expectedPath
      ? winner
      : rotatePluginSourceState(namespace, descriptorKey, expectedPath);
  }
}

export function readPluginSourceState(
  namespace: string,
  descriptorKey: string
): PluginSourceState | null {
  return readStateFile(statePath(namespace, descriptorKey));
}

export function rotatePluginSourceState(
  namespace: string,
  descriptorKey: string,
  marketplacePath: string
): PluginSourceState {
  const state = newState(namespace, descriptorKey, marketplacePath);
  writeStateFile(statePath(namespace, descriptorKey), state);
  return state;
}

export function pluginSourceStateIsCurrent(state: PluginSourceState): boolean {
  const current = readStateFile(statePath(state.namespace, state.descriptorKey));
  return (
    current?.incarnation === state.incarnation && current.marketplacePath === state.marketplacePath
  );
}

export function beginPluginSourceRemoval(
  state: PluginSourceState,
  removal: SourceRemovalState
): PluginSourceState {
  if (!pluginSourceStateIsCurrent(state)) {
    throw new Error(`Plugin source "${state.namespace}" changed before removal staging.`);
  }
  const next = { ...state, removal };
  writeStateFile(statePath(state.namespace, state.descriptorKey), next);
  return next;
}

export function clearPluginSourceRemoval(state: PluginSourceState): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.descriptorKey));
  if (current?.incarnation !== state.incarnation) return state;
  const next = { ...current };
  delete next.removal;
  writeStateFile(statePath(state.namespace, state.descriptorKey), next);
  return next;
}

export function deletePluginSourceState(state: PluginSourceState): void {
  const filePath = statePath(state.namespace, state.descriptorKey);
  const current = readStateFile(filePath);
  if (current?.incarnation !== state.incarnation) return;
  fs.rmSync(filePath, { force: true });
}

export function listPendingPluginSourceRemovals(): PluginSourceState[] {
  const stateRoot = safeStateRoot(false);
  if (!fs.existsSync(stateRoot)) return [];
  const records: PluginSourceState[] = [];
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const state = readStateFile(path.join(stateRoot, entry.name));
    if (state?.removal) records.push(state);
  }
  return records;
}
