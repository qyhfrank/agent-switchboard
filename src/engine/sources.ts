import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type ComponentType,
  editSelection,
  editSourceDeclaration,
  type Homes,
  type ResolvedConfig,
  SELECTION_TYPES,
  selectedPluginIds,
} from './config.js';
import {
  assertCacheRootOwned,
  cachedEntry,
  canonicalMissingPath,
  type EntryRequest,
  isCacheRootOwned,
  materializeEntry,
  refreshEntryCache,
  removeEntryCache,
  removeEntryCachesForSource,
} from './entries.js';
import {
  abortMerge,
  credentialFreeGitUrl,
  ensureCleanTree,
  ensureGitAvailable,
  expandHome,
  gitClone,
  gitSubtreeAdd,
  gitSubtreePull,
  gitUpdate,
  hasCloneMarker,
  isGitCheckout,
  isGitRepoRoot,
  type RemoteSource,
  runGit,
  verifyClone,
  writeCloneMarker,
} from './git.js';

/**
 * Plugin sources: which directory holds a source's content, who owns it, and
 * how a managed clone becomes ready.
 *
 * Four documented forms — a local directory, a managed clone, a git subtree
 * committed into the library, and a marketplace catalog (whose entries may
 * live in repositories of their own). Resolution is deliberately partial: a
 * namespace whose ownership is ambiguous resolves to no path at all, because
 * a read that resolved onto a second generation is a read a later write would
 * act on.
 *
 * Readiness runs before anything scans: a configured clone is materialized or
 * migrated first, and a checkout that is already there is never refreshed by
 * it. Network work lives here and in `updateSources`, never in the scan.
 */

export type SourceValue = string | RemoteSource;

export interface ResolvedSource {
  namespace: string;
  /** Effective content root, subdir applied. */
  path: string;
  /** Credential-free remote declaration; object-form cloneable sources only. */
  remote?: RemoteSource;
  /** False for a source discovered by its presence under <asbHome>/plugins. */
  configured: boolean;
}

export interface SourceFailure {
  namespace: string;
  /** Configured location, when one is known despite the failure. */
  path: string | null;
  error: string;
}

export interface SourceResolution {
  sources: ResolvedSource[];
  failed: SourceFailure[];
}

export interface ReadinessRow {
  namespace: string;
  path: string;
  status: 'ready' | 'error';
  action?: 'clone' | 'migrate';
  error?: string;
}

export interface UpdateRow {
  namespace: string;
  url: string;
  status: 'updated' | 'error';
  /** An update that failed before it could refresh anything. */
  phase?: 'readiness';
  error?: string;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Local sources, subtree checkouts, and the pre-cache managed clone location. */
export function pluginsDir(homes: Homes): string {
  return path.join(homes.asbHome, 'plugins');
}

/** Managed clones are flat children of the cache root; dot names stay reserved. */
export function managedSourceDir(homes: Homes, namespace: string): string {
  return path.join(homes.cacheHome, namespace);
}

/** The pre-cache managed clone location, still owned by asb for migration only. */
function legacyCheckoutDir(homes: Homes, namespace: string): string {
  return path.join(pluginsDir(homes), namespace);
}

// ---------------------------------------------------------------------------
// Source forms
// ---------------------------------------------------------------------------

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(source);
}

/**
 * Whether an object-form url resolves through the managed cache. A local path
 * ending in `.git` is a bare repository, so it clones like any other remote.
 */
function isCloneableSource(url: string): boolean {
  return isGitUrl(url) || url.endsWith('.git');
}

/**
 * A GitHub URL split into clone URL plus the ref and subdirectory a tree URL
 * carries. Every other transport passes through unchanged.
 */
export function parseGitUrl(input: string): { url: string; ref?: string; subdir?: string } {
  const treeMatch = input.match(
    /^(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+))?$/
  );
  if (treeMatch) {
    const result: { url: string; ref?: string; subdir?: string } = {
      url: `${treeMatch[1]}.git`,
      ref: treeMatch[2],
    };
    if (treeMatch[3]) result.subdir = treeMatch[3];
    return result;
  }
  const repoMatch = input.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (repoMatch) return { url: `${repoMatch[1]}.git` };
  return { url: input };
}

/** Namespace implied by a git URL or a local path. */
export function inferSourceName(location: string): string {
  if (isGitUrl(location)) {
    const url = credentialFreeGitUrl(parseGitUrl(location).url);
    const httpsMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    const sshMatch = url.match(/:([^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
  }
  return path.basename(path.resolve(location));
}

/**
 * A string carrying a git transport scheme is the documented shorthand for a
 * clone source, parsed so a GitHub tree URL keeps its ref and subdirectory.
 * Every other string stays a user-owned local path. `type` defaults to
 * `clone`, the frozen 0.4.35 schema default every clone path guards on.
 */
function normalizeSourceValue(value: SourceValue): SourceValue {
  if (typeof value === 'string') {
    if (!isGitUrl(expandHome(value))) return value;
    const parsed = parseGitUrl(value);
    const remote: RemoteSource = { url: parsed.url, type: 'clone' };
    if (parsed.ref) remote.ref = parsed.ref;
    if (parsed.subdir) remote.subdir = parsed.subdir;
    return remote;
  }
  return value.type ? value : { ...value, type: 'clone' };
}

export function validateNamespace(namespace: string): void {
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}". Use dot-separated letters, numbers, hyphens, and underscores.`
    );
  }
}

/** Absolute stays; a bare name lives under <asbHome>/plugins; anything else is CWD-relative. */
function resolveLocalPath(homes: Homes, expanded: string): string {
  if (path.isAbsolute(expanded)) return expanded;
  if (!expanded.includes('/')) return path.join(pluginsDir(homes), expanded);
  return path.resolve(expanded);
}

type CacheOwnership = 'ignore-unowned' | 'require-owned';

/**
 * Observe a managed-cache child only through a root asb owns. Local and
 * subtree lifecycles ignore occupancy behind an unowned root; managed-clone
 * reads refuse it instead of treating foreign content as configured state.
 */
function managedCacheChildExists(
  homes: Homes,
  namespace: string,
  ownership: CacheOwnership
): boolean {
  if (!isCacheRootOwned(homes)) {
    if (ownership === 'require-owned' && fs.existsSync(managedSourceDir(homes, namespace))) {
      assertCacheRootOwned(homes);
    }
    return false;
  }
  return fs.existsSync(managedSourceDir(homes, namespace));
}

/**
 * The single directory an asb-managed source occupies, or an error naming the
 * ambiguity. A clone belongs in the machine-local cache; one still at the
 * pre-cache location stays readable until an update migrates it. A subtree
 * belongs in the synchronized library because its files are committed there,
 * so a cache checkout beside it is a second generation. A missing directory
 * resolves to its owning location so it can be created.
 */
