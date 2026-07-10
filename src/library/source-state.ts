import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir, getPluginSourceStateDir } from '../config/paths.js';

export interface SourceRemovalPathState {
  activePath: string;
  stagedPath: string;
  identity?: SourcePathIdentity;
}

export interface SourcePathIdentity {
  device: string;
  inode: string;
}

export interface SourceCloneAdditionState {
  kind: 'clone';
  purpose: 'add' | 'update';
  configPath: string;
  checkout: SourceRemovalPathState;
  ready: boolean;
  checkoutIdentity?: SourcePathIdentity;
  transactionId: string;
}

export interface SourceSubtreeAdditionState {
  kind: 'subtree';
  purpose: 'add' | 'update';
  configPath: string;
  repoRoot: string;
  prefix: string;
  hadPrefix: boolean;
  stagePath: string;
  stageIdentity: SourcePathIdentity;
  headBefore: string;
  headRef: string | null;
  headAfter?: string;
  treeAfter?: string;
  transactionId: string;
}

export type SourceAdditionState = SourceCloneAdditionState | SourceSubtreeAdditionState;

export interface SourceRemovalState {
  configPath: string;
  cache?: SourceRemovalPathState;
  checkout?: SourceRemovalPathState;
  subtree?: { repoRoot: string; relativePath: string; head: string };
}

export interface SourceCheckoutState {
  path: string;
  owner: string;
  identity: SourcePathIdentity;
}

export interface SourceSubtreeState {
  repoRoot: string;
  relativePath: string;
  tree: string;
}

export interface PluginSourceState {
  version: 1;
  namespace: string;
  descriptorKey: string;
  marketplacePath: string;
  incarnation: string;
  sourceKind?: 'marketplace' | 'plugin';
  checkout?: SourceCheckoutState;
  subtree?: SourceSubtreeState;
  addition?: SourceAdditionState;
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

function statePath(namespace: string): string {
  const identity = createHash('sha256').update(namespace).digest('hex');
  return path.resolve(
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
    typeof state.incarnation !== 'string' ||
    (state.sourceKind !== undefined &&
      state.sourceKind !== 'marketplace' &&
      state.sourceKind !== 'plugin')
  ) {
    return null;
  }
  if (state.addition !== undefined && !validAdditionState(state.addition)) return null;
  if (state.removal !== undefined && !validRemovalState(state.removal)) return null;
  if (state.addition !== undefined && state.removal !== undefined) return null;
  if (state.checkout !== undefined && !validCheckoutState(state.checkout)) return null;
  if (state.subtree !== undefined && !validSubtreeState(state.subtree)) return null;
  if (state.checkout !== undefined && state.subtree !== undefined) return null;
  return state as PluginSourceState;
}

function validPathIdentity(value: unknown): value is SourcePathIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<SourcePathIdentity>;
  return (
    typeof identity.device === 'string' &&
    /^\d+$/.test(identity.device) &&
    typeof identity.inode === 'string' &&
    /^\d+$/.test(identity.inode)
  );
}

function validRemovalPathState(value: unknown): value is SourceRemovalPathState {
  if (!value || typeof value !== 'object') return false;
  const paths = value as Partial<SourceRemovalPathState>;
  return (
    typeof paths.activePath === 'string' &&
    path.isAbsolute(paths.activePath) &&
    typeof paths.stagedPath === 'string' &&
    path.isAbsolute(paths.stagedPath) &&
    (paths.identity === undefined || validPathIdentity(paths.identity))
  );
}

function validRemovalState(value: unknown): value is SourceRemovalState {
  if (!value || typeof value !== 'object') return false;
  const removal = value as SourceRemovalState;
  if (typeof removal.configPath !== 'string' || !path.isAbsolute(removal.configPath)) return false;
  if (removal.cache !== undefined && !validRemovalPathState(removal.cache)) return false;
  if (removal.checkout !== undefined && !validRemovalPathState(removal.checkout)) return false;
  if (removal.subtree !== undefined) {
    if (
      typeof removal.subtree.repoRoot !== 'string' ||
      !path.isAbsolute(removal.subtree.repoRoot) ||
      typeof removal.subtree.relativePath !== 'string' ||
      typeof removal.subtree.head !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(removal.subtree.head)
    ) {
      return false;
    }
  }
  return true;
}

