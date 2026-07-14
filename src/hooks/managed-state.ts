import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getCodexHooksJsonPath, getConfigDir } from '../config/paths.js';
import { assertNoSymlinkAncestor } from '../library/distribute-bundle.js';
import { hookFileSchema } from './schema.js';

export type ManagedHookGroups = Record<string, unknown[]>;
export type ManagedHookPrefixLengths = Record<string, number>;
export type ManagedHookTarget = 'claude-code' | 'codex';

export interface ManagedHookTransactionAddress {
  configPath: string;
  writePath: string;
  statePath: string;
  stateSafetyRoot: string;
  stateSafetyRootIdentity?: string;
  lockPath: string;
  lockSafetyRoot: string;
  lockSafetyRootIdentity?: string;
  projectRoot?: string;
  projectRootAlias?: string;
  projectRootIdentity?: string;
}

export interface LegacyHookBundleCleanupEntry {
  id: string;
  fingerprint: string;
  configHash: string;
}

interface LegacyHookBundleCleanupState {
  version: 3;
  bundles: LegacyHookBundleCleanupEntry[];
  projectRootIdentity?: string;
}

interface ManagedHookState {
  version: 1;
  hooks: ManagedHookGroups;
  prefixLengths: ManagedHookPrefixLengths;
  pending?: {
    desired: ManagedHookGroups;
    desiredPrefixLengths: ManagedHookPrefixLengths;
    previousConfigHash: string;
    desiredConfigHash: string;
    transactionId?: string;
    configCommitted?: true;
  };
}

type PendingManagedHookUpdate = NonNullable<ManagedHookState['pending']>;

export type ManagedHookStateLoadResult =
  | {
      ok: true;
      filePath: string;
      hooks: ManagedHookGroups;
      prefixLengths: ManagedHookPrefixLengths;
      pending: boolean;
    }
  | { ok: false; filePath: string; error: string };

export interface ManagedHookRemovalResult {
  hooks: ManagedHookGroups;
  unmatched: ManagedHookGroups;
}

export function resolveManagedHookStatePath(
  target: ManagedHookTarget,
  configPath: string,
  projectRoot?: string
): string {
  return resolveManagedHookTransactionAddress(target, configPath, projectRoot).statePath;
}

export function resolveManagedHookTransactionAddress(
  target: ManagedHookTarget,
  configPath: string,
  projectRoot?: string
): ManagedHookTransactionAddress {
  const resolvedWritePath = path.resolve(resolveConfigWritePath(configPath));
  const logicalWritePath = resolveLogicalConfigTargetPath(configPath);
  const writePath = canonicalPath(resolvedWritePath);
  const globalStateRoot = canonicalPath(getConfigDir());
  const globalStateRootIdentity = readDirectoryIdentity(globalStateRoot);
  const explicitProjectPath = projectRoot ? canonicalPath(projectRoot) : undefined;
  const inferredProjectPath = inferProjectRoot(target, configPath, writePath, explicitProjectPath);
  const ownerProjectPath = inferredProjectPath;
  if (ownerProjectPath) {
    const projectPath = ownerProjectPath;
    const relativeConfigPath = path.relative(projectPath, writePath);
    const isProjectConfig =
      relativeConfigPath !== '' &&
      relativeConfigPath !== '..' &&
      !relativeConfigPath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeConfigPath);
    if (isProjectConfig) {
      const configIdentity = `project:${relativeConfigPath.split(path.sep).join('/')}`;
      const key = createHash('sha256').update(configIdentity).digest('hex');
      const statePath = path.join(projectPath, '.asb', 'state', 'hooks', `${target}-${key}.json`);
      assertNoSymlinkAncestor(projectPath, statePath);
      const projectRootIdentity = readDirectoryIdentity(projectPath);
      const projectRootAlias = inferProjectRootAlias(target, logicalWritePath, projectPath);
      const lockIdentity = projectRootIdentity ?? `path:${projectPath}`;
      const lockKey = createHash('sha256')
        .update(target)
        .update('\0')
        .update(lockIdentity)
        .update('\0')
        .update(relativeConfigPath.split(path.sep).join('/'))
        .digest('hex');
      return {
        configPath,
        writePath,
        statePath,
        stateSafetyRoot: projectPath,
        ...(projectRootIdentity ? { stateSafetyRootIdentity: projectRootIdentity } : {}),
        lockPath: path.join(globalStateRoot, 'state', 'hooks', 'locks', `${lockKey}.lock`),
        lockSafetyRoot: globalStateRoot,
        ...(globalStateRootIdentity ? { lockSafetyRootIdentity: globalStateRootIdentity } : {}),
        projectRoot: projectPath,
        ...(projectRootAlias ? { projectRootAlias } : {}),
        ...(projectRootIdentity ? { projectRootIdentity } : {}),
      };
    }
  }
  const key = createHash('sha256').update(writePath).digest('hex');
  const stateSafetyRoot = globalStateRoot;
  const statePath = path.join(stateSafetyRoot, 'state', 'hooks', `${target}-${key}.json`);
  return {
    configPath,
    writePath,
    statePath,
    stateSafetyRoot,
    ...(globalStateRootIdentity ? { stateSafetyRootIdentity: globalStateRootIdentity } : {}),
    lockPath: `${statePath}.lock`,
    lockSafetyRoot: stateSafetyRoot,
    ...(globalStateRootIdentity ? { lockSafetyRootIdentity: globalStateRootIdentity } : {}),
  };
}

