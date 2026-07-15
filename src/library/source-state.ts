import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, getConfigDir, getPluginSourceStateDir } from '../config/paths.js';
import { type SourceValue, sourceValueSchema } from '../config/schemas.js';
import { credentialFreeGitUrl, normalizeGitIdentity } from '../marketplace/git-identity.js';
import { normalizeMarketplaceGitRef } from '../marketplace/git-ref.js';

export interface SourceRemovalPathState {
  activePath: string;
  stagedPath: string;
  identity?: SourcePathIdentity;
  preserve?: boolean;
}

export interface SourcePathIdentity {
  device: string;
  inode: string;
}

export interface SourceCloneAdditionState {
  kind: 'clone';
  purpose: 'add' | 'update';
  configPath: string;
  configPaths: string[];
  checkout: SourceRemovalPathState;
  phase: 'constructing' | 'validated';
  checkoutIdentity?: SourcePathIdentity;
  managedRef?: string;
  transactionId: string;
}

export interface SourceSubtreeAdditionState {
  kind: 'subtree';
  purpose: 'add' | 'update';
  configPath: string;
  configPaths: string[];
  repoRoot: string;
  prefix: string;
  hadPrefix: boolean;
  stagePath: string;
  stageIdentity: SourcePathIdentity;
  headBefore: string;
  headRef: string | null;
  headAfter?: string;
  treeAfter?: string;
  managedRef?: string;
  phase: 'constructing' | 'validated';
  transactionId: string;
}

export type SourceAdditionState = SourceCloneAdditionState | SourceSubtreeAdditionState;

export interface SourceRemovalState {
  configPath: string;
  configPaths: string[];
  cache?: SourceRemovalPathState;
  checkout?: SourceRemovalPathState;
  subtree?: { repoRoot: string; relativePath: string; head: string };
}

export interface SourceCheckoutState {
  path: string;
  owner: string;
  identity: SourcePathIdentity;
  managedRef?: string;
}

export interface SourceSubtreeState {
  repoRoot: string;
  relativePath: string;
  tree: string;
  managedRef?: string;
}

export interface PluginSourceState {
  version: 1;
  namespace: string;
  configPath: string;
  descriptor: SourceValue | null;
  descriptorKey: string;
  gitOwnerKey?: string;
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

function statePath(namespace: string, configPath: string): string {
  const identity = createHash('sha256')
    .update(`${namespace}\0${path.resolve(configPath)}`)
    .digest('hex');
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
    typeof state.configPath !== 'string' ||
    !path.isAbsolute(state.configPath) ||
    (state.descriptor !== null && !sourceValueSchema.safeParse(state.descriptor).success) ||
    typeof state.descriptorKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(state.descriptorKey) ||
    (state.gitOwnerKey !== undefined && !/^[0-9a-f]{64}$/.test(state.gitOwnerKey)) ||
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
    (paths.identity === undefined || validPathIdentity(paths.identity)) &&
    (paths.preserve === undefined || typeof paths.preserve === 'boolean')
  );
}

function validConfigPaths(configPath: unknown, configPaths: unknown): configPaths is string[] {
  return (
    typeof configPath === 'string' &&
    path.isAbsolute(configPath) &&
    Array.isArray(configPaths) &&
    configPaths.length > 0 &&
    configPaths.every((candidate) => typeof candidate === 'string' && path.isAbsolute(candidate)) &&
    configPaths.includes(configPath)
  );
}

function validRemovalState(value: unknown): value is SourceRemovalState {
  if (!value || typeof value !== 'object') return false;
  const removal = value as SourceRemovalState;
  if (!validConfigPaths(removal.configPath, removal.configPaths)) return false;
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
    (checkout.managedRef === undefined || validManagedRef(checkout.managedRef)) &&
    validPathIdentity(checkout.identity)
  );
}

function validManagedRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === 'HEAD') return true;
  if (!value.startsWith('refs/')) return false;
  try {
    return normalizeMarketplaceGitRef(value) === value;
  } catch {
    return false;
  }
}

function validSubtreeState(value: unknown): value is SourceSubtreeState {
  if (!value || typeof value !== 'object') return false;
  const subtree = value as Partial<SourceSubtreeState>;
  return (
    typeof subtree.repoRoot === 'string' &&
    path.isAbsolute(subtree.repoRoot) &&
    typeof subtree.relativePath === 'string' &&
    typeof subtree.tree === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(subtree.tree) &&
    (subtree.managedRef === undefined || validManagedRef(subtree.managedRef))
  );
}

function validAdditionState(value: unknown): value is SourceAdditionState {
  if (!value || typeof value !== 'object') return false;
  const addition = value as Partial<SourceAdditionState>;
  if (
    !validConfigPaths(addition.configPath, addition.configPaths) ||
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
      (clone.phase === 'constructing' || clone.phase === 'validated') &&
      (clone.checkoutIdentity === undefined || validPathIdentity(clone.checkoutIdentity)) &&
      (clone.managedRef === undefined || validManagedRef(clone.managedRef)) &&
      (clone.phase !== 'validated' || clone.checkoutIdentity !== undefined)
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
    (subtree.managedRef === undefined || validManagedRef(subtree.managedRef)) &&
    (subtree.headAfter === undefined) === (subtree.treeAfter === undefined) &&
    (subtree.phase === 'constructing' || subtree.phase === 'validated') &&
    (subtree.phase !== 'validated' || subtree.headAfter !== undefined)
  );
}