function resolveManagedCheckoutDir(
  homes: Homes,
  namespace: string,
  type: RemoteSource['type']
): string {
  const cacheDir = managedSourceDir(homes, namespace);
  const legacyDir = legacyCheckoutDir(homes, namespace);
  const cacheExists = managedCacheChildExists(
    homes,
    namespace,
    type === 'clone' ? 'require-owned' : 'ignore-unowned'
  );

  if (type === 'subtree') {
    if (cacheExists) {
      throw new Error(
        `Source "${namespace}" is configured as subtree but also has a managed cache checkout at ${cacheDir}. Remove that checkout first, then run this command again.`
      );
    }
    return legacyDir;
  }
  if (cacheExists && fs.existsSync(legacyDir)) {
    throw new Error(
      `Source "${namespace}" exists in both the managed cache (${cacheDir}) and ${legacyDir}. Remove the copy you no longer need, then run this command again.`
    );
  }
  if (cacheExists) {
    if (!isGitCheckout(cacheDir)) {
      throw new Error(
        `Cache directory for source "${namespace}" is not an ASB-managed checkout; preserving it: ${cacheDir}`
      );
    }
    return cacheDir;
  }
  if (fs.existsSync(legacyDir)) return legacyDir;
  return cacheDir;
}

function resolveEffectivePath(homes: Homes, namespace: string, value: SourceValue): string {
  if (typeof value === 'string') return resolveLocalPath(homes, expandHome(value));
  const expanded = expandHome(value.url);
  const base = isCloneableSource(expanded)
    ? resolveManagedCheckoutDir(homes, namespace, value.type)
    : resolveLocalPath(homes, expanded);
  return value.subdir ? path.join(base, value.subdir) : base;
}

/** Every immediate non-dot child directory of <asbHome>/plugins is a source. */
function discoverLocalSources(homes: Homes): Record<string, string> {
  const root = pluginsDir(homes);
  if (!fs.existsSync(root)) return {};
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(root, entry.name);
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() && fs.statSync(child, { throwIfNoEntry: false })?.isDirectory());
    if (!isDir) continue;
    result[entry.name] = child;
  }
  return result;
}

function rawSources(config: ResolvedConfig): Record<string, SourceValue> {
  const result: Record<string, SourceValue> = {};
  for (const [namespace, value] of Object.entries(config.plugins.sources)) {
    result[namespace] = normalizeSourceValue(value as SourceValue);
  }
  return result;
}

function toResolved(namespace: string, value: SourceValue, effectivePath: string): ResolvedSource {
  const source: ResolvedSource = { namespace, path: effectivePath, configured: true };
  if (typeof value !== 'string' && isCloneableSource(expandHome(value.url))) {
    source.remote = { ...value, url: credentialFreeGitUrl(value.url) };
  }
  return source;
}

/**
 * Every source this configuration declares plus everything discovered under
 * <asbHome>/plugins, explicit declarations winning on conflict. A namespace
 * whose ownership cannot be decided fails alone: the rest of the inventory is
 * unaffected, and nothing resolves onto the ambiguous directory.
 */