function validCheckoutState(value: unknown): value is SourceCheckoutState {
  if (!value || typeof value !== 'object') return false;
  const checkout = value as Partial<SourceCheckoutState>;
  return (
    typeof checkout.path === 'string' &&
    path.isAbsolute(checkout.path) &&
    typeof checkout.owner === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      checkout.owner
    ) &&
    validPathIdentity(checkout.identity)
  );
}

function validSubtreeState(value: unknown): value is SourceSubtreeState {
  if (!value || typeof value !== 'object') return false;
  const subtree = value as Partial<SourceSubtreeState>;
  return (
    typeof subtree.repoRoot === 'string' &&
    path.isAbsolute(subtree.repoRoot) &&
    typeof subtree.relativePath === 'string' &&
    typeof subtree.tree === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(subtree.tree)
  );
}

function validAdditionState(value: unknown): value is SourceAdditionState {
  if (!value || typeof value !== 'object') return false;
  const addition = value as Partial<SourceAdditionState>;
  if (
    typeof addition.configPath !== 'string' ||
    !path.isAbsolute(addition.configPath) ||
    (addition.purpose !== 'add' && addition.purpose !== 'update') ||
    typeof addition.transactionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      addition.transactionId
    )
  ) {
    return false;
  }
  if (addition.kind === 'clone') {
    const clone = addition as Partial<SourceCloneAdditionState>;
    return (
      validRemovalPathState(clone.checkout) &&
      typeof clone.ready === 'boolean' &&
      (clone.checkoutIdentity === undefined || validPathIdentity(clone.checkoutIdentity)) &&
      (!clone.ready || clone.checkoutIdentity !== undefined)
    );
  }
  if (addition.kind !== 'subtree') return false;
  const subtree = addition as Partial<SourceSubtreeAdditionState>;
  return (
    typeof subtree.repoRoot === 'string' &&
    path.isAbsolute(subtree.repoRoot) &&
    typeof subtree.prefix === 'string' &&
    typeof subtree.hadPrefix === 'boolean' &&
    typeof subtree.stagePath === 'string' &&
    path.isAbsolute(subtree.stagePath) &&
    validPathIdentity(subtree.stageIdentity) &&
    typeof subtree.headBefore === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(subtree.headBefore) &&
    (subtree.headRef === null || typeof subtree.headRef === 'string') &&
    (subtree.headAfter === undefined ||
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(subtree.headAfter)) &&
    (subtree.treeAfter === undefined ||
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(subtree.treeAfter)) &&
    (subtree.headAfter === undefined) === (subtree.treeAfter === undefined)
  );
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
  const filePath = statePath(namespace);
  const expectedPath = path.resolve(marketplacePath);
  const existing = readStateFile(filePath);
  if (existing) return existing;

  const state = newState(namespace, descriptorKey, expectedPath);
  const stateRoot = safeStateRoot(true);
  assertNoStateSymlinks(stateRoot, filePath);
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readStateFile(filePath);
    if (!winner) throw new Error(`Plugin source state is unreadable: ${filePath}`);
    return winner;
  }
}

export function readPluginSourceState(namespace: string): PluginSourceState | null {
  return readStateFile(statePath(namespace));
}

export function rotatePluginSourceState(
  namespace: string,
  descriptorKey: string,
  marketplacePath: string
): PluginSourceState {
  const existing = readStateFile(statePath(namespace));
  if (existing?.addition || existing?.removal) {
    throw new Error(`Plugin source "${namespace}" has a pending lifecycle transaction.`);
  }
  if (existing) {
    throw new Error(`Plugin source "${namespace}" must retire its current owner before rotation.`);
  }
  const state = newState(namespace, descriptorKey, marketplacePath);
  writeStateFile(statePath(namespace), state);
  return state;
}