function readStateFile(filePath: string): PluginSourceState | null {
  const stateRoot = safeStateRoot(false);
  assertNoStateSymlinks(stateRoot, filePath);
  try {
    const state = parseState(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    if (state && path.resolve(filePath) !== statePath(state.namespace, state.configPath)) {
      throw new Error(`Plugin source state carrier does not match its config owner: ${filePath}`);
    }
    if (state) fs.chmodSync(filePath, 0o600);
    return state;
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
    fs.writeFileSync(tempPath, `${JSON.stringify(sanitizeState(state), null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function sanitizeDescriptor(descriptor: SourceValue | null): SourceValue | null {
  return descriptor && typeof descriptor !== 'string'
    ? { ...descriptor, url: credentialFreeGitUrl(descriptor.url) }
    : descriptor;
}

function sanitizeState(state: PluginSourceState): PluginSourceState {
  return { ...state, descriptor: sanitizeDescriptor(state.descriptor) };
}

function newState(
  namespace: string,
  configPath: string,
  descriptor: SourceValue | null,
  descriptorKey: string,
  marketplacePath: string
): PluginSourceState {
  const gitOwnerKey =
    descriptor && typeof descriptor !== 'string'
      ? createHash('sha256')
          .update(normalizeGitIdentity(expandHome(descriptor.url), process.cwd()))
          .digest('hex')
      : undefined;
  return {
    version: 1,
    namespace,
    configPath: path.resolve(configPath),
    descriptor: sanitizeDescriptor(descriptor),
    descriptorKey,
    ...(gitOwnerKey ? { gitOwnerKey } : {}),
    marketplacePath: path.resolve(marketplacePath),
    incarnation: randomUUID(),
  };
}

export function ensurePluginSourceState(
  namespace: string,
  configPath: string,
  descriptor: SourceValue | null,
  descriptorKey: string,
  marketplacePath: string
): PluginSourceState {
  const filePath = statePath(namespace, configPath);
  const expectedPath = path.resolve(marketplacePath);
  const existing = readStateFile(filePath);
  if (existing) return existing;

  const state = newState(namespace, configPath, descriptor, descriptorKey, expectedPath);
  const stateRoot = safeStateRoot(true);
  assertNoStateSymlinks(stateRoot, filePath);
  const tempPath = path.join(stateRoot, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  assertNoStateSymlinks(stateRoot, tempPath);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(sanitizeState(state), null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      fs.linkSync(tempPath, filePath);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = readStateFile(filePath);
      if (!winner) throw new Error(`Plugin source state is unreadable: ${filePath}`);
      return winner;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function readPluginSourceState(
  namespace: string,
  configPath: string
): PluginSourceState | null {
  return readStateFile(statePath(namespace, configPath));
}

export function rotatePluginSourceState(
  namespace: string,
  configPath: string,
  descriptor: SourceValue | null,
  descriptorKey: string,
  marketplacePath: string
): PluginSourceState {
  const existing = readStateFile(statePath(namespace, configPath));
  if (existing?.addition || existing?.removal) {
    throw new Error(`Plugin source "${namespace}" has a pending lifecycle transaction.`);
  }
  if (existing) {
    throw new Error(`Plugin source "${namespace}" must retire its current owner before rotation.`);
  }
  const state = newState(namespace, configPath, descriptor, descriptorKey, marketplacePath);
  writeStateFile(statePath(namespace, configPath), state);
  return state;
}

export function replacePluginSourceState(
  state: PluginSourceState,
  descriptor: SourceValue | null,
  descriptorKey: string,
  marketplacePath: string,
  retained: Pick<PluginSourceState, 'checkout' | 'subtree' | 'sourceKind'> = {}
): PluginSourceState {
  const filePath = statePath(state.namespace, state.configPath);
  const current = readStateFile(filePath);
  if (current?.incarnation !== state.incarnation || current.addition || current.removal) {
    throw new Error(`Plugin source "${state.namespace}" changed before owner rotation.`);
  }
  const next = {
    ...newState(state.namespace, state.configPath, descriptor, descriptorKey, marketplacePath),
    ...retained,
  };
  writeStateFile(filePath, next);
  return next;
}

export function pluginSourceStateIsCurrent(state: PluginSourceState): boolean {
  const current = readStateFile(statePath(state.namespace, state.configPath));
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
  if (addition.configPath !== state.configPath) {
    throw new Error(`Plugin source "${state.namespace}" addition has the wrong config owner.`);
  }
  const next = { ...state, addition };
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function updatePluginSourceAddition(
  state: PluginSourceState,
  addition: SourceAdditionState
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.configPath));
  if (current?.incarnation !== state.incarnation || !current.addition) {
    throw new Error(`Plugin source "${state.namespace}" changed during addition.`);
  }
  const next = { ...current, addition };
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function clearPluginSourceAddition(state: PluginSourceState): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.configPath));
  if (current?.incarnation !== state.incarnation) return state;
  const next = { ...current };
  delete next.addition;
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function completePluginSourceAddition(
  state: PluginSourceState,
  ownership: { checkout: SourceCheckoutState } | { subtree: SourceSubtreeState }
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.configPath));
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
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function setPluginSourceSubtree(
  state: PluginSourceState,
  subtree: SourceSubtreeState
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.configPath));
  if (current?.incarnation !== state.incarnation) {
    throw new Error(`Plugin source "${state.namespace}" changed during subtree update.`);
  }
  const next = { ...current, subtree };
  delete next.checkout;
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function setPluginSourceCheckout(
  state: PluginSourceState,
  checkout: SourceCheckoutState
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.configPath));
  if (current?.incarnation !== state.incarnation) {
    throw new Error(`Plugin source "${state.namespace}" changed during checkout adoption.`);
  }
  const next = { ...current, checkout };
  delete next.subtree;
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function setPluginSourceKind(
  state: PluginSourceState,
  sourceKind: 'marketplace' | 'plugin'
): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.configPath));
  if (current?.incarnation !== state.incarnation) return state;
  if (current.sourceKind === sourceKind) return current;
  const next = { ...current, sourceKind };
  writeStateFile(statePath(state.namespace, state.configPath), next);
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
  if (removal.configPath !== state.configPath) {
    throw new Error(`Plugin source "${state.namespace}" removal has the wrong config owner.`);
  }
  const next = { ...state, removal };
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function clearPluginSourceRemoval(state: PluginSourceState): PluginSourceState {
  const current = readStateFile(statePath(state.namespace, state.configPath));
  if (current?.incarnation !== state.incarnation) return state;
  const next = { ...current };
  delete next.removal;
  writeStateFile(statePath(state.namespace, state.configPath), next);
  return next;
}

export function deletePluginSourceState(state: PluginSourceState): void {
  const filePath = statePath(state.namespace, state.configPath);
  const current = readStateFile(filePath);
  if (current?.incarnation !== state.incarnation) return;
  fs.rmSync(filePath, { force: true });
}

function listStateJsonPaths(): string[] {
  const stateRoot = safeStateRoot(false);
  if (!fs.existsSync(stateRoot)) return [];
  const paths: string[] = [];
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    const filePath = path.join(stateRoot, entry.name);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Plugin source state file is a symbolic link: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Plugin source state file is not a regular file: ${filePath}`);
    }
    paths.push(filePath);
  }
  return paths;
}