export function resolveSources(config: ResolvedConfig): SourceResolution {
  const homes = config.homes;
  const merged = new Map<string, ResolvedSource>();
  for (const [namespace, discoveredPath] of Object.entries(discoverLocalSources(homes))) {
    merged.set(namespace, { namespace, path: discoveredPath, configured: false });
  }

  const failed: SourceFailure[] = [];
  for (const [namespace, value] of Object.entries(rawSources(config))) {
    try {
      validateNamespace(namespace);
      merged.set(
        namespace,
        toResolved(namespace, value, resolveEffectivePath(homes, namespace, value))
      );
    } catch (error) {
      merged.delete(namespace);
      failed.push({
        namespace,
        path: typeof value === 'string' ? value : value.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { sources: [...merged.values()], failed };
}

/**
 * Resolve one namespace on its own, so an unrelated namespace asb refuses
 * cannot preempt this one's validation and rollback.
 */
export function resolveOneSource(config: ResolvedConfig, namespace: string): ResolvedSource {
  const value = rawSources(config)[namespace];
  if (value !== undefined) {
    validateNamespace(namespace);
    return toResolved(namespace, value, resolveEffectivePath(config.homes, namespace, value));
  }
  const discovered = discoverLocalSources(config.homes)[namespace];
  if (discovered === undefined) throw new Error(`Source "${namespace}" not found.`);
  return { namespace, path: discovered, configured: false };
}

// ---------------------------------------------------------------------------
// Managed checkout ownership
// ---------------------------------------------------------------------------

/**
 * The canonical identity of the directory whose derived caches belong to this
 * source: the realpath of the deepest existing ancestor plus the missing tail.
 * It is always taken BEFORE the mutation it protects — computed afterwards it
 * names a directory that no longer exists, orphaning that source's cache
 * entries or deleting another source's.
 */
function canonicalCacheOwnerPath(value: string): string {
  return canonicalMissingPath(value);
}

/**
 * Whether asb may delete or consume a resolved managed checkout. The cache is
 * asb's exclusive tree, so a verified checkout there qualifies. The pre-cache
 * location is shared with directories the user places and owns, where a clone
 * of the same remote is indistinguishable from an asb one until the ownership
 * marker says so.
 */
function isDeletableManagedCheckout(
  homes: Homes,
  managedDir: string,
  namespace: string,
  remote: RemoteSource
): boolean {
  if (managedDir === legacyCheckoutDir(homes, namespace) && !hasCloneMarker(managedDir)) {
    return false;
  }
  return verifyClone(managedDir, namespace, remote) !== undefined;
}

/**
 * Carry a verified legacy checkout into the cache. A rename is preferred; a
 * cross-device copy stages, re-verifies both the copy and the original, and
 * only then commits — a change arriving mid-copy preserves the original.
 */
function migrateLegacyCheckout(homes: Homes, namespace: string, remote: RemoteSource): void {
  const legacyDir = legacyCheckoutDir(homes, namespace);
  if (!fs.existsSync(legacyDir)) return;
  const cacheDir = managedSourceDir(homes, namespace);
  if (!isDeletableManagedCheckout(homes, legacyDir, namespace, remote)) {
    throw new Error(`Source directory is unverified or modified; preserving it: ${legacyDir}`);
  }

  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  try {
    fs.renameSync(legacyDir, cacheDir);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }

  const stagedDir = path.join(
    path.dirname(cacheDir),
    `.${path.basename(cacheDir)}.${randomUUID()}`
  );
  try {
    fs.cpSync(legacyDir, stagedDir, { recursive: true, verbatimSymlinks: true });
    if (
      verifyClone(stagedDir, namespace, remote) === undefined ||
      verifyClone(legacyDir, namespace, remote) === undefined
    ) {
      throw new Error(`Source directory is unverified or modified; preserving it: ${legacyDir}`);
    }
    fs.renameSync(stagedDir, cacheDir);
  } catch (error) {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(legacyDir, { recursive: true, force: true });
}

type CloneIdentity = { dev: number; ino: number };

function readCloneIdentity(repoDir: string): CloneIdentity | undefined {
  const stat = fs.lstatSync(repoDir, { throwIfNoEntry: false });
  return stat?.isDirectory() && !stat.isSymbolicLink()
    ? { dev: stat.dev, ino: stat.ino }
    : undefined;
}

/** Undo a clone this command created, and only that clone. */
function rollbackClone(
  homes: Homes,
  namespace: string,
  remote: RemoteSource,
  created: CloneIdentity | undefined
): void {
  if (!created || !isCacheRootOwned(homes)) return;
  const cloneDir = managedSourceDir(homes, namespace);
  const stillOurs = (): boolean => {
    const current = readCloneIdentity(cloneDir);
    return current?.dev === created.dev && current.ino === created.ino;
  };
  if (
    !stillOurs() ||
    !hasCloneMarker(cloneDir) ||
    verifyClone(cloneDir, namespace, remote) === undefined
  ) {
    return;
  }
  // Re-check ownership and identity immediately before the delete itself.
  if (!isCacheRootOwned(homes) || !stillOurs()) return;
  fs.rmSync(cloneDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

interface Preparation extends ReadinessRow {
  previousCacheOwnerPath?: string;
  sourceChanged: boolean;
}

function prepareManagedClones(
  config: ResolvedConfig,
  opts: { dryRun: boolean; invalidateDerivedCache: boolean; only?: readonly string[] }
): Preparation[] {
  const homes = config.homes;
  const preparations: Preparation[] = [];
  let gitChecked = false;

  for (const [namespace, value] of Object.entries(rawSources(config))) {
    if (opts.only && !opts.only.includes(namespace)) continue;
    if (
      typeof value === 'string' ||
      value.type !== 'clone' ||
      !isCloneableSource(expandHome(value.url))
    ) {
      continue;
    }

    const targetPath = managedSourceDir(homes, namespace);
    let action: ReadinessRow['action'];
    let previousCacheOwnerPath: string | undefined;
    let sourceChanged = false;
    try {
      // Readiness is the one iteration that clones, so it is the one that may
      // never take a namespace on trust: the grammar is what keeps every
      // derived path inside a root asb owns.
      validateNamespace(namespace);
      assertCacheRootOwned(homes);
      previousCacheOwnerPath = canonicalCacheOwnerPath(
        resolveEffectivePath(homes, namespace, value)
      );
      // A checkout that is already there is ready: readiness materializes, it
      // never refreshes.
      if (fs.existsSync(targetPath)) {
        preparations.push({
          namespace,
          path: targetPath,
          status: 'ready',
          previousCacheOwnerPath,
          sourceChanged,
        });
        continue;
      }

      action = fs.existsSync(legacyCheckoutDir(homes, namespace)) ? 'migrate' : 'clone';
      if (!gitChecked) {
        ensureGitAvailable();
        gitChecked = true;
      }

      if (opts.dryRun) {
        // A preview only probes whether the migration could happen.
        if (
          action === 'migrate' &&
          !isDeletableManagedCheckout(homes, legacyCheckoutDir(homes, namespace), namespace, value)
        ) {
          throw new Error(
            `Source directory is unverified or modified; preserving it: ${legacyCheckoutDir(homes, namespace)}`
          );
        }
      } else {
        if (opts.invalidateDerivedCache) removeEntryCachesForSource(homes, namespace);
        if (action === 'migrate') migrateLegacyCheckout(homes, namespace, value);
        else gitClone(expandHome(value.url), targetPath, namespace, value.ref);
        sourceChanged = true;
        assertCacheRootOwned(homes);
        if (verifyClone(targetPath, namespace, value) === undefined) {
          throw new Error(
            `Source directory is unverified or modified after ${action}: ${targetPath}`
          );
        }
      }

      preparations.push({
        namespace,
        path: targetPath,
        status: 'ready',
        action,
        previousCacheOwnerPath,
        sourceChanged,
      });
    } catch (error) {
      // One broken source never blocks the healthy ones.
      preparations.push({
        namespace,
        path: targetPath,
        status: 'error',
        action,
        error: error instanceof Error ? error.message : String(error),
        previousCacheOwnerPath,
        sourceChanged,
      });
    }
  }

  return preparations;
}

/**
 * Materialize or migrate configured managed clones without refreshing what is
 * already there. Only sources that needed an action or failed are reported; a
 * source already ready is silent.
 */
export function ensureSourcesReady(
  config: ResolvedConfig,
  opts: { dryRun?: boolean; only?: readonly string[] } = {}
): ReadinessRow[] {
  const dryRun = opts.dryRun === true;
  return prepareManagedClones(config, {
    dryRun,
    invalidateDerivedCache: !dryRun,
    only: opts.only,
  })
    .filter((preparation) => preparation.action || preparation.status === 'error')
    .map(({ namespace, path: targetPath, status, action, error }) => ({
      namespace,
      path: targetPath,
      status,
      action,
      error,
    }));
}

/**
 * Refresh managed sources over the network. A subtree pulls into the library
 * repository; a clone is verified before it is touched and re-markered after,
 * and derived entry caches follow the source when its identity moves.
 */
export function updateSources(
  config: ResolvedConfig,
  opts: { only?: readonly string[] } = {}
): UpdateRow[] {
  const homes = config.homes;
  const raw = rawSources(config);
  const results: UpdateRow[] = [];
  const preparations = new Map(
    prepareManagedClones(config, {
      dryRun: false,
      invalidateDerivedCache: false,
      only: opts.only,
    }).map((preparation) => [preparation.namespace, preparation])
  );
  let gitChecked = false;

  for (const [namespace, value] of Object.entries(raw)) {
    if (opts.only && !opts.only.includes(namespace)) continue;
    if (typeof value === 'string' || !isCloneableSource(expandHome(value.url))) continue;

    try {
      validateNamespace(namespace);
      const preparation = preparations.get(namespace);
      if (value.type === 'clone' && !preparation) continue;
      if (preparation?.status === 'error') {
        results.push({
          namespace,
          url: credentialFreeGitUrl(value.url),
          status: 'error',
          phase: 'readiness',
          error: preparation.error,
        });
        continue;
      }
      const previousCacheOwnerPath =
        preparation?.previousCacheOwnerPath ??
        canonicalCacheOwnerPath(resolveEffectivePath(homes, namespace, value));
      if (!gitChecked) {
        ensureGitAvailable();
        gitChecked = true;
      }

      if (value.type === 'subtree') {
        updateSubtree(homes, namespace, value);
      } else if (preparation?.action !== 'clone') {
        // Readiness just created this one; anything else must verify first.
        const cloneDir = managedSourceDir(homes, namespace);
        const verification = verifyClone(cloneDir, namespace, value);
        if (verification === undefined) {
          throw new Error(`Source directory is unverified or modified; preserving it: ${cloneDir}`);
        }
        gitUpdate(cloneDir, value.url, value.ref, verification === 'detached');
        writeCloneMarker(cloneDir, namespace, value);
      }

      // Derived entry caches are keyed by the source's canonical owner path;
      // when that moved, the old key is dropped rather than orphaned.
      const effectivePath = resolveEffectivePath(homes, namespace, value);
      const cacheOwnerPath = canonicalCacheOwnerPath(effectivePath);
      if (previousCacheOwnerPath !== cacheOwnerPath) {
        removeEntryCache(homes, namespace, previousCacheOwnerPath);
      }
      if (marketplaceManifest(effectivePath))
        refreshSourceEntryCache(homes, namespace, effectivePath);
      else removeEntryCache(homes, namespace, effectivePath);

      results.push({ namespace, url: credentialFreeGitUrl(value.url), status: 'updated' });
    } catch (error) {
      results.push({
        namespace,
        url: credentialFreeGitUrl(value.url),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/** Namespaces a refresh would reach over the network, in config order. */
export function refreshableSources(config: ResolvedConfig): string[] {
  return Object.entries(rawSources(config))
    .filter(([, value]) => typeof value !== 'string' && isCloneableSource(expandHome(value.url)))
    .map(([namespace]) => namespace);
}

function updateSubtree(homes: Homes, namespace: string, value: RemoteSource): void {
  if (!isGitRepoRoot(homes.asbHome)) {
    throw new Error(
      `Source "${namespace}" is configured as subtree but ASB_HOME is not a git repo root.`
    );
  }
  if (!value.ref) {
    throw new Error(`Subtree source "${namespace}" requires an explicit "ref" in config.toml.`);
  }
  ensureCleanTree(homes.asbHome);
  const prefix = `plugins/${namespace}`;
  if (!fs.existsSync(path.join(homes.asbHome, prefix))) {
    gitSubtreeAdd(homes.asbHome, prefix, expandHome(value.url), value.ref);
    return;
  }
  try {
    gitSubtreePull(homes.asbHome, prefix, expandHome(value.url), value.ref);
  } catch (error) {
    abortMerge(homes.asbHome);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Add and remove
// ---------------------------------------------------------------------------

function namespaceIsTaken(
  config: ResolvedConfig,
  namespace: string,
  ownership: CacheOwnership
): boolean {
  return (
    namespace in config.plugins.sources ||
    fs.existsSync(legacyCheckoutDir(config.homes, namespace)) ||
    managedCacheChildExists(config.homes, namespace, ownership)
  );
}

function ensureNamespaceAvailable(
  config: ResolvedConfig,
  namespace: string,
  ownership: CacheOwnership = 'ignore-unowned'
): void {
  if (namespaceIsTaken(config, namespace, ownership)) {
    throw new Error(
      `Source "${namespace}" already exists. Use a different name or remove it first.`
    );
  }
}

/**
 * Declare a local directory as a source. A directory already sitting at
 * <asbHome>/plugins/<namespace> is discovered by its presence and needs no
 * declaration, so that namespace is reported as taken rather than redeclared.
 */
export function addLocalSource(
  config: ResolvedConfig,
  namespace: string,
  libraryPath: string,
  env?: NodeJS.ProcessEnv
): void {
  const resolvedPath = path.resolve(libraryPath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Path does not exist: ${resolvedPath}`);
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }
  validateNamespace(namespace);
  ensureNamespaceAvailable(config, namespace);
  editSourceDeclaration({ namespace, value: resolvedPath, env });
}

/**
 * Materialize a remote source and declare it. A failing config write undoes
 * exactly what this call created and nothing else.
 */
export function addRemoteSource(
  config: ResolvedConfig,
  namespace: string,
  remote: RemoteSource,
  env?: NodeJS.ProcessEnv
): void {
  const { declaration, rollback } = prepareRemoteSource(config, namespace, remote);
  try {
    const value: Record<string, string> = { url: declaration.url };
    if (declaration.type) value.type = declaration.type;
    if (declaration.ref) value.ref = declaration.ref;
    if (declaration.subdir) value.subdir = declaration.subdir;
    editSourceDeclaration({ namespace, value, env });
  } catch (error) {
    rollback();
    throw error;
  }
}

function prepareRemoteSource(
  config: ResolvedConfig,
  namespace: string,
  remote: RemoteSource
): { declaration: RemoteSource; rollback: () => void } {
  const homes = config.homes;
  validateNamespace(namespace);
  ensureNamespaceAvailable(
    config,
    namespace,
    remote.type === 'subtree' ? 'ignore-unowned' : 'require-owned'
  );
  ensureGitAvailable();

  let rollback = (): void => {};

  if (remote.type === 'subtree') {
    if (!isGitRepoRoot(homes.asbHome)) {
      throw new Error(
        'Subtree mode requires ASB_HOME to be a git repo root. Current ASB_HOME is not a git repo or is a subdirectory of one.'
      );
    }
    if (!remote.ref) {
      throw new Error('Subtree sources require an explicit "ref" (e.g. ref = "main").');
    }
    ensureCleanTree(homes.asbHome);
    const headBefore = runGit(['rev-parse', 'HEAD'], { cwd: homes.asbHome });
    gitSubtreeAdd(homes.asbHome, `plugins/${namespace}`, expandHome(remote.url), remote.ref);
    rollback = () => {
      try {
        runGit(['reset', '--hard', headBefore], { cwd: homes.asbHome });
      } catch {
        // best-effort rollback
      }
    };
  } else {
    assertCacheRootOwned(homes);
    const cloneDir = managedSourceDir(homes, namespace);
    gitClone(expandHome(remote.url), cloneDir, namespace, remote.ref);
    const created = readCloneIdentity(cloneDir);
    rollback = () => rollbackClone(homes, namespace, remote, created);
  }

  // The persisted URL is always credential-free; the type is persisted as
  // requested, so a declaration always says what it is.
  const declaration: RemoteSource = {
    url: credentialFreeGitUrl(remote.url),
    type: remote.type,
  };
  if (remote.ref) declaration.ref = remote.ref;
  if (remote.subdir) declaration.subdir = remote.subdir;
  return { declaration, rollback };
}

/**
 * Retire a source: its managed content, its declaration, its derived caches,
 * and the selection entries it put there. A subtree's files leave the git
 * index before the config edit, so a failing write cannot leave the library
 * half-removed; the retired ids are reported so the edit is never silent.
 */
export function removeSource(
  config: ResolvedConfig,
  namespace: string,
  opts: {
    componentIds?: readonly string[];
    pluginIds?: readonly string[];
    env?: NodeJS.ProcessEnv;
  } = {}
): { retired: { type: ComponentType | 'plugins' | 'native_plugins'; id: string }[] } {
  const { cacheOwnerPath, rollback } = removeSourceContent(config, namespace);
  try {
    editSourceDeclaration({ namespace, env: opts.env });
  } catch (error) {
    rollback();
    throw error;
  }
  finishRemoveSource(config.homes, namespace, cacheOwnerPath);
  return {
    retired: retireSourceSelection(
      config,
      namespace,
      opts.componentIds ?? [],
      opts.pluginIds ?? [],
      opts.env
    ),
  };
}

/**
 * Splice this source's ids out of every enabled list that carries them: the
 * global lists, the plugin list, and the per-app overrides. Between them
 * those are every channel `effectiveSelection` reads, which is what makes
 * this the step that has to come before the source stops being renderable.
 * The comparison runs on canonical ids while the edit names the spelling the
 * user wrote, so an entry enabled through a bare alias retires too.
 */
export function retireSourceSelection(
  config: ResolvedConfig,
  namespace: string,
  componentIds: readonly string[],
  pluginIds: readonly string[],
  env: NodeJS.ProcessEnv | undefined
): { type: ComponentType | 'plugins' | 'native_plugins'; id: string }[] {
  const expansion = config.plugins.expansion;
  const retired: { type: ComponentType | 'plugins' | 'native_plugins'; id: string }[] = [];
  // An id spelled `name@<namespace>` names this source even when the source
  // never resolved, so no catalog row could enumerate it.
  const spelledPlugin = (ref: string): boolean => ref.endsWith(`@${namespace}`);
  const spelledComponent = (ref: string): boolean => ref.includes(`@${namespace}:`);

  const wantedComponents = new Set(componentIds);
  for (const type of SELECTION_TYPES) {
    const hits = config.selection[type].filter(
      (ref) =>
        wantedComponents.has(expansion?.componentAliases[ref] ?? ref) || spelledComponent(ref)
    );
    if (hits.length === 0) continue;
    editSelection({ type, disable: hits, env });
    for (const id of hits) retired.push({ type, id });
  }

  const wantedPlugins = new Set(pluginIds);
  const pluginMatch = (ref: string): boolean =>
    wantedPlugins.has(expansion?.pluginAliases[ref] ?? ref) || spelledPlugin(ref);
  const pluginHits = config.selection.plugins.filter(pluginMatch);
  if (pluginHits.length > 0) {
    editSelection({ type: 'plugins', disable: pluginHits, env });
    for (const id of pluginHits) retired.push({ type: 'plugins', id });
  }

  const userApps = config.layers.find((layer) => layer.kind === 'user')?.values.applications ?? {};
  for (const [app, override] of Object.entries(userApps)) {
    if (Array.isArray(override) || typeof override !== 'object' || override === null) continue;
    const native = (override as { native_plugins?: { enabled?: string[] } }).native_plugins;
    const hits = (native?.enabled ?? []).filter(pluginMatch);
    if (hits.length > 0) {
      editSelection({ type: 'native_plugins', app, disable: hits, env });
      for (const id of hits) retired.push({ type: 'native_plugins', id });
    }
    // The per-app plugin cell feeds the same expansion the global list does,
    // so a plugin enabled only here still expands to components.
    const perApp = (override as { plugins?: { enabled?: string[]; add?: string[] } }).plugins;
    const perAppPlugins = [...(perApp?.enabled ?? []), ...(perApp?.add ?? [])].filter(pluginMatch);
    if (perAppPlugins.length > 0) {
      editSelection({ type: 'plugins', app, disable: perAppPlugins, env });
      for (const id of perAppPlugins) retired.push({ type: 'plugins', id });
    }
    // A per-app override selects for that app alone, in any of its three
    // spellings, and an id left in one of them is still distributed.
    for (const type of SELECTION_TYPES) {
      const cell = (override as Record<string, { enabled?: string[]; add?: string[] }>)[type];
      if (!cell || typeof cell !== 'object') continue;
      const componentHits = [...(cell.enabled ?? []), ...(cell.add ?? [])].filter(
        (ref) =>
          wantedComponents.has(expansion?.componentAliases[ref] ?? ref) || spelledComponent(ref)
      );
      if (componentHits.length === 0) continue;
      editSelection({ type, app, disable: componentHits, env });
      for (const id of componentHits) retired.push({ type, id });
    }
  }

  return retired;
}

function removeSourceContent(
  config: ResolvedConfig,
  namespace: string
): { cacheOwnerPath: string; rollback: () => void } {
  const homes = config.homes;
  const raw = rawSources(config);
  if (!(namespace in raw)) throw new Error(`Source "${namespace}" not found.`);

  const value = raw[namespace];
  const cloneable = typeof value !== 'string' && isCloneableSource(expandHome(value.url));
  if (cloneable && (value as RemoteSource).type === 'clone') assertCacheRootOwned(homes);

  // Taken before anything is deleted: afterwards it names a directory that no
  // longer exists.
  const cacheOwnerPath = canonicalCacheOwnerPath(resolveEffectivePath(homes, namespace, value));
  let rollback = (): void => {};

  if (cloneable) {
    const remote = value as RemoteSource;
    if (remote.type === 'subtree') {
      const subtreeDir = resolveManagedCheckoutDir(homes, namespace, 'subtree');
      if (!isGitRepoRoot(homes.asbHome)) {
        throw new Error(
          `Source "${namespace}" is configured as subtree but ASB_HOME is not a git repo root. Cannot safely remove.`
        );
      }
      if (fs.existsSync(subtreeDir)) {
        ensureCleanTree(homes.asbHome);
        try {
          runGit(['rm', '-r', `plugins/${namespace}`], { cwd: homes.asbHome });
        } catch (error) {
          throw new Error(
            `Failed to git rm subtree "plugins/${namespace}": ${error instanceof Error ? error.message : String(error)}`
          );
        }
        rollback = () => {
          try {
            runGit(['checkout', 'HEAD', '--', `plugins/${namespace}`], { cwd: homes.asbHome });
          } catch {
            // best-effort rollback
          }
        };
      }
    } else {
      const managedDir = resolveManagedCheckoutDir(homes, namespace, 'clone');
      if (fs.existsSync(managedDir)) {
        if (!isDeletableManagedCheckout(homes, managedDir, namespace, remote)) {
          throw new Error(
            `Source directory is unverified or modified; preserving it: ${managedDir}`
          );
        }
        fs.rmSync(managedDir, { recursive: true, force: true });
      }
    }
  }

  return { cacheOwnerPath, rollback };
}

/** Drop the derived caches a removed source owned. */
function finishRemoveSource(homes: Homes, namespace: string, cacheOwnerPath: string): void {
  removeEntryCache(homes, namespace, cacheOwnerPath);
}

export type SourceKind = 'marketplace' | 'plugin';

/** Whether a directory looks like something asb can read content out of. */
export function validateSourcePath(libraryPath: string): {
  valid: boolean;
  found: string[];
  missing: string[];
  kind: SourceKind;
} {
  const resolvedPath = path.resolve(libraryPath);
  if (marketplaceManifest(resolvedPath)) {
    return { valid: true, found: ['marketplace'], missing: [], kind: 'marketplace' };
  }
  if (pluginManifest(resolvedPath)) {
    return { valid: true, found: ['plugin'], missing: [], kind: 'plugin' };
  }

  const found: string[] = [];
  const missing: string[] = [];
  for (const type of ['rules', 'commands', 'agents', 'skills', 'hooks']) {
    const typePath = path.join(resolvedPath, type);
    if (fs.existsSync(typePath) && fs.statSync(typePath).isDirectory()) found.push(type);
    else missing.push(type);
  }
  return { valid: found.length > 0, found, missing, kind: 'plugin' };
}

// ---------------------------------------------------------------------------
// Marketplace catalogs
// ---------------------------------------------------------------------------

export type NativeTarget = 'claude-code' | 'codex';

const MARKETPLACE_MANIFESTS: ReadonlyArray<{ relative: string; target: NativeTarget }> = [
  { relative: '.claude-plugin/marketplace.json', target: 'claude-code' },
  { relative: '.agents/plugins/marketplace.json', target: 'codex' },
  { relative: '.agents/plugins/api_marketplace.json', target: 'codex' },
];

const PLUGIN_MANIFESTS: ReadonlyArray<{ relative: string; target: NativeTarget }> = [
  { relative: '.claude-plugin/plugin.json', target: 'claude-code' },
  { relative: '.codex-plugin/plugin.json', target: 'codex' },
];

export interface ManifestInfo {
  path: string;
  target: NativeTarget;
}

export function marketplaceManifest(root: string): ManifestInfo | undefined {
  for (const manifest of MARKETPLACE_MANIFESTS) {
    const manifestPath = path.join(root, manifest.relative);
    if (fs.existsSync(manifestPath)) return { path: manifestPath, target: manifest.target };
  }
  return undefined;
}

export function pluginManifest(root: string, target?: NativeTarget): ManifestInfo | undefined {
  for (const manifest of PLUGIN_MANIFESTS) {
    if (target && manifest.target !== target) continue;
    const manifestPath = path.join(root, manifest.relative);
    if (fs.existsSync(manifestPath)) return { path: manifestPath, target: manifest.target };
  }
  return undefined;
}

export interface PluginDescriptor {
  /** `<name>@<source>` for a marketplace entry; the namespace itself otherwise. */
  id: string;
  name: string;
  /** Owning source namespace. */
  source: string;
  /** Content root; absent when an external entry is not materialized yet. */
  root?: string;
  /** What materializing this entry would fetch. */
  request?: EntryRequest;
  /** Component paths that replace the default directory scan. */
  customPaths?: { commands?: string[]; agents?: string[]; skills?: string[] };
  mcpServers?: Record<string, unknown>;
  description?: string;
  version?: string;
  /** Native plugin manager metadata, for sources an app's own manager installs. */
  native?: NativeMeta;
}

/**
 * What an app's own plugin manager needs to know. `manifestPath` is the
 * plugin's own manifest, when it ships one; `install` is present exactly when
 * the manager can register and install this plugin — a catalogued entry of a
 * marketplace the manager understands.
 */
export interface NativeMeta {
  target: NativeTarget;
  manifestPath?: string;
  install?: {
    /** Registration name: the marketplace manifest's own `name`. */
    marketplaceName: string;
    /** Directory holding the marketplace manifest. */
    marketplacePath: string;
    pluginName: string;
    /** `<plugin>@<marketplace>` — how the manager is told to install it. */
    ref: string;
    /** Credential-free remote declaration, when the marketplace is a clone. */
    remote?: RemoteSource;
    /** Bare Codex plugins are wrapped into an ASB-owned local marketplace. */
    sourcePath?: string;
    version?: string;
    managedWrapper?: boolean;
  };
}

export interface SourcePlugins {
  plugins: PluginDescriptor[];
  /** Entries the catalog declares that could not be read. */
  failed: SourceFailure[];
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function stringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Lexical AND realpath containment for a marketplace-relative plugin directory. */
function resolveInside(root: string, subpath: string): string | null {
  const resolved = path.resolve(root, subpath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(resolved));
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function githubCloneUrl(value: string): string | undefined {
  if (!value.includes('/')) return undefined;
  const url =
    /^(https?|ssh|git):\/\//.test(value) || /^[^@/\s]+@[^:\s]+:.+/.test(value)
      ? value
      : `https://github.com/${value}`;
  return url.endsWith('.git') ? url : `${url}.git`;
}

function normalizeCloneUrl(value: string, marketplaceRoot: string): string {
  const expanded = expandHome(value.trim());
  if (/^(https?|ssh|git):\/\//.test(expanded) || /^[^@/\s]+@[^:\s]+:.+/.test(expanded)) {
    return expanded;
  }
  if (expanded.startsWith('file://')) return expanded.slice('file://'.length);
  if (path.isAbsolute(expanded)) return expanded;
  if (expanded.startsWith('./') || expanded.startsWith('../') || expanded.endsWith('.git')) {
    return path.resolve(marketplaceRoot, expanded);
  }
  return expanded;
}

function gitSourceOf(
  source: Record<string, unknown>,
  marketplaceRoot: string
): { url: string; subdir?: string } | null {
  let url: string | undefined;
  if (typeof source.url === 'string') url = source.url;
  else if (typeof source.git === 'string') url = source.git;
  else if (typeof source.github === 'string') url = githubCloneUrl(source.github);
  else if (source.source === 'github' && typeof source.repo === 'string') {
    url = githubCloneUrl(source.repo);
  }
  if (!url) return null;
  return {
    url: normalizeCloneUrl(url, marketplaceRoot),
    subdir: typeof source.path === 'string' ? source.path : undefined,
  };
}

/**
 * Read what a source contributes. A directory holding a marketplace manifest
 * contributes one plugin per catalogued entry; anything else is a single
 * plugin named after the namespace.
 *
 * External entries — those living in a repository of their own — are
 * catalogued with the request that would fetch them and resolve to a root
 * only when that fetch already happened. Reading a catalog never touches the
 * network, so no command pays for a plugin nobody selected.
 */
export function readSourcePlugins(homes: Homes, namespace: string, root: string): SourcePlugins {
  const manifestInfo = marketplaceManifest(root);
  if (!manifestInfo) {
    const descriptor: PluginDescriptor = {
      id: namespace,
      name: namespace,
      source: namespace,
      root,
    };
    const native = pluginManifest(root);
    let manifestServers: unknown;
    if (native) {
      descriptor.native = { target: native.target, manifestPath: native.path };
      const manifest = record(safeReadJson(native.path));
      if (typeof manifest?.name === 'string') descriptor.name = manifest.name;
      if (typeof manifest?.description === 'string') descriptor.description = manifest.description;
      if (typeof manifest?.version === 'string') descriptor.version = manifest.version;
      const custom = customPathsOf(manifest);
      if (custom) descriptor.customPaths = custom;
      manifestServers = manifest?.mcpServers;
    }
    const servers = pluginMcpServers(root, manifestServers);
    if (servers) descriptor.mcpServers = servers;
    return { plugins: [descriptor], failed: [] };
  }

  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = record(readJson(manifestInfo.path));
  } catch (error) {
    return {
      plugins: [],
      failed: [
        {
          namespace,
          path: manifestInfo.path,
          error: `marketplace manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  const entries = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
  const pluginRoot =
    typeof record(manifest?.metadata)?.pluginRoot === 'string'
      ? (record(manifest?.metadata)?.pluginRoot as string)
      : '';
  // The manager registers a marketplace under the name its manifest declares,
  // which is not always the namespace asb files it under.
  const marketplace = {
    target: manifestInfo.target,
    name: typeof manifest?.name === 'string' ? manifest.name : namespace,
    path: root,
  };

  const plugins: PluginDescriptor[] = [];
  const failed: SourceFailure[] = [];
  for (const raw of entries) {
    const entry = record(raw);
    const name = typeof entry?.name === 'string' ? entry.name : undefined;
    if (!entry || !name) {
      failed.push({ namespace, path: manifestInfo.path, error: 'marketplace entry has no name' });
      continue;
    }
    if (
      name === '.' ||
      name === '..' ||
      name.includes('\0') ||
      path.posix.basename(name) !== name ||
      path.win32.basename(name) !== name
    ) {
      failed.push({
        namespace,
        path: manifestInfo.path,
        error: `plugin "${name}": name must be exactly one path segment`,
      });
      continue;
    }
    const descriptor = readCatalogEntry(
      homes,
      namespace,
      root,
      pluginRoot,
      entry,
      name,
      marketplace
    );
    if (descriptor instanceof Error) {
      failed.push({ namespace, path: manifestInfo.path, error: descriptor.message });
      continue;
    }
    plugins.push(descriptor);
  }
  return { plugins, failed };
}

function safeReadJson(filePath: string): unknown {
  try {
    return readJson(filePath);
  } catch {
    return undefined;
  }
}

/**
 * A plugin's own MCP servers, from its directory file and its manifest field.
 * `<pluginRoot>/.mcp.json` takes both the wrapped `{ mcpServers: {...} }` and
 * the flat `{ <name>: {...} }` form, and it wins: for a bare source it is the
 * only place servers can come from, so a manifest field only adds names it
 * does not already carry. An unreadable file contributes nothing.
 */
function pluginMcpServers(
  root: string | undefined,
  manifestField: unknown
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  const raw = root ? record(safeReadJson(path.join(root, '.mcp.json'))) : undefined;
  const fromFile = raw ? (record(raw.mcpServers) ?? raw) : undefined;
  for (const [name, definition] of Object.entries(fromFile ?? {})) {
    if (record(definition)) merged[name] = definition;
  }
  for (const [name, definition] of Object.entries(record(manifestField) ?? {})) {
    if (!(name in merged) && record(definition)) merged[name] = definition;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function customPathsOf(
  source: Record<string, unknown> | undefined
): PluginDescriptor['customPaths'] {
  if (!source) return undefined;
  const commands = stringArray(source.commands);
  const agents = stringArray(source.agents);
  const skills = stringArray(source.skills);
  if (!commands && !agents && !skills) return undefined;
  const custom: NonNullable<PluginDescriptor['customPaths']> = {};
  if (commands) custom.commands = commands;
  if (agents) custom.agents = agents;
  if (skills) custom.skills = skills;
  return custom;
}

function readCatalogEntry(
  homes: Homes,
  namespace: string,
  marketplaceRoot: string,
  pluginRoot: string,
  entry: Record<string, unknown>,
  name: string,
  marketplace: { target: NativeTarget; name: string; path: string }
): PluginDescriptor | Error {
  const source = entry.source;
  const id = `${name}@${namespace}`;
  let root: string | undefined;
  let request: EntryRequest | undefined;

  if (typeof source === 'string') {
    // A relative path inside the marketplace repository.
    if (!source.startsWith('./') && !source.startsWith('../') && source.includes(':')) {
      return new Error(`plugin "${name}": unsupported source type`);
    }
    const resolved = resolveInside(marketplaceRoot, path.join(pluginRoot, source));
    if (!resolved) return new Error(`plugin "${name}": source escapes the marketplace root`);
    if (!fs.existsSync(resolved))
      return new Error(`plugin "${name}": directory not found at ${resolved}`);
    root = resolved;
  } else {
    const sourceRecord = record(source);
    if (!sourceRecord) return new Error(`plugin "${name}": unsupported source type`);
    const localPath = typeof sourceRecord.path === 'string' ? sourceRecord.path : undefined;
    const isLocal =
      localPath !== undefined &&
      (sourceRecord.source === 'local' ||
        (!sourceRecord.source &&
          !sourceRecord.url &&
          !sourceRecord.git &&
          !sourceRecord.github &&
          !sourceRecord.repo));

    if (isLocal) {
      const resolved = resolveInside(marketplaceRoot, path.join(pluginRoot, localPath));
      if (!resolved) return new Error(`plugin "${name}": source escapes the marketplace root`);
      if (!fs.existsSync(resolved)) {
        return new Error(`plugin "${name}": directory not found at ${resolved}`);
      }
      root = resolved;
    } else {
      const gitSource = gitSourceOf(sourceRecord, marketplaceRoot);
      // Native-only and not-yet-supported kinds stay catalogued: they are
      // visible, and only selecting one reports that it cannot resolve.
      if (gitSource) {
        request = {
          sourceName: namespace,
          marketplacePath: marketplaceRoot,
          pluginName: name,
          url: gitSource.url,
          ref: (entry.ref as string | undefined) ?? (sourceRecord.ref as string | undefined),
          sha: (entry.sha as string | undefined) ?? (sourceRecord.sha as string | undefined),
          subdir: gitSource.subdir,
        };
        root = cachedEntry(homes, request)?.pluginPath;
      }
    }
  }

  // Strict (the default) makes the catalog entry authoritative and the
  // plugin's own manifest the fallback; strict:false inverts that.
  const manifest = root ? record(safeReadJson(pluginManifest(root)?.path ?? '')) : undefined;
  const strict = entry.strict !== false;
  const primary = strict ? entry : (manifest ?? entry);
  const fallback = strict ? (manifest ?? entry) : entry;

  const descriptor: PluginDescriptor = { id, name, source: namespace };
  if (root) descriptor.root = root;
  if (request) descriptor.request = request;
  const custom = customPathsOf(primary) ?? customPathsOf(fallback);
  if (custom) descriptor.customPaths = custom;
  const servers = pluginMcpServers(root, primary.mcpServers ?? fallback.mcpServers);
  if (servers) descriptor.mcpServers = servers;
  const description = entry.description ?? manifest?.description;
  if (typeof description === 'string') descriptor.description = description;
  const version = entry.version ?? manifest?.version;
  if (typeof version === 'string') descriptor.version = version;

  // Every catalogued entry is installable by the manager whose marketplace
  // family this is, whether or not it has been fetched: the manager fetches
  // its own copy. A plugin manifest in a materialized root adds to that.
  descriptor.native = {
    target: marketplace.target,
    install: {
      marketplaceName: marketplace.name,
      marketplacePath: marketplace.path,
      pluginName: name,
      ref: `${name}@${marketplace.name}`,
    },
  };
  const native = root ? pluginManifest(root) : undefined;
  if (native) descriptor.native.manifestPath = native.path;
  return descriptor;
}

/** A plugin whose content root is not on disk, and where asb looked for it. */
export interface AbsentPlugin {
  id: string;
  source: string;
  path: string;
  /** Credential-free remote the source declares, when it has one. */
  url?: string;
}

export interface SourceCatalog {
  sources: ResolvedSource[];
  /** Every plugin the sources contribute, in source order. */
  plugins: PluginDescriptor[];
  /** Sources and catalog entries that could not be read. */
  failed: SourceFailure[];
  /**
   * The subset of `failed` where the source itself never resolved to a
   * directory. Content asb could not read inside a resolved source is
   * contained per entry; a source with no location at all leaves the
   * inventory partial, which is a pre-write abort.
   */
  unresolved: SourceFailure[];
  /** Catalogued plugins whose content is not there — enabled or not. */
  absent: AbsentPlugin[];
}

/**
 * What the configured and discovered sources contribute right now. Reading a
 * catalog stays offline: an external entry nobody has fetched is catalogued
 * with the request that would fetch it and no content root.
 */
export function readSourceCatalog(config: ResolvedConfig): SourceCatalog {
  const resolution = resolveSources(config);
  const plugins: PluginDescriptor[] = [];
  const failed = [...resolution.failed];
  const absent: AbsentPlugin[] = [];
  for (const source of resolution.sources) {
    const read = readSourcePlugins(config.homes, source.namespace, source.path);
    for (const plugin of read.plugins) {
      if (plugin.native?.install && source.remote) plugin.native.install.remote = source.remote;
      // A configured source whose directory is gone still contributes its
      // descriptor, so what the user enabled stays visible with the place asb
      // expected to find it. An entry living in a repository of its own is
      // absent the same way until something fetches it, named by the remote
      // it would come from rather than by a cache path nobody can act on.
      if (plugin.root === undefined) {
        absent.push({
          id: plugin.id,
          source: source.namespace,
          path: plugin.request ? credentialFreeGitUrl(plugin.request.url) : source.path,
        });
      } else if (!fs.existsSync(plugin.root)) {
        const row: AbsentPlugin = {
          id: plugin.id,
          source: source.namespace,
          path: plugin.root,
        };
        if (source.remote) row.url = source.remote.url;
        absent.push(row);
      }
    }
    plugins.push(...read.plugins);
    failed.push(...read.failed);
  }
  return { sources: resolution.sources, plugins, failed, unresolved: resolution.failed, absent };
}

export interface EntryRow {
  /** Canonical plugin id of the external entry. */
  id: string;
  /** Credential-free remote it is fetched from. */
  url: string;
  status: 'fetched' | 'pending' | 'error';
  error?: string;
}

/**
 * Clone-if-missing for the external entries a selection points at, the same
 * contract managed-clone readiness follows: an entry already in the cache is
 * never refetched (that is what `--update` is for), and a preview reports what
 * it would fetch without touching the network. An entry the run cannot fetch
 * stays absent rather than silently contributing nothing.
 */
export function ensureEntriesReady(
  config: ResolvedConfig,
  catalog: SourceCatalog,
  opts: { dryRun?: boolean } = {}
): EntryRow[] {
  const selected = selectedPluginIds(config);
  const wanted = catalog.plugins.filter(
    (plugin) => plugin.request && !plugin.root && selected.has(plugin.id)
  );
  const urls = new Map(
    wanted.map((plugin) => [plugin.id, credentialFreeGitUrl(plugin.request?.url ?? '')])
  );
  if (opts.dryRun) {
    return wanted.map((plugin) => ({
      id: plugin.id,
      url: urls.get(plugin.id) ?? '',
      status: 'pending',
    }));
  }

  return materializeSourceEntries(config.homes, wanted).map((result) => {
    const url = urls.get(result.id) ?? '';
    return result.error
      ? { id: result.id, url, status: 'error' as const, error: result.error }
      : { id: result.id, url, status: 'fetched' as const };
  });
}

/** Fetch every external entry a source declares that the caller selected. */
export function materializeSourceEntries(
  homes: Homes,
  descriptors: readonly PluginDescriptor[]
): { id: string; error?: string }[] {
  const results: { id: string; error?: string }[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor.request || descriptor.root) continue;
    try {
      materializeEntry(homes, descriptor.request);
      results.push({ id: descriptor.id });
    } catch (error) {
      results.push({
        id: descriptor.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Refresh the entry caches a marketplace source still declares. */
function refreshSourceEntryCache(homes: Homes, namespace: string, root: string): void {
  const requests = readSourcePlugins(homes, namespace, root)
    .plugins.map((plugin) => plugin.request)
    .filter((request): request is EntryRequest => request !== undefined);
  refreshEntryCache(homes, namespace, root, requests);
}