function resolveLogicalConfigTargetPath(configPath: string): string {
  let current = path.resolve(configPath);
  for (let hop = 0; hop < 40; hop += 1) {
    const stat = lstatIfExists(current);
    if (!stat?.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  throw new Error(`circular application config symlink: ${configPath}`);
}

function inferProjectRootAlias(
  target: ManagedHookTarget,
  resolvedWritePath: string,
  ownerProjectPath: string
): string | undefined {
  const configDir = path.dirname(resolvedWritePath);
  const hasProjectShape =
    (target === 'claude-code' &&
      path.basename(configDir) === '.claude' &&
      path.basename(resolvedWritePath) === 'settings.local.json') ||
    (target === 'codex' &&
      path.basename(configDir) === '.codex' &&
      path.basename(resolvedWritePath) === 'hooks.json');
  if (!hasProjectShape) return undefined;
  const candidate = path.dirname(configDir);
  return candidate !== ownerProjectPath && canonicalPath(candidate) === ownerProjectPath
    ? candidate
    : undefined;
}

function inferProjectRoot(
  target: ManagedHookTarget,
  configPath: string,
  writePath: string,
  explicitProjectPath?: string
): string | undefined {
  const configDir = path.dirname(writePath);
  const candidate = path.dirname(configDir);
  const isProjectShape =
    (target === 'claude-code' &&
      path.basename(configDir) === '.claude' &&
      path.basename(writePath) === 'settings.local.json') ||
    (target === 'codex' &&
      path.basename(configDir) === '.codex' &&
      path.basename(writePath) === 'hooks.json');
  if (!isProjectShape) return undefined;
  const globalCodexPath = path.join(
    canonicalPath(path.dirname(getCodexHooksJsonPath())),
    path.basename(getCodexHooksJsonPath())
  );
  if (target === 'codex' && path.resolve(writePath) === globalCodexPath) {
    return undefined;
  }
  if (explicitProjectPath) return candidate;
  const configIsSymlink = lstatIfExists(configPath)?.isSymbolicLink() === true;
  const isLogicalGlobalCodexConfig =
    target === 'codex' &&
    path.resolve(configPath) === path.resolve(getCodexHooksJsonPath()) &&
    !configIsSymlink;
  return isLogicalGlobalCodexConfig ? undefined : candidate;
}

function readDirectoryIdentity(dirPath: string): string | undefined {
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return undefined;
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export function loadManagedHookGroups(
  target: ManagedHookTarget,
  configPath: string,
  projectRoot?: string,
  address = resolveManagedHookTransactionAddress(target, configPath, projectRoot),
  recoverPending = true
): ManagedHookStateLoadResult {
  assertAddressStillCurrent(address);
  const filePath = address.statePath;
  assertSafeStatePath(address, filePath);
  if (!fs.existsSync(filePath)) {
    return { ok: true, filePath, hooks: {}, prefixLengths: {}, pending: false };
  }

  try {
    assertSafeStatePath(address, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    const state = parseManagedHookState(parsed, target);
    if (!state) {
      return { ok: false, filePath, error: 'managed hook state has invalid shape' };
    }
    if (!state.pending) {
      return {
        ok: true,
        filePath,
        hooks: state.hooks,
        prefixLengths: state.prefixLengths,
        pending: false,
      };
    }

    if (recoverPending) recoverPendingConfigTransition(address, state.pending);
    const currentSnapshot = readConfigSnapshot(address.writePath);
    const currentHash = hashConfigSnapshot(currentSnapshot.content);
    if (currentHash === state.pending.desiredConfigHash) {
      if (recoverPending) {
        finalizeRecoveredManagedHookState(
          address,
          state,
          state.pending.desired,
          state.pending.desiredPrefixLengths,
          currentSnapshot
        );
      }
      return {
        ok: true,
        filePath,
        hooks: state.pending.desired,
        prefixLengths: state.pending.desiredPrefixLengths,
        pending: !recoverPending,
      };
    }
    if (currentHash === state.pending.previousConfigHash) {
      if (recoverPending) {
        finalizeRecoveredManagedHookState(
          address,
          state,
          state.hooks,
          state.prefixLengths,
          currentSnapshot
        );
      }
      return {
        ok: true,
        filePath,
        hooks: state.hooks,
        prefixLengths: state.prefixLengths,
        pending: !recoverPending,
      };
    }
    return {
      ok: false,
      filePath,
      error: 'pending managed hook update does not match the application config',
    };
  } catch (error) {
    return {
      ok: false,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function saveManagedHookGroups(
  target: ManagedHookTarget,
  configPath: string,
  hooks: ManagedHookGroups,
  prefixLengths: ManagedHookPrefixLengths,
  projectRoot?: string,
  address = resolveManagedHookTransactionAddress(target, configPath, projectRoot)
): void {
  assertAddressStillCurrent(address);
  publishManagedHookState(address, hooks, prefixLengths);
}

function publishManagedHookState(
  address: ManagedHookTransactionAddress,
  hooks: ManagedHookGroups,
  prefixLengths: ManagedHookPrefixLengths
): void {
  const filePath = address.statePath;
  assertSafeStatePath(address, filePath);
  if (!hasManagedHookGroups(hooks)) {
    if (fs.existsSync(filePath)) {
      assertSafeStatePath(address, filePath);
      fs.unlinkSync(filePath);
    }
    return;
  }
  writeManagedHookState(address, { version: 1, hooks, prefixLengths });
}

function finalizeRecoveredManagedHookState(
  address: ManagedHookTransactionAddress,
  pendingState: ManagedHookState,
  hooks: ManagedHookGroups,
  prefixLengths: ManagedHookPrefixLengths,
  expectedConfig: ConfigSnapshot
): void {
  publishManagedHookState(address, hooks, prefixLengths);
  try {
    assertConfigSnapshotMatches(
      readConfigSnapshot(address.writePath),
      expectedConfig.content,
      expectedConfig.mode,
      expectedConfig.identity
    );
  } catch (error) {
    try {
      writeManagedHookState(address, pendingState);
    } catch (restoreError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; pending state restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
      );
    }
    throw error;
  }
}

export function hasManagedHookGroups(hooks: ManagedHookGroups): boolean {
  return Object.values(hooks).some((groups) => groups.length > 0);
}

export function readPendingLegacyHookBundleCleanup(
  address: ManagedHookTransactionAddress
): LegacyHookBundleCleanupEntry[] {
  const markerPath = legacyCleanupMarkerPath(address);
  assertSafeStatePath(address, markerPath);
  const stat = lstatIfExists(markerPath);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`invalid legacy hook cleanup marker: ${markerPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid legacy hook cleanup marker: ${markerPath}`);
  }
  const state = parsed as Record<string, unknown>;
  if (
    state.version !== 3 ||
    !Array.isArray(state.bundles) ||
    state.bundles.some(
      (value) =>
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !isSafeBundleId((value as Record<string, unknown>).id) ||
        !isSha256((value as Record<string, unknown>).fingerprint) ||
        !isSha256((value as Record<string, unknown>).configHash)
    ) ||
    (state.projectRootIdentity !== undefined && typeof state.projectRootIdentity !== 'string') ||
    (address.projectRootIdentity !== undefined &&
      state.projectRootIdentity !== address.projectRootIdentity) ||
    (address.projectRootIdentity === undefined && state.projectRootIdentity !== undefined)
  ) {
    throw new Error(`invalid legacy hook cleanup marker: ${markerPath}`);
  }
  const byId = new Map<string, LegacyHookBundleCleanupEntry>();
  for (const value of state.bundles as LegacyHookBundleCleanupEntry[]) {
    if (!byId.has(value.id)) byId.set(value.id, value);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function markLegacyHookBundleCleanup(
  address: ManagedHookTransactionAddress,
  bundles: readonly Omit<LegacyHookBundleCleanupEntry, 'configHash'>[],
  expectedConfig: string | undefined
): void {
  assertAddressStillCurrent(address);
  if (bundles.some((value) => !isSafeBundleId(value.id) || !isSha256(value.fingerprint))) {
    throw new Error('invalid legacy hook bundle id');
  }
  const configHash = managedHookConfigHash(expectedConfig);
  const existing = readPendingLegacyHookBundleCleanup(address);
  if (existing.some((value) => value.configHash !== configHash)) {
    throw new Error('legacy hook cleanup marker belongs to another config snapshot');
  }
  const byId = new Map(existing.map((value) => [value.id, value]));
  for (const value of bundles) {
    if (!byId.has(value.id)) byId.set(value.id, { ...value, configHash });
  }
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (merged.length === 0) return;
  writeLegacyHookBundleCleanup(address, merged);
}

export function refreshLegacyHookBundleCleanup(
  address: ManagedHookTransactionAddress,
  id: string,
  fingerprint: string
): void {
  if (!isSafeBundleId(id) || !isSha256(fingerprint)) {
    throw new Error('invalid legacy hook cleanup retry state');
  }
  const bundles = readPendingLegacyHookBundleCleanup(address);
  const index = bundles.findIndex((value) => value.id === id);
  if (index < 0) throw new Error(`legacy hook cleanup retry is not owned: ${id}`);
  bundles[index] = { ...bundles[index], fingerprint };
  writeLegacyHookBundleCleanup(address, bundles);
}

function writeLegacyHookBundleCleanup(
  address: ManagedHookTransactionAddress,
  bundles: readonly LegacyHookBundleCleanupEntry[]
): void {
  const markerPath = legacyCleanupMarkerPath(address);
  assertSafeStatePath(address, markerPath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  assertSafeStatePath(address, markerPath);
  const state: LegacyHookBundleCleanupState = {
    version: 3,
    bundles: [...bundles],
    ...(address.projectRootIdentity ? { projectRootIdentity: address.projectRootIdentity } : {}),
  };
  const tmpPath = `${markerPath}.tmp.${process.pid}.${randomBytes(12).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    assertAddressStillCurrent(address);
    assertSafeStatePath(address, markerPath);
    fs.renameSync(tmpPath, markerPath);
  } finally {
    if (lstatIfExists(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

export function managedHookConfigHash(config: string | undefined): string {
  return hashConfigSnapshot(config === undefined ? undefined : Buffer.from(config));
}

export function clearLegacyHookBundleCleanup(address: ManagedHookTransactionAddress): void {
  const markerPath = legacyCleanupMarkerPath(address);
  assertSafeStatePath(address, markerPath);
  if (lstatIfExists(markerPath)) fs.unlinkSync(markerPath);
}

function legacyCleanupMarkerPath(address: ManagedHookTransactionAddress): string {
  return `${address.statePath}.legacy-bundles`;
}

function isSafeBundleId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

export function getManagedHookPrefixLengths(
  userHooks: ManagedHookGroups,
  managed: ManagedHookGroups
): ManagedHookPrefixLengths {
  const prefixLengths: ManagedHookPrefixLengths = {};
  for (const [event, groups] of Object.entries(managed)) {
    if (groups.length > 0) prefixLengths[event] = userHooks[event]?.length ?? 0;
  }
  return prefixLengths;
}

export function assertManagedHookConfigSnapshot(
  address: ManagedHookTransactionAddress,
  expectedConfig: string | undefined,
  expectedMode?: number,
  expectedIdentity?: string
): void {
  assertAddressStillCurrent(address);
  const expectedBuffer = expectedConfig === undefined ? undefined : Buffer.from(expectedConfig);
  assertConfigSnapshotMatches(
    readConfigSnapshot(address.writePath),
    expectedBuffer,
    expectedMode,
    expectedIdentity
  );
}

export function commitManagedHookUpdate(
  target: ManagedHookTarget,
  configPath: string,
  previous: ManagedHookGroups,
  previousPrefixLengths: ManagedHookPrefixLengths,
  desired: ManagedHookGroups,
  desiredPrefixLengths: ManagedHookPrefixLengths,
  desiredConfig: string | undefined,
  expectedConfig: string | undefined,
  projectRoot?: string,
  address = resolveManagedHookTransactionAddress(target, configPath, projectRoot),
  expectedMode?: number,
  expectedIdentity?: string
): string | undefined {
  assertManagedHookConfigSnapshot(address, expectedConfig, expectedMode, expectedIdentity);
  const writePath = address.writePath;
  const previousSnapshot = readConfigSnapshot(writePath);
  const previousConfig = previousSnapshot.content;
  const expectedBuffer = expectedConfig === undefined ? undefined : Buffer.from(expectedConfig);
  assertConfigSnapshotMatches(previousSnapshot, expectedBuffer, expectedMode, expectedIdentity);
  const previousMode = previousSnapshot.mode;
  const desiredBuffer = desiredConfig === undefined ? undefined : Buffer.from(desiredConfig);
  const transactionId = randomBytes(12).toString('hex');
  const pending: PendingManagedHookUpdate = {
    desired,
    desiredPrefixLengths,
    previousConfigHash: hashConfigSnapshot(previousConfig),
    desiredConfigHash: hashConfigSnapshot(desiredBuffer),
    transactionId,
  };
  const pendingState: ManagedHookState = {
    version: 1,
    hooks: previous,
    prefixLengths: previousPrefixLengths,
    pending,
  };
  writeManagedHookState(address, pendingState);
  let commitRecorded = false;
  try {
    writeConfigSnapshot(address, desiredBuffer, previousMode, previousSnapshot, transactionId);
    assertConfigFileSnapshot(
      writePath,
      desiredBuffer,
      desiredBuffer === undefined ? undefined : previousMode
    );
    const committedState: ManagedHookState = {
      ...pendingState,
      pending: { ...pending, configCommitted: true },
    };
    writeManagedHookState(address, committedState);
    commitRecorded = true;
    try {
      assertConfigFileSnapshot(
        writePath,
        desiredBuffer,
        desiredBuffer === undefined ? undefined : previousMode
      );
    } catch (error) {
      writeManagedHookState(address, pendingState);
      throw new ConfigChangedAfterStatePublicationError(
        error instanceof Error ? error.message : String(error)
      );
    }
    cleanupPendingConfigArtifacts(address, pending);
    saveManagedHookGroups(target, configPath, desired, desiredPrefixLengths, projectRoot, address);
    return readConfigSnapshot(writePath).identity;
  } catch (error) {
    if (error instanceof ConfigChangedAfterStatePublicationError) throw error;
    if (commitRecorded) throw error;
    if (error instanceof ConfigRestoreFailedError) throw error;
    if (error instanceof ConfigWriteNotAppliedError) {
      const current = readConfigSnapshot(writePath);
      try {
        cleanupPendingConfigArtifacts(address, pending, current, true);
        saveManagedHookGroups(
          target,
          configPath,
          previous,
          previousPrefixLengths,
          projectRoot,
          address
        );
      } catch (cleanupError) {
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${original}; pending state cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
      throw error;
    }
    try {
      rollbackPublishedConfig(
        address,
        pending,
        desiredBuffer,
        desiredBuffer === undefined ? undefined : previousMode
      );
      saveManagedHookGroups(
        target,
        configPath,
        previous,
        previousPrefixLengths,
        projectRoot,
        address
      );
    } catch (rollbackError) {
      const original = error instanceof Error ? error.message : String(error);
      const rollback =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${original}; rollback failed: ${rollback}`);
    }
    throw error;
  }
}

export function withManagedHookLock<T>(
  target: ManagedHookTarget,
  configPath: string,
  operation: (address: ManagedHookTransactionAddress) => T,
  projectRoot?: string
): T {
  let address = resolveManagedHookTransactionAddress(target, configPath, projectRoot);
  if (address.projectRoot && !address.projectRootIdentity) {
    throw new Error(`project root does not exist: ${address.projectRoot}`);
  }
  address = pinManagedHookTransactionRoots(address);
  const lockAddress = {
    ...address,
    stateSafetyRoot: address.lockSafetyRoot,
    stateSafetyRootIdentity: address.lockSafetyRootIdentity,
  };
  const lockPath = address.lockPath;
  const token = acquireLock(lockAddress, lockPath);
  try {
    assertAddressStillCurrent(address);
    return operation(address);
  } finally {
    releaseOwnedLock(lockAddress, lockPath, token);
  }
}

export function removeManagedHookGroups(
  existing: ManagedHookGroups,
  managed: ManagedHookGroups,
  prefixLengths: ManagedHookPrefixLengths,
  cleanLegacyManaged?: (group: Record<string, unknown>) => Record<string, unknown> | undefined
): ManagedHookRemovalResult {
  const cleaned: ManagedHookGroups = {};
  const unmatched: ManagedHookGroups = {};

  for (const [event, groups] of Object.entries(existing)) {
    let kept = [...groups];
    const expected = managed[event] ?? [];
    if (expected.length > 0) {
      const start = prefixLengths[event] ?? -1;
      const matches =
        Number.isInteger(start) &&
        start >= 0 &&
        kept.length >= start + expected.length &&
        expected.every((group, index) => isDeepStrictEqual(kept[start + index], group));
      if (matches) {
        kept.splice(start, expected.length);
      } else {
        unmatched[event] = [...expected];
      }
    }

    kept = kept.flatMap((group) => {
      const record =
        typeof group === 'object' && group !== null && !Array.isArray(group)
          ? (group as Record<string, unknown>)
          : {};
      if (!cleanLegacyManaged) return [group];
      const cleaned = cleanLegacyManaged(record);
      return cleaned ? [cleaned] : [];
    });
    if (kept.length > 0) cleaned[event] = kept;
  }

  for (const [event, groups] of Object.entries(managed)) {
    if (!(event in existing) && groups.length > 0) unmatched[event] = [...groups];
  }

  return { hooks: cleaned, unmatched };
}

function parseManagedHookState(
  value: unknown,
  target: ManagedHookTarget
): ManagedHookState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (state.version !== 1) return undefined;
  const hooks = parseManagedHookGroups(state.hooks, target);
  const prefixLengths = parsePrefixLengths(state.prefixLengths, hooks);
  if (!hooks || !prefixLengths) return undefined;
  if (state.pending === undefined) return { version: 1, hooks, prefixLengths };
  if (typeof state.pending !== 'object' || state.pending === null || Array.isArray(state.pending)) {
    return undefined;
  }
  const pending = state.pending as Record<string, unknown>;
  const desired = parseManagedHookGroups(pending.desired, target);
  const desiredPrefixLengths = parsePrefixLengths(pending.desiredPrefixLengths, desired);
  if (
    !desired ||
    !desiredPrefixLengths ||
    !isSha256(pending.previousConfigHash) ||
    !isSha256(pending.desiredConfigHash) ||
    (pending.transactionId !== undefined && !isLockToken(pending.transactionId)) ||
    (pending.configCommitted !== undefined && pending.configCommitted !== true)
  ) {
    return undefined;
  }
  return {
    version: 1,
    hooks,
    prefixLengths,
    pending: {
      desired,
      desiredPrefixLengths,
      previousConfigHash: pending.previousConfigHash,
      desiredConfigHash: pending.desiredConfigHash,
      ...(isLockToken(pending.transactionId) ? { transactionId: pending.transactionId } : {}),
      ...(pending.configCommitted === true ? { configCommitted: true } : {}),
    },
  };
}

function parseManagedHookGroups(
  value: unknown,
  target: ManagedHookTarget
): ManagedHookGroups | undefined {
  const parsed = hookFileSchema.safeParse({ hooks: value });
  if (!parsed.success) return undefined;
  if (
    target === 'codex' &&
    Object.values(parsed.data.hooks).some((groups) =>
      groups.some((group) =>
        group.hooks.some((handler) => {
          const allowedKeys = new Set([
            'type',
            'command',
            'commandWindows',
            'timeout',
            'async',
            'statusMessage',
          ]);
          return (
            handler.type !== 'command' ||
            typeof handler.command !== 'string' ||
            (handler.commandWindows !== undefined && typeof handler.commandWindows !== 'string') ||
            handler.command_windows !== undefined ||
            (handler.timeout !== undefined &&
              (!Number.isSafeInteger(handler.timeout) || handler.timeout < 0)) ||
            (handler.async !== undefined && typeof handler.async !== 'boolean') ||
            (handler.statusMessage !== undefined && typeof handler.statusMessage !== 'string') ||
            Object.keys(handler).some((key) => !allowedKeys.has(key))
          );
        })
      )
    )
  ) {
    return undefined;
  }
  return parsed.data.hooks;
}

function parsePrefixLengths(
  value: unknown,
  hooks?: ManagedHookGroups
): ManagedHookPrefixLengths | undefined {
  if (!hooks || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const lengths = value as Record<string, unknown>;
  const result: ManagedHookPrefixLengths = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (groups.length === 0) continue;
    const length = lengths[event];
    if (!Number.isInteger(length) || (length as number) < 0) return undefined;
    result[event] = length as number;
  }
  return result;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isLockToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
}

function canonicalPath(filePath: string): string {
  let existing = path.resolve(filePath);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...suffix);
}

function resolveConfigWritePath(configPath: string): string {
  const absolute = path.resolve(configPath);
  let root = path.parse(absolute).root;
  let remaining = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let resolved = root;
  let symlinkHops = 0;

  while (remaining.length > 0) {
    const segment = remaining.shift();
    if (!segment) continue;
    const candidate = path.join(resolved, segment);
    const stat = lstatIfExists(candidate);
    if (!stat) return path.join(candidate, ...remaining);
    if (!stat.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }
    symlinkHops += 1;
    if (symlinkHops > 40) {
      throw new Error(`circular application config symlink: ${configPath}`);
    }
    try {
      const target = fs.readlinkSync(candidate);
      const targetPath = path.resolve(path.dirname(candidate), target);
      root = path.parse(targetPath).root;
      remaining = [...targetPath.slice(root.length).split(path.sep).filter(Boolean), ...remaining];
      resolved = root;
    } catch (error) {
      if (!isErrorCode(error, 'EINVAL')) throw error;
      resolved = candidate;
    }
  }
  return resolved;
}

function assertAddressStillCurrent(address: ManagedHookTransactionAddress): void {
  if (
    address.projectRoot &&
    (!address.projectRootIdentity ||
      readDirectoryIdentity(address.projectRoot) !== address.projectRootIdentity)
  ) {
    throw new Error('project root changed during hook sync');
  }
  assertSafetyRootIdentity(
    address.stateSafetyRoot,
    address.stateSafetyRootIdentity,
    'managed hook state root'
  );
  assertSafetyRootIdentity(
    address.lockSafetyRoot,
    address.lockSafetyRootIdentity,
    'managed hook lock root'
  );
  const currentWritePath = canonicalPath(resolveConfigWritePath(address.configPath));
  if (currentWritePath !== address.writePath) {
    throw new Error('application config target changed during hook sync');
  }
}

function assertSafeStatePath(address: ManagedHookTransactionAddress, candidate: string): void {
  const rootStat = lstatIfExists(address.stateSafetyRoot);
  if (rootStat?.isSymbolicLink()) {
    throw new Error(`refusing to follow symlinked state root: ${address.stateSafetyRoot}`);
  }
  if (rootStat && !rootStat.isDirectory()) {
    throw new Error(`managed hook state root is not a directory: ${address.stateSafetyRoot}`);
  }
  assertSafetyRootIdentity(
    address.stateSafetyRoot,
    address.stateSafetyRootIdentity,
    'managed hook state root'
  );
  assertNoSymlinkAncestor(address.stateSafetyRoot, candidate);
}

function pinManagedHookTransactionRoots(
  address: ManagedHookTransactionAddress
): ManagedHookTransactionAddress {
  const pinRoot = (root: string, expected: string | undefined): string => {
    const isProjectRoot = address.projectRoot === root;
    let stat = lstatIfExists(root);
    if (expected !== undefined) {
      if (!stat || readDirectoryIdentity(root) !== expected) {
        throw new Error(`managed hook safety root changed before lock acquisition: ${root}`);
      }
    } else if (!stat) {
      if (isProjectRoot) throw new Error(`project root does not exist: ${root}`);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      stat = lstatIfExists(root);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`managed hook safety root is not a directory: ${root}`);
    }
    const identity = readDirectoryIdentity(root);
    if (!identity) throw new Error(`cannot identify managed hook safety root: ${root}`);
    return expected ?? identity;
  };
  let stateSafetyRootIdentity: string;
  let lockSafetyRootIdentity: string;
  if (address.lockSafetyRoot === address.stateSafetyRoot) {
    if (
      address.stateSafetyRootIdentity !== undefined &&
      address.lockSafetyRootIdentity !== undefined &&
      address.stateSafetyRootIdentity !== address.lockSafetyRootIdentity
    ) {
      throw new Error('managed hook safety root identities do not match');
    }
    const identity = pinRoot(
      address.stateSafetyRoot,
      address.stateSafetyRootIdentity ?? address.lockSafetyRootIdentity
    );
    stateSafetyRootIdentity = address.stateSafetyRootIdentity ?? identity;
    lockSafetyRootIdentity = address.lockSafetyRootIdentity ?? identity;
  } else {
    stateSafetyRootIdentity = pinRoot(address.stateSafetyRoot, address.stateSafetyRootIdentity);
    lockSafetyRootIdentity = pinRoot(address.lockSafetyRoot, address.lockSafetyRootIdentity);
  }
  if (!stateSafetyRootIdentity || !lockSafetyRootIdentity) {
    throw new Error('cannot identify managed hook safety roots');
  }
  return { ...address, stateSafetyRootIdentity, lockSafetyRootIdentity };
}

function assertSafetyRootIdentity(root: string, expected: string | undefined, label: string): void {
  if (expected !== undefined && readDirectoryIdentity(root) !== expected) {
    throw new Error(`${label} changed during hook sync`);
  }
}

function writeManagedHookState(
  address: ManagedHookTransactionAddress,
  state: ManagedHookState
): void {
  const filePath = address.statePath;
  assertSafeStatePath(address, filePath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafeStatePath(address, filePath);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(12).toString('hex')}`;
  try {
    assertSafeStatePath(address, tmpPath);
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    assertSafeStatePath(address, filePath);
    assertSafeStatePath(address, tmpPath);
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (lstatIfExists(tmpPath)) {
      assertSafeStatePath(address, tmpPath);
      fs.unlinkSync(tmpPath);
    }
  }
}

class ConfigWriteNotAppliedError extends Error {}

class ConfigRestoreFailedError extends ConfigWriteNotAppliedError {}

class ConfigChangedAfterStatePublicationError extends Error {}

class ApplicationConfigChangedError extends ConfigWriteNotAppliedError {
  constructor() {
    super('application config changed during hook sync');
  }
}

interface ConfigSnapshot {
  kind: 'missing' | 'file' | 'symlink' | 'other';
  content?: Buffer;
  mode?: number;
  identity?: string;
}

function writeConfigSnapshot(
  address: ManagedHookTransactionAddress,
  content?: Buffer,
  mode?: number,
  expectedCurrent: ConfigSnapshot = { kind: 'missing' },
  transactionId?: string
): void {
  const filePath = address.writePath;
  assertAddressStillCurrent(address);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const nonce = transactionId ?? `${process.pid}.${randomBytes(12).toString('hex')}`;
  const tmpPath = `${filePath}.tmp.${nonce}`;
  const backupPath = `${filePath}.previous.${nonce}`;
  let captured = false;
  let published = false;
  let preserveArtifacts = false;
  try {
    if (lstatIfExists(tmpPath) || lstatIfExists(backupPath)) {
      throw new ConfigWriteNotAppliedError('application config transaction artifact exists');
    }
    if (content !== undefined) {
      fs.writeFileSync(tmpPath, content, { mode: mode ?? 0o666, flag: 'wx' });
      if (mode !== undefined) fs.chmodSync(tmpPath, mode);
    }

    assertAddressStillCurrent(address);
    assertConfigSnapshotMatches(
      readConfigSnapshot(filePath),
      expectedCurrent.content,
      expectedCurrent.mode,
      expectedCurrent.identity
    );
    if (expectedCurrent.content !== undefined) {
      try {
        fs.renameSync(filePath, backupPath);
        captured = true;
      } catch (error) {
        if (isErrorCode(error, 'ENOENT')) throw new ApplicationConfigChangedError();
        throw error;
      }
      assertConfigSnapshotMatches(
        readConfigSnapshot(backupPath),
        expectedCurrent.content,
        expectedCurrent.mode,
        expectedCurrent.identity
      );
    }

    assertAddressStillCurrent(address);
    if (captured) {
      assertConfigSnapshotMatches(
        readConfigSnapshot(backupPath),
        expectedCurrent.content,
        expectedCurrent.mode,
        expectedCurrent.identity
      );
    }
    if (content !== undefined) {
      try {
        fs.linkSync(tmpPath, filePath);
      } catch (error) {
        if (isErrorCode(error, 'EEXIST')) throw new ApplicationConfigChangedError();
        throw error;
      }
      published = true;
    } else {
      if (lstatIfExists(filePath)) throw new ApplicationConfigChangedError();
      published = true;
    }

    assertConfigFileSnapshot(filePath, content, content === undefined ? undefined : mode);

    if (captured && !transactionId) {
      fs.unlinkSync(backupPath);
      captured = false;
    }
  } catch (error) {
    if (!published && captured) {
      try {
        if (lstatIfExists(filePath)) throw new ApplicationConfigChangedError();
        fs.renameSync(backupPath, filePath);
        captured = false;
      } catch (restoreError) {
        preserveArtifacts = true;
        const original = error instanceof Error ? error.message : String(error);
        const restore = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new ConfigRestoreFailedError(`${original}; config restore failed: ${restore}`);
      } finally {
        if (!preserveArtifacts && lstatIfExists(backupPath)) fs.unlinkSync(backupPath);
        if (!preserveArtifacts) captured = false;
      }
    }
    if (!published && !(error instanceof ConfigWriteNotAppliedError)) {
      throw new ConfigWriteNotAppliedError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  } finally {
    if (lstatIfExists(tmpPath) && (!transactionId || (!published && !preserveArtifacts))) {
      fs.unlinkSync(tmpPath);
    }
    if (lstatIfExists(backupPath) && (!transactionId || (!published && !preserveArtifacts))) {
      if (!preserveArtifacts) {
        if (lstatIfExists(backupPath)) fs.unlinkSync(backupPath);
      }
    }
  }
}

function readConfigSnapshot(filePath: string): ConfigSnapshot {
  let fd: number | undefined;
  try {
    const pathStat = fs.lstatSync(filePath);
    const identity = `${pathStat.dev}:${pathStat.ino}`;
    if (pathStat.isSymbolicLink()) return { kind: 'symlink', identity };
    if (!pathStat.isFile()) return { kind: 'other', identity };
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new ApplicationConfigChangedError();
    }
    return {
      kind: 'file',
      content: fs.readFileSync(fd),
      mode: stat.mode & 0o777,
      identity,
    };
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { kind: 'missing' };
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertConfigFileSnapshot(
  filePath: string,
  expected?: Buffer,
  expectedMode?: number
): void {
  assertConfigSnapshotMatches(readConfigSnapshot(filePath), expected, expectedMode);
}

function assertConfigSnapshotMatches(
  current: ConfigSnapshot,
  expected?: Buffer,
  expectedMode?: number,
  expectedIdentity?: string
): void {
  if (
    current.kind !== (expected === undefined ? 'missing' : 'file') ||
    hashConfigSnapshot(current.content) !== hashConfigSnapshot(expected) ||
    (expected !== undefined && expectedMode !== undefined && current.mode !== expectedMode) ||
    (expectedIdentity !== undefined && current.identity !== expectedIdentity)
  ) {
    throw new ApplicationConfigChangedError();
  }
}

function hashConfigSnapshot(content?: Buffer): string {
  const hash = createHash('sha256');
  if (content !== undefined) {
    hash.update('present\0');
    hash.update(content);
  } else {
    hash.update('missing\0');
  }
  return hash.digest('hex');
}

function recoverPendingConfigTransition(
  address: ManagedHookTransactionAddress,
  pending: PendingManagedHookUpdate
): void {
  if (!pending.transactionId) return;
  assertAddressStillCurrent(address);
  const { backupPath } = pendingConfigArtifactPaths(address, pending.transactionId);
  let current = readConfigSnapshot(address.writePath);
  const backup = readConfigArtifactSnapshot(backupPath);
  if (backup && hashConfigSnapshot(backup.content) !== pending.previousConfigHash) {
    throw new Error('pending application config backup does not match the journal');
  }

  if (
    pending.configCommitted !== true &&
    current.content === undefined &&
    hashConfigSnapshot(current.content) !== pending.desiredConfigHash &&
    backup
  ) {
    try {
      fs.linkSync(backupPath, address.writePath);
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }
    current = readConfigSnapshot(address.writePath);
  }

  cleanupPendingConfigArtifacts(address, pending, current);
}

function rollbackPublishedConfig(
  address: ManagedHookTransactionAddress,
  pending: PendingManagedHookUpdate,
  desiredConfig?: Buffer,
  desiredMode?: number
): void {
  if (!pending.transactionId) throw new Error('managed hook rollback has no transaction identity');
  const { backupPath, failedPath } = pendingConfigArtifactPaths(address, pending.transactionId);
  const backup = readConfigArtifactSnapshot(backupPath);
  if (backup && hashConfigSnapshot(backup.content) !== pending.previousConfigHash) {
    throw new Error('pending application config backup does not match the journal');
  }
  assertConfigFileSnapshot(address.writePath, desiredConfig, desiredMode);
  if (lstatIfExists(failedPath)) {
    throw new Error('application config rollback artifact exists');
  }

  let capturedDesired = false;
  try {
    if (desiredConfig !== undefined) {
      fs.renameSync(address.writePath, failedPath);
      capturedDesired = true;
      assertConfigFileSnapshot(failedPath, desiredConfig, desiredMode);
    }
    if (backup) {
      fs.linkSync(backupPath, address.writePath);
    }
    const previous = backup?.content;
    assertConfigFileSnapshot(address.writePath, previous, backup?.mode);
    cleanupPendingConfigArtifacts(address, pending);
  } catch (error) {
    if (capturedDesired && !lstatIfExists(address.writePath)) {
      try {
        fs.linkSync(failedPath, address.writePath);
      } catch {}
    }
    throw error;
  }
}

function cleanupPendingConfigArtifacts(
  address: ManagedHookTransactionAddress,
  pending: PendingManagedHookUpdate,
  current = readConfigSnapshot(address.writePath),
  allowExternalConfig = false
): void {
  if (!pending.transactionId) return;
  const { backupPath, tmpPath, failedPath } = pendingConfigArtifactPaths(
    address,
    pending.transactionId
  );
  const currentHash = hashConfigSnapshot(current.content);
  if (
    !allowExternalConfig &&
    currentHash !== pending.previousConfigHash &&
    currentHash !== pending.desiredConfigHash
  ) {
    throw new ApplicationConfigChangedError();
  }
  const artifacts = [
    { filePath: backupPath, expectedHash: pending.previousConfigHash },
    { filePath: tmpPath, expectedHash: pending.desiredConfigHash },
    { filePath: failedPath, expectedHash: pending.desiredConfigHash },
  ];
  for (const artifact of artifacts) {
    const snapshot = readConfigArtifactSnapshot(artifact.filePath);
    if (!snapshot) continue;
    if (hashConfigSnapshot(snapshot.content) !== artifact.expectedHash) {
      throw new Error(
        `application config transaction artifact does not match: ${artifact.filePath}`
      );
    }
    assertAddressStillCurrent(address);
    fs.unlinkSync(artifact.filePath);
  }
}

function pendingConfigArtifactPaths(
  address: ManagedHookTransactionAddress,
  transactionId: string
): { backupPath: string; tmpPath: string; failedPath: string } {
  return {
    backupPath: `${address.writePath}.previous.${transactionId}`,
    tmpPath: `${address.writePath}.tmp.${transactionId}`,
    failedPath: `${address.writePath}.failed.${transactionId}`,
  };
}

function readConfigArtifactSnapshot(filePath: string): ConfigSnapshot | undefined {
  const stat = lstatIfExists(filePath);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`invalid application config transaction artifact: ${filePath}`);
  }
  return readConfigSnapshot(filePath);
}

function acquireLock(address: ManagedHookTransactionAddress, lockPath: string): string {
  assertSafeStatePath(address, lockPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  assertSafeStatePath(address, lockPath);
  try {
    return createOwnedLock(address, lockPath);
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
    if (!isStaleLock(address, lockPath)) throw error;

    const recoveryPath = `${lockPath}.recovery`;
    const recoveryToken = acquireLock(address, recoveryPath);
    try {
      try {
        return createOwnedLock(address, lockPath);
      } catch (retryError) {
        if (!isErrorCode(retryError, 'EEXIST') || !isStaleLock(address, lockPath)) {
          throw retryError;
        }
      }
      removeStaleLock(address, lockPath);
      return createOwnedLock(address, lockPath);
    } finally {
      releaseOwnedLock(address, recoveryPath, recoveryToken);
    }
  }
}

function createOwnedLock(address: ManagedHookTransactionAddress, lockPath: string): string {
  assertSafeStatePath(address, lockPath);
  fs.mkdirSync(lockPath, { mode: 0o700 });
  let token: string | undefined;
  try {
    const identity = readProcessIdentity(process.pid);
    if (!identity) throw new Error('cannot determine lock owner process identity');
    token = randomBytes(12).toString('hex');
    const owner = {
      pid: process.pid,
      token,
      identity,
    };
    const ownerPath = path.join(lockPath, 'owner');
    const tmpPath = path.join(lockPath, `.owner.${token}`);
    assertSafeStatePath(address, tmpPath);
    fs.writeFileSync(tmpPath, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      assertSafeStatePath(address, ownerPath);
      fs.linkSync(tmpPath, ownerPath);
    } finally {
      if (lstatIfExists(tmpPath)) fs.unlinkSync(tmpPath);
    }
    return token;
  } catch (error) {
    removeEmptyOwnedLock(address, lockPath, token);
    throw error;
  }
}

function isStaleLock(address: ManagedHookTransactionAddress, lockPath: string): boolean {
  assertSafeStatePath(address, lockPath);
  const ownerPath = path.join(lockPath, 'owner');
  let content: string | undefined;
  try {
    content = readSafeStateText(address, ownerPath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
  }
  const owner = content === undefined ? undefined : parseLockOwner(content);
  if (owner) {
    if (!processIsRunning(owner.pid)) return true;
    if (!owner.identity) return false;
    const currentIdentity = readProcessIdentity(owner.pid);
    return currentIdentity !== undefined && currentIdentity !== owner.identity;
  }
  try {
    assertSafeStatePath(address, lockPath);
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs >= 60_000;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function parseLockOwner(
  content: string
): { pid: number; token?: string; identity?: string } | undefined {
  const trimmed = content.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const owner = parsed as Record<string, unknown>;
      if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return undefined;
      return {
        pid: owner.pid as number,
        ...(typeof owner.token === 'string' && owner.token.length > 0
          ? { token: owner.token }
          : {}),
        ...(typeof owner.identity === 'string' && owner.identity.length > 0
          ? { identity: owner.identity }
          : {}),
      };
    }
  } catch {}
  const pid = Number.parseInt(trimmed.split(/\s+/, 1)[0] ?? '', 10);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined;
}

function readProcessIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : undefined;
    }
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }
      ).trim();
      return output ? `win32:${output}` : undefined;
    }
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return output ? `${process.platform}:${output}` : undefined;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, 'ESRCH');
  }
}

function removeStaleLock(address: ManagedHookTransactionAddress, lockPath: string): void {
  assertSafeStatePath(address, lockPath);
  const quarantinePath = `${lockPath}.stale.${process.pid}.${randomBytes(12).toString('hex')}`;
  assertSafeStatePath(address, quarantinePath);
  fs.renameSync(lockPath, quarantinePath);
  try {
    if (!isStaleLock(address, quarantinePath)) {
      if (!lstatIfExists(lockPath)) fs.renameSync(quarantinePath, lockPath);
      throw new Error('managed hook lock owner changed during stale recovery');
    }
    for (const entry of fs.readdirSync(quarantinePath, { withFileTypes: true })) {
      const knownArtifact =
        entry.name === 'owner' ||
        /^\.owner\.[a-f0-9]{24}$/.test(entry.name) ||
        /^\.release\.\d+\.[a-f0-9]{24}$/.test(entry.name);
      if (!knownArtifact || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`unexpected managed hook lock artifact: ${entry.name}`);
      }
      const artifactPath = path.join(quarantinePath, entry.name);
      assertSafeStatePath(address, artifactPath);
      fs.unlinkSync(artifactPath);
    }
    fs.rmdirSync(quarantinePath);
  } catch (error) {
    if (lstatIfExists(quarantinePath) && !lstatIfExists(lockPath)) {
      fs.renameSync(quarantinePath, lockPath);
    }
    throw error;
  }
}

function removeEmptyOwnedLock(
  address: ManagedHookTransactionAddress,
  lockPath: string,
  token?: string
): void {
  assertSafeStatePath(address, lockPath);
  if (token) {
    const tmpPath = path.join(lockPath, `.owner.${token}`);
    if (lstatIfExists(tmpPath)) fs.unlinkSync(tmpPath);
  }
  const ownerPath = path.join(lockPath, 'owner');
  if (lstatIfExists(ownerPath)) return;
  try {
    fs.rmdirSync(lockPath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT') && !isErrorCode(error, 'ENOTEMPTY')) throw error;
  }
}

function releaseOwnedLock(
  address: ManagedHookTransactionAddress,
  lockPath: string,
  token: string
): void {
  assertSafeStatePath(address, lockPath);
  const ownerPath = path.join(lockPath, 'owner');
  const releasePath = path.join(
    lockPath,
    `.release.${process.pid}.${randomBytes(12).toString('hex')}`
  );
  assertSafeStatePath(address, ownerPath);
  assertSafeStatePath(address, releasePath);
  try {
    fs.renameSync(ownerPath, releasePath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') && !lstatIfExists(lockPath)) return;
    throw error;
  }

  try {
    const owner = parseLockOwner(readSafeStateText(address, releasePath));
    if (owner?.token !== token) {
      throw new Error('managed hook lock ownership changed before release');
    }
    fs.unlinkSync(releasePath);
    fs.rmdirSync(lockPath);
  } catch (error) {
    if (lstatIfExists(releasePath) && !lstatIfExists(ownerPath)) {
      fs.renameSync(releasePath, ownerPath);
    }
    throw error;
  }
}

function readSafeStateText(address: ManagedHookTransactionAddress, filePath: string): string {
  assertSafeStatePath(address, filePath);
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`managed hook state path is not a file: ${filePath}`);
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