export function listPluginSourceStates(): PluginSourceState[] {
  const records: PluginSourceState[] = [];
  for (const filePath of listStateJsonPaths()) {
    const state = readStateFile(filePath);
    if (state) records.push(state);
  }
  return records;
}

function sourceStateNamespaceHint(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const hint = value as Record<string, unknown>;
  const namespace = hint.namespace;
  if (
    typeof namespace !== 'string' ||
    !namespace ||
    namespace === '.' ||
    namespace === '..' ||
    namespace.includes('/') ||
    namespace.includes('\\')
  ) {
    return null;
  }
  return namespace;
}

function managedNamespaceHint(value: unknown): string | null {
  const namespace = sourceStateNamespaceHint(value);
  if (!namespace) return null;
  const hint = value as Record<string, unknown>;
  const descriptor = hint.descriptor as Record<string, unknown> | null;
  const addition = hint.addition as Record<string, unknown> | null;
  const removal = hint.removal as Record<string, unknown> | null;
  return hint.checkout !== undefined ||
    hint.subtree !== undefined ||
    addition?.kind === 'clone' ||
    addition?.kind === 'subtree' ||
    removal?.checkout !== undefined ||
    removal?.subtree !== undefined ||
    descriptor?.type === 'clone' ||
    descriptor?.type === 'subtree'
    ? namespace
    : null;
}

export function listManagedPluginSourceNamespaceHints(): Set<string> {
  const stateRoot = safeStateRoot(false);
  const namespaces = new Set<string>();
  for (const filePath of listStateJsonPaths()) {
    assertNoStateSymlinks(stateRoot, filePath);
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const namespace = managedNamespaceHint(value);
    if (namespace) namespaces.add(namespace);
  }
  return namespaces;
}

export function listMalformedPluginSourceNamespaceHints(): Set<string> {
  const stateRoot = safeStateRoot(false);
  const namespaces = new Set<string>();
  for (const filePath of listStateJsonPaths()) {
    assertNoStateSymlinks(stateRoot, filePath);
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const namespace = sourceStateNamespaceHint(value);
    if (namespace && !parseState(value)) namespaces.add(namespace);
  }
  return namespaces;
}

export function listPendingPluginSourceTransactions(): PluginSourceState[] {
  return listPluginSourceStates().filter((state) => state.addition || state.removal);
}