export function pluginSourceStateIsCurrent(state: PluginSourceState): boolean {
  const current = readStateFile(statePath(state.namespace));
  return (
    current?.incarnation === state.incarnation && current.marketplacePath === state.marketplacePath
  );
}

export function beginPluginSourceAddition(
  state: PluginSourceState,
  addition: SourceAdditionState
): PluginSourceState {
  if (!pluginSourceStateIsCurrent(state)) {
    throw new Error(`Plugin source "${state.namespace}" changed before addition staging.`);
  }
  if (state.removal) {
    throw new Error(`Plugin source "${state.namespace}" has a pending removal.`);
  }
  const next = { ...state, addition };
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function updatePluginSourceAddition(
  state: PluginSourceState,
  addition: SourceAdditionState
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace));
  if (current?.incarnation !== state.incarnation || !current.addition) {
    throw new Error(`Plugin source "${state.namespace}" changed during addition.`);
  }
  const next = { ...current, addition };
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function clearPluginSourceAddition(state: PluginSourceState): PluginSourceState {
  const current = readStateFile(statePath(state.namespace));
  if (current?.incarnation !== state.incarnation) return state;
  const next = { ...current };
  delete next.addition;
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function completePluginSourceAddition(
  state: PluginSourceState,
  ownership: { checkout: SourceCheckoutState } | { subtree: SourceSubtreeState }
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace));
  if (current?.incarnation !== state.incarnation || !current.addition) {
    throw new Error(`Plugin source "${state.namespace}" changed during addition completion.`);
  }
  const next = { ...current };
  delete next.addition;
  if ('checkout' in ownership) {
    next.checkout = ownership.checkout;
    delete next.subtree;
  } else {
    next.subtree = ownership.subtree;
    delete next.checkout;
  }
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function setPluginSourceSubtree(
  state: PluginSourceState,
  subtree: SourceSubtreeState
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace));
  if (current?.incarnation !== state.incarnation) {
    throw new Error(`Plugin source "${state.namespace}" changed during subtree update.`);
  }
  const next = { ...current, subtree };
  delete next.checkout;
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function setPluginSourceCheckout(
  state: PluginSourceState,
  checkout: SourceCheckoutState
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace));
  if (current?.incarnation !== state.incarnation) {
    throw new Error(`Plugin source "${state.namespace}" changed during checkout adoption.`);
  }
  const next = { ...current, checkout };
  delete next.subtree;
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function setPluginSourceKind(
  state: PluginSourceState,
  sourceKind: 'marketplace' | 'plugin'
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace));
  if (current?.incarnation !== state.incarnation) return state;
  if (current.sourceKind === sourceKind) return current;
  const next = { ...current, sourceKind };
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function beginPluginSourceRemoval(
  state: PluginSourceState,
  removal: SourceRemovalState
): PluginSourceState {
  if (!pluginSourceStateIsCurrent(state)) {
    throw new Error(`Plugin source "${state.namespace}" changed before removal staging.`);
  }
  if (state.addition) {
    throw new Error(`Plugin source "${state.namespace}" has a pending addition.`);
  }
  const next = { ...state, removal };
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function clearPluginSourceRemoval(state: PluginSourceState): PluginSourceState {
  const current = readStateFile(statePath(state.namespace));
  if (current?.incarnation !== state.incarnation) return state;
  const next = { ...current };
  delete next.removal;
  writeStateFile(statePath(state.namespace), next);
  return next;
}

export function deletePluginSourceState(state: PluginSourceState): void {
  const filePath = statePath(state.namespace);
  const current = readStateFile(filePath);
  if (current?.incarnation !== state.incarnation) return;
  fs.rmSync(filePath, { force: true });
}

function listPluginSourceStates(): PluginSourceState[] {
  const stateRoot = safeStateRoot(false);
  if (!fs.existsSync(stateRoot)) return [];
  const records: PluginSourceState[] = [];
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const state = readStateFile(path.join(stateRoot, entry.name));
    if (state) records.push(state);
  }
  return records;
}

export function listPendingPluginSourceTransactions(): PluginSourceState[] {
  return listPluginSourceStates().filter((state) => state.addition || state.removal);
}
