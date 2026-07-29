import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppRow, NativeManagerRow } from './apps.js';
import { effectivePlugins, type Homes, type ResolvedConfig } from './config.js';
import type { Action } from './plan.js';
import { writeFileAtomic } from './shapes.js';
import type { NativeMeta, PluginDescriptor, SourceCatalog } from './sources.js';

/**
 * The `native` apply kind: apps that ship their own plugin manager. There is
 * no file to own here — the manager owns its installs — so ownership is
 * replaced by the manager's reported state. Every run probes that state, plans
 * against it, and applies through the manager's own verbs.
 *
 * The probe is a capture like any other: read once, plan purely, execute the
 * planned command list in order. A plugin the user disabled behind asb's back
 * is drift, reported as `stale` before the next sync re-enables it, so the
 * override is visible rather than silent.
 */

export type MarketplaceSource =
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'git'; url: string; ref?: string }
  | { source: 'directory'; path: string };

/** How the manager is told to register a marketplace. */
interface Registration {
  argument: string;
  source: MarketplaceSource;
  /** The declaration travels between machines; a local path does not. */
  portable: boolean;
}

interface CodexWrapper {
  root: string;
  stateRoot: string;
  marketplaceName: string;
  pluginName: string;
  ref: string;
  sourcePath: string;
  version?: string;
}

export interface NativeAppState {
  /** Parsed `plugin marketplace list --json`. */
  marketplaces: unknown;
  /** Parsed `plugin list --json`. */
  plugins: unknown;
  /** Current settings document, or null when it is absent or unreadable. */
  settings: Record<string, unknown> | null;
  /** Per marketplace path: why `plugin validate` refused it. */
  invalid: Record<string, string>;
  /** ASB-owned bare-plugin marketplaces reconstructed from wrapper manifests. */
  managed: CodexWrapper[];
  /** Per-directory wrapper state that could not be recognized safely. */
  wrapperErrors: { root: string; error: string }[];
  /** Why the manager could not be probed at all. */
  error?: string;
}

export type NativeCapture = Record<string, NativeAppState>;

/** Work for one native row: manager verbs first, then the registration setting. */
export interface NativeWork {
  bin: string;
  /**
   * The run's environment. The manager is found on this PATH, so a caller that
   * scoped the run to a different environment reaches the same manager the
   * rest of the run did.
   */
  env: NodeJS.ProcessEnv;
  /** Manager invocations, in order; the first failure stops the rest. */
  commands: string[][];
  /** Commands that restore the previous registration when one of the above fails. */
  compensate: string[][];
  /**
   * Registration setting to reconcile once the manager work lands; null when
   * it already says what it should. A `source` of null removes the key.
   */
  setting: { path: string; marketplace: string; source: MarketplaceSource | null } | null;
  /** Bare Codex plugin wrapper to materialize before manager verbs. */
  prepare?: CodexWrapper;
  /** ASB-owned wrapper root to remove after manager verbs. */
  cleanup?: { root: string; stateRoot: string };
}

export type NativeCommandRunner = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
) => { status: number; stdout: string; stderr: string };

function run(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(bin, [...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
    timeout: 120_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

function runRequired(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  runner: NativeCommandRunner = run
): string {
  const result = runner(bin, args, env);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${bin} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

function readManagerJson(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  runner: NativeCommandRunner = run
): unknown {
  const text = runRequired(bin, args, env, runner).trim();
  if (!text) throw new Error(`${bin} ${args.join(' ')} returned invalid JSON: empty stdout`);
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${bin} ${args.join(' ')} returned invalid JSON: ${detail}`);
  }
}

/**
 * Every object anywhere in the reported JSON. The managers' output shapes are
 * not contracts, so matching walks the whole tree instead of pinning a schema
 * that a manager release would break.
 */
function collectObjects(value: unknown, out: Record<string, unknown>[] = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const entry = value as Record<string, unknown>;
    out.push(entry);
    for (const child of Object.values(entry)) {
      if (child !== null && typeof child === 'object') collectObjects(child, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

type Install = NonNullable<NativeMeta['install']>;

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-') || 'plugin';
}

function codexStateRoot(homes: Homes): string {
  return path.join(homes.asbHome, 'state', 'native-plugins', 'codex');
}

function hasCodexWrapperState(homes: Homes): boolean {
  const root = codexStateRoot(homes);
  try {
    return fs.readdirSync(root).length > 0;
  } catch {
    return fs.existsSync(root);
  }
}

function bareCodexInstall(plugin: PluginDescriptor, homes: Homes): Install | undefined {
  if (plugin.native?.target !== 'codex' || plugin.native.install || !plugin.root) return undefined;
  const manifestPath = plugin.native.manifestPath;
  if (!manifestPath) return undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) return undefined;
    const marketplaceName = plugin.id;
    return {
      marketplaceName,
      marketplacePath: path.join(codexStateRoot(homes), safeSegment(plugin.id)),
      pluginName: manifest.name,
      ref: `${manifest.name}@${marketplaceName}`,
      sourcePath: plugin.root,
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
      managedWrapper: true,
    };
  } catch {
    return undefined;
  }
}

function installFor(plugin: PluginDescriptor, homes: Homes): Install | undefined {
  return plugin.native?.install ?? bareCodexInstall(plugin, homes);
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readCodexWrappers(homes: Homes): {
  managed: CodexWrapper[];
  errors: { root: string; error: string }[];
} {
  const stateRoot = codexStateRoot(homes);
  if (!fs.existsSync(stateRoot)) return { managed: [], errors: [] };
  const managed: CodexWrapper[] = [];
  const errors: { root: string; error: string }[] = [];
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(stateRoot, entry.name);
    try {
      const manifestPath = path.join(root, '.agents', 'plugins', 'marketplace.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        name?: unknown;
        plugins?: unknown;
      };
      if (
        typeof manifest.name !== 'string' ||
        !Array.isArray(manifest.plugins) ||
        manifest.plugins.length !== 1
      ) {
        throw new Error(`unrecognized ASB Codex wrapper at ${root}`);
      }
      const plugin = manifest.plugins[0] as { name?: unknown; source?: unknown };
      if (
        typeof plugin.name !== 'string' ||
        typeof plugin.source !== 'string' ||
        !plugin.source.startsWith('./plugins/')
      ) {
        throw new Error(`unrecognized ASB Codex wrapper at ${root}`);
      }
      const link = path.resolve(root, plugin.source);
      if (!contained(root, link)) throw new Error(`ASB Codex wrapper escapes its root at ${root}`);
      managed.push({
        root,
        stateRoot,
        marketplaceName: manifest.name,
        pluginName: plugin.name,
        ref: `${plugin.name}@${manifest.name}`,
        sourcePath: realPath(link),
      });
    } catch (error) {
      errors.push({ root, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { managed, errors };
}

function materializeCodexWrapper(wrapper: CodexWrapper): void {
  if (!contained(wrapper.stateRoot, wrapper.root)) {
    throw new Error(`refusing to write Codex wrapper outside ASB state: ${wrapper.root}`);
  }
  const manifestDir = path.join(wrapper.root, '.agents', 'plugins');
  const pluginsDir = path.join(wrapper.root, 'plugins');
  const link = path.join(pluginsDir, safeSegment(wrapper.pluginName));
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink() && !(process.platform === 'win32' && stat.isDirectory())) {
      throw new Error(`refusing to replace non-link Codex wrapper member: ${link}`);
    }
    fs.rmSync(link, { recursive: true, force: true });
  }
  fs.symlinkSync(wrapper.sourcePath, link, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileAtomic(
    path.join(manifestDir, 'marketplace.json'),
    `${JSON.stringify(
      {
        name: wrapper.marketplaceName,
        plugins: [
          { name: wrapper.pluginName, source: `./plugins/${safeSegment(wrapper.pluginName)}` },
        ],
      },
      null,
      2
    )}\n`
  );
}

interface CodexWrapperSnapshot {
  link: string;
  linkTarget: string | null;
  manifestPath: string;
  manifest: Buffer | null;
}

function snapshotCodexWrapper(wrapper: CodexWrapper): CodexWrapperSnapshot {
  const link = path.join(wrapper.root, 'plugins', safeSegment(wrapper.pluginName));
  const manifestPath = path.join(wrapper.root, '.agents', 'plugins', 'marketplace.json');
  return {
    link,
    linkTarget: fs.lstatSync(link, { throwIfNoEntry: false }) ? fs.readlinkSync(link) : null,
    manifestPath,
    manifest: fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null,
  };
}

function restoreCodexWrapper(snapshot: CodexWrapperSnapshot): void {
  fs.rmSync(snapshot.link, { recursive: true, force: true });
  if (snapshot.linkTarget !== null) {
    fs.mkdirSync(path.dirname(snapshot.link), { recursive: true });
    fs.symlinkSync(
      snapshot.linkTarget,
      snapshot.link,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  }
  if (snapshot.manifest === null) fs.rmSync(snapshot.manifestPath, { force: true });
  else writeFileAtomic(snapshot.manifestPath, snapshot.manifest);
}

function githubRepo(url: string): string | undefined {
  const match = url.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/#]+?)(?:\.git)?\/?$/
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * A marketplace whose whole repository is the catalog registers portably — the
 * manager clones it itself on any machine. A local directory, or a remote
 * whose catalog is one subdirectory, can only be named by its path here.
 */
function registrationFor(install: Install): Registration {
  const remote = install.remote;
  if (remote && !remote.subdir && /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(remote.url)) {
    const repo = githubRepo(remote.url);
    if (repo) {
      return {
        argument: `${repo}${remote.ref ? `@${remote.ref}` : ''}`,
        source: { source: 'github', repo, ...(remote.ref ? { ref: remote.ref } : {}) },
        portable: true,
      };
    }
    return {
      argument: `${remote.url}${remote.ref ? `#${remote.ref}` : ''}`,
      source: { source: 'git', url: remote.url, ...(remote.ref ? { ref: remote.ref } : {}) },
      portable: true,
    };
  }
  return {
    argument: install.marketplacePath,
    source: { source: 'directory', path: install.marketplacePath },
    portable: false,
  };
}

function findMarketplace(state: unknown, name: string): Record<string, unknown> | undefined {
  return collectObjects(state).find(
    (entry) => entry.name === name || entry.marketplaceName === name
  );
}

function findPlugin(
  state: unknown,
  install: Pick<Install, 'marketplaceName' | 'pluginName' | 'ref'>
): Record<string, unknown> | undefined {
  return collectObjects(state).find((entry) => {
    if (entry.pluginId === install.ref || entry.id === install.ref || entry.ref === install.ref) {
      return true;
    }
    const marketplace =
      entry.marketplaceName ?? entry.marketplace ?? entry.marketplaceId ?? entry.sourceMarketplace;
    return entry.name === install.pluginName && marketplace === install.marketplaceName;
  });
}

function declaredSource(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.marketplaceSource && typeof entry.marketplaceSource === 'object') {
    return entry.marketplaceSource as Record<string, unknown>;
  }
  if (entry.source && typeof entry.source === 'object') {
    return entry.source as Record<string, unknown>;
  }
  if (typeof entry.source !== 'string') return undefined;
  const source: Record<string, unknown> = { source: entry.source };
  for (const key of ['repo', 'url', 'ref', 'path']) {
    if (typeof entry[key] === 'string') source[key] = entry[key];
  }
  return source;
}

function realPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sourceMatches(
  actual: Record<string, unknown> | undefined,
  expected: MarketplaceSource
): boolean {
  if (!actual || actual.source !== expected.source) return false;
  switch (expected.source) {
    case 'github':
      return actual.repo === expected.repo && actual.ref === expected.ref;
    case 'git':
      return actual.url === expected.url && actual.ref === expected.ref;
    case 'directory':
      return typeof actual.path === 'string' && realPath(actual.path) === realPath(expected.path);
  }
}

function isDisabled(entry: Record<string, unknown>): boolean {
  if (entry.enabled === false || entry.disabled === true) return true;
  return typeof entry.status === 'string' && entry.status.toLowerCase() === 'disabled';
}

/**
 * The native refs an app enables, resolved against the catalog. A ref names a
 * plugin id, or the install ref the manager itself uses; either way it must
 * resolve to a plugin of this manager's own marketplace family.
 */
export function resolveNativeRefs(
  catalog: SourceCatalog,
  row: NativeManagerRow,
  refs: readonly string[],
  homes: Homes
): { ref: string; plugin?: PluginDescriptor; install?: Install; error?: string }[] {
  const byId = new Map<string, PluginDescriptor>();
  const byInstallRef = new Map<string, PluginDescriptor>();
  for (const plugin of catalog.plugins) {
    if (plugin.native?.target !== row.target) continue;
    byId.set(plugin.id, plugin);
    const install = installFor(plugin, homes);
    if (install) byInstallRef.set(install.ref, plugin);
  }

  return refs.map((ref) => {
    const plugin = byId.get(ref) ?? byInstallRef.get(ref);
    if (!plugin)
      return { ref, error: `not a ${row.target} native plugin in any configured source` };
    const install = installFor(plugin, homes);
    if (!install) {
      return {
        ref,
        plugin,
        error: `${plugin.id} is not catalogued by a marketplace ${row.bin} can install`,
      };
    }
    return { ref, plugin, install };
  });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Apps whose native rows have something enabled, with their manager row. An
 * app that is not there is never probed: its manager is not installed either,
 * and the app already reports itself as not installed.
 */
function activeManagers(
  config: ResolvedConfig,
  table: readonly AppRow[],
  installed: Record<string, boolean>
): { app: string; row: NativeManagerRow; enabled: string[] }[] {
  const assumed = new Set(config.apps.assumeInstalled);
  const active: { app: string; row: NativeManagerRow; enabled: string[] }[] = [];
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId)?.native;
    if (!row) continue;
    if (installed[appId] !== true && !assumed.has(appId)) continue;
    const enabled = config.apps.overrides[appId]?.native_plugins?.enabled ?? [];
    const hasManagedCodexState = row.target === 'codex' && hasCodexWrapperState(config.homes);
    if (enabled.length > 0 || hasManagedCodexState) {
      active.push({ app: appId, row, enabled: [...new Set(enabled)] });
    }
  }
  return active;
}

/**
 * Read each active manager's state once. `validate` runs first, exactly as
 * 0.4.35 does: a catalog the manager refuses is reported instead of installed,
 * and the refusal is per marketplace path rather than fatal for the app.
 */
export function captureNative(
  config: ResolvedConfig,
  catalog: SourceCatalog,
  table: readonly AppRow[],
  env: NodeJS.ProcessEnv,
  installed: Record<string, boolean>,
  dryRun = false,
  runner: NativeCommandRunner = run
): NativeCapture {
  const capture: NativeCapture = {};
  for (const { app, row, enabled } of activeManagers(config, table, installed)) {
    const state: NativeAppState = {
      marketplaces: null,
      plugins: null,
      settings: null,
      invalid: {},
      managed: [],
      wrapperErrors: [],
    };
    capture[app] = state;

    if (row.target === 'codex') {
      const wrappers = readCodexWrappers(config.homes);
      state.managed = wrappers.managed;
      state.wrapperErrors = wrappers.errors;
      if (dryRun) continue;
    } else {
      for (const resolved of resolveNativeRefs(catalog, row, enabled, config.homes)) {
        const marketplacePath = resolved.install?.marketplacePath;
        if (marketplacePath === undefined || marketplacePath in state.invalid) continue;
        try {
          runRequired(row.bin, ['plugin', 'validate', marketplacePath], env, runner);
        } catch (error) {
          state.invalid[marketplacePath] = error instanceof Error ? error.message : String(error);
        }
      }
    }

    try {
      state.marketplaces = readManagerJson(
        row.bin,
        ['plugin', 'marketplace', 'list', '--json'],
        env,
        runner
      );
      if (row.target === 'codex') {
        const relevant = new Set([
          ...resolveNativeRefs(catalog, row, enabled, config.homes).flatMap((resolved) =>
            resolved.install ? [resolved.install.marketplaceName] : []
          ),
          ...state.managed.map((wrapper) => wrapper.marketplaceName),
        ]);
        const present = [...relevant].filter((name) => findMarketplace(state.marketplaces, name));
        state.plugins = present.map((name) =>
          readManagerJson(row.bin, ['plugin', 'list', '--marketplace', name, '--json'], env, runner)
        );
      } else {
        state.plugins = readManagerJson(row.bin, ['plugin', 'list', '--json'], env, runner);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      continue;
    }

    if (row.target === 'codex') continue;
    try {
      const settingsPath = row.settings(config.homes);
      if (fs.existsSync(settingsPath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          state.settings = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // An unreadable settings file leaves the registration setting alone.
    }
  }
  return capture;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface NativePlanInput {
  config: ResolvedConfig;
  catalog: SourceCatalog;
  capture: NativeCapture;
  table: readonly AppRow[];
  env: NodeJS.ProcessEnv;
  /** App detection results, so planning covers exactly what was probed. */
  installed: Record<string, boolean>;
  dryRun: boolean;
}

function nativeRow(
  app: string,
  id: string,
  targetPath: string | null,
  outcome: Action['outcome'],
  reason: string,
  detail?: string
): Action {
  const action: Action = {
    app,
    type: 'native_plugins',
    id,
    path: targetPath,
    op: 'none',
    outcome,
    reason,
  };
  if (detail !== undefined) action.detail = detail;
  return action;
}

/** Whether the settings registration key already says what it should. */
function settingNeedsWrite(
  settings: Record<string, unknown> | null,
  marketplace: string,
  source: MarketplaceSource | null
): boolean {
  const current = settings?.extraKnownMarketplaces;
  const known =
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  if (source === null) return marketplace in known;
  const entry = known[marketplace];
  const declared =
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).source
      : undefined;
  return JSON.stringify(declared) !== JSON.stringify(source);
}

function reportedMarketplaceRoot(entry: Record<string, unknown>): string | undefined {
  for (const key of ['root', 'installedRoot', 'path']) {
    if (typeof entry[key] === 'string') return entry[key] as string;
  }
  const marketplaceSource = entry.marketplaceSource;
  if (
    marketplaceSource !== null &&
    typeof marketplaceSource === 'object' &&
    typeof (marketplaceSource as Record<string, unknown>).source === 'string'
  ) {
    return (marketplaceSource as Record<string, string>).source;
  }
  return undefined;
}

function wrapperFor(install: Install): CodexWrapper | undefined {
  if (!install.managedWrapper || !install.sourcePath) return undefined;
  return {
    root: install.marketplacePath,
    stateRoot: path.dirname(install.marketplacePath),
    marketplaceName: install.marketplaceName,
    pluginName: install.pluginName,
    ref: install.ref,
    sourcePath: install.sourcePath,
    ...(install.version ? { version: install.version } : {}),
  };
}

function planCodexNative(
  input: NativePlanInput,
  app: string,
  row: NativeManagerRow,
  enabled: readonly string[],
  genericPlugins: ReadonlySet<string>
): Action[] {
  const { config, catalog, capture, env, dryRun } = input;
  const state = capture[app];
  const actions: Action[] = [];
  const invalidWrapperRoots = new Set(
    (state?.wrapperErrors ?? []).map((failure) => realPath(failure.root))
  );
  for (const failure of state?.wrapperErrors ?? []) {
    actions.push(
      nativeRow(
        app,
        path.basename(failure.root),
        failure.root,
        'conflict',
        `Codex wrapper path exists but is not a recognized ASB-owned wrapper: ${failure.error}`,
        'registered'
      )
    );
  }
  const resolvedRows = resolveNativeRefs(catalog, row, enabled, config.homes);
  const pathCounts = new Map<string, number>();
  for (const resolved of resolvedRows) {
    if (resolved.install?.managedWrapper) {
      const root = path.resolve(resolved.install.marketplacePath);
      pathCounts.set(root, (pathCounts.get(root) ?? 0) + 1);
    }
  }

  for (const resolved of resolvedRows) {
    const { ref, plugin, install } = resolved;
    if (!install) {
      actions.push(
        nativeRow(app, ref, null, 'failed', resolved.error ?? 'unknown', 'source-error')
      );
      continue;
    }
    if (plugin && genericPlugins.has(plugin.id)) {
      actions.push(
        nativeRow(
          app,
          install.ref,
          install.marketplacePath,
          'failed',
          'also enabled through [plugins].enabled; a native plugin belongs to exactly one channel',
          'source-error'
        )
      );
      continue;
    }
    if ((pathCounts.get(path.resolve(install.marketplacePath)) ?? 0) > 1) {
      actions.push(
        nativeRow(
          app,
          install.ref,
          install.marketplacePath,
          'conflict',
          'multiple native plugin ids encode to the same Codex wrapper path',
          'collision'
        )
      );
      continue;
    }
    if (state?.error) {
      actions.push(
        nativeRow(app, install.ref, install.marketplacePath, 'failed', state.error, 'source-error')
      );
      continue;
    }

    const wrapper = wrapperFor(install);
    if (wrapper && invalidWrapperRoots.has(realPath(wrapper.root))) continue;
    const knownWrapper = state?.managed.some(
      (managed) => realPath(managed.root) === realPath(install.marketplacePath)
    );
    if (wrapper && fs.existsSync(wrapper.root) && !knownWrapper) {
      actions.push(
        nativeRow(
          app,
          install.ref,
          install.marketplacePath,
          'conflict',
          'Codex wrapper path exists but is not a recognized ASB-owned wrapper',
          'registered'
        )
      );
      continue;
    }

    const marketplace = findMarketplace(state?.marketplaces, install.marketplaceName);
    if (marketplace) {
      const reported = reportedMarketplaceRoot(marketplace);
      if (!reported || realPath(reported) !== realPath(install.marketplacePath)) {
        actions.push(
          nativeRow(
            app,
            install.ref,
            install.marketplacePath,
            'conflict',
            `marketplace "${install.marketplaceName}" is registered from a different source; remove it from ${row.bin} first`,
            'registered'
          )
        );
        continue;
      }
    }

    const commands: string[][] = [];
    const notes: string[] = [];
    if (!marketplace) {
      commands.push(
        ['plugin', 'marketplace', 'add', install.marketplacePath, '--json'],
        ['plugin', 'list', '--marketplace', install.marketplaceName, '--json'],
        ['plugin', 'add', install.ref, '--json']
      );
      notes.push('marketplace added', 'installed');
    } else {
      const installedPlugin = findPlugin(state?.plugins, install);
      const stale =
        installedPlugin !== undefined &&
        install.version !== undefined &&
        installedPlugin.version !== install.version;
      if (!installedPlugin || isDisabled(installedPlugin) || stale) {
        commands.push(['plugin', 'add', install.ref, '--json']);
        notes.push(!installedPlugin ? 'installed' : stale ? 'updated' : 'enabled');
      }
    }

    if (notes.length === 0) {
      actions.push(
        nativeRow(
          app,
          install.ref,
          install.marketplacePath,
          'unchanged',
          `up to date in ${row.bin}`
        )
      );
      continue;
    }
    const action = nativeRow(
      app,
      install.ref,
      install.marketplacePath,
      'written',
      dryRun ? `would sync native plugin: ${notes.join(', ')}` : notes.join(', ')
    );
    if (!dryRun) {
      action.native = {
        bin: row.bin,
        env,
        commands,
        compensate: [],
        setting: null,
        ...(wrapper ? { prepare: wrapper } : {}),
      };
    }
    actions.push(action);
  }

  const desired = new Set(
    resolvedRows.flatMap((resolved) => (resolved.install ? [resolved.install.ref] : []))
  );
  for (const wrapper of state?.managed ?? []) {
    if (desired.has(wrapper.ref)) continue;
    if (state?.error) {
      actions.push(
        nativeRow(app, wrapper.ref, wrapper.root, 'failed', state.error, 'source-error')
      );
      continue;
    }
    const marketplace = findMarketplace(state?.marketplaces, wrapper.marketplaceName);
    if (marketplace) {
      const reported = reportedMarketplaceRoot(marketplace);
      if (!reported || realPath(reported) !== realPath(wrapper.root)) {
        actions.push(
          nativeRow(
            app,
            wrapper.ref,
            wrapper.root,
            'conflict',
            `marketplace "${wrapper.marketplaceName}" is registered from a different source; remove it from ${row.bin} first`,
            'registered'
          )
        );
        continue;
      }
    }
    const commands: string[][] = [];
    if (findPlugin(state?.plugins, wrapper)) {
      commands.push(['plugin', 'remove', wrapper.ref, '--json']);
    }
    if (marketplace) {
      commands.push(['plugin', 'marketplace', 'remove', wrapper.marketplaceName, '--json']);
    }
    const action = nativeRow(
      app,
      wrapper.ref,
      wrapper.root,
      'removed',
      dryRun
        ? 'would remove native plugin and ASB wrapper'
        : 'native plugin and ASB wrapper removed'
    );
    if (!dryRun) {
      action.native = {
        bin: row.bin,
        env,
        commands,
        compensate: [],
        setting: null,
        cleanup: { root: wrapper.root, stateRoot: wrapper.stateRoot },
      };
    }
    actions.push(action);
  }
  return actions;
}

/**
 * One row per enabled native plugin, decided against the manager's reported
 * state. A registration the manager already holds from somewhere else is only
 * migrated when asb itself put the local one there; anything else is reported
 * rather than overwritten, because the user registered it by hand.
 */
export function planNative(input: NativePlanInput): Action[] {
  const { config, catalog, capture, table, env, installed, dryRun } = input;
  const actions: Action[] = [];

  for (const { app, row, enabled } of activeManagers(config, table, installed)) {
    const state = capture[app];
    const scope = config.apps.overrides[app]?.native_plugins?.scope ?? 'user';
    const settingsPath = row.settings(config.homes);
    // The portable channel, canonicalized the same way the expansion is, so a
    // bare name and its source-qualified id are recognized as one plugin.
    const genericPlugins = new Set(
      config.apps.enabled.flatMap((appId) => effectivePlugins(config, appId))
    );

    if (row.target === 'codex') {
      actions.push(...planCodexNative(input, app, row, enabled, genericPlugins));
      continue;
    }

    for (const resolved of resolveNativeRefs(catalog, row, enabled, config.homes)) {
      const { ref, plugin, install } = resolved;
      if (!install) {
        actions.push(
          nativeRow(app, ref, null, 'failed', resolved.error ?? 'unknown', 'source-error')
        );
        continue;
      }

      // One plugin, one channel: a native install and a component expansion of
      // the same plugin would fight over the same content.
      if (plugin && genericPlugins.has(plugin.id)) {
        actions.push(
          nativeRow(
            app,
            install.ref,
            install.marketplacePath,
            'failed',
            'also enabled through [plugins].enabled; a native plugin belongs to exactly one channel',
            'source-error'
          )
        );
        continue;
      }

      const invalid = state?.invalid[install.marketplacePath];
      if (invalid) {
        actions.push(
          nativeRow(app, install.ref, install.marketplacePath, 'failed', invalid, 'source-error')
        );
        continue;
      }
      if (state?.error) {
        actions.push(
          nativeRow(
            app,
            install.ref,
            install.marketplacePath,
            'failed',
            state.error,
            'source-error'
          )
        );
        continue;
      }

      const registration = registrationFor(install);
      const commands: string[][] = [];
      const compensate: string[][] = [];
      const notes: string[] = [];
      let drift = false;

      const marketplace = findMarketplace(state?.marketplaces, install.marketplaceName);
      let blocked: string | undefined;
      let migrated = false;
      if (!marketplace) {
        commands.push(['plugin', 'marketplace', 'add', '--scope', scope, registration.argument]);
        notes.push('marketplace added');
      } else {
        const actual = declaredSource(marketplace);
        if (!sourceMatches(actual, registration.source)) {
          const managedLocal = sourceMatches(actual, {
            source: 'directory',
            path: install.marketplacePath,
          });
          if (registration.portable && managedLocal) {
            // asb registered the local path itself, so replacing it with the
            // portable declaration is a migration, not a takeover. Failing
            // half-way puts the local registration and its install back.
            commands.push(
              ['plugin', 'marketplace', 'remove', '--scope', scope, install.marketplaceName],
              ['plugin', 'marketplace', 'add', '--scope', scope, registration.argument]
            );
            compensate.push(
              ['plugin', 'marketplace', 'remove', '--scope', scope, install.marketplaceName],
              ['plugin', 'marketplace', 'add', '--scope', scope, install.marketplacePath]
            );
            const previous = findPlugin(state?.plugins, install);
            if (previous) {
              compensate.push(['plugin', 'install', '--scope', scope, install.ref]);
              if (isDisabled(previous)) {
                compensate.push(['plugin', 'disable', '--scope', scope, install.ref]);
              }
            }
            notes.push('marketplace migrated');
            migrated = true;
          } else {
            blocked = `marketplace "${install.marketplaceName}" is registered from a different source; remove it from ${row.bin} first`;
          }
        }
      }

      if (blocked) {
        actions.push(
          nativeRow(app, install.ref, install.marketplacePath, 'conflict', blocked, 'registered')
        );
        continue;
      }

      // The probe reads the manager's state once, before any of this run's own
      // commands. That reading only describes an install that survives them: a
      // marketplace this run registers or re-registers takes its plugins with
      // it, so what was reported for the old one says nothing about the new.
      const installed = marketplace && !migrated ? findPlugin(state?.plugins, install) : undefined;
      if (!installed) {
        commands.push(['plugin', 'install', '--scope', scope, install.ref]);
        notes.push('installed');
      } else if (isDisabled(installed)) {
        // Design: a plugin disabled behind asb's back reports stale rather
        // than up-to-date, and the sync re-enables it.
        commands.push(['plugin', 'enable', '--scope', scope, install.ref]);
        notes.push('enabled');
        drift = true;
      }

      const settingSource = registration.portable ? registration.source : null;
      const settingWrite = settingNeedsWrite(
        state?.settings ?? null,
        install.marketplaceName,
        settingSource
      );
      if (settingWrite) notes.push('settings reconciled');

      if (notes.length === 0) {
        actions.push(
          nativeRow(
            app,
            install.ref,
            install.marketplacePath,
            'unchanged',
            `up to date in ${row.bin}`
          )
        );
        continue;
      }

      const action = nativeRow(
        app,
        install.ref,
        install.marketplacePath,
        'written',
        dryRun ? `would sync native plugin (${scope}): ${notes.join(', ')}` : notes.join(', ')
      );
      if (drift) {
        action.detail = 'stale';
        action.reason = dryRun
          ? `disabled outside asb; sync re-enables it (${scope})`
          : 'disabled outside asb; re-enabled it';
      }
      if (!dryRun) {
        action.native = {
          bin: row.bin,
          env,
          commands,
          compensate,
          setting: settingWrite
            ? {
                path: settingsPath,
                marketplace: install.marketplaceName,
                source: settingSource,
              }
            : null,
        };
      }
      actions.push(action);
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Run one native row's manager work. A failure part-way runs the compensation
 * list so the manager is left holding what it held before, and reports both
 * the original failure and any failure to undo.
 */
export function applyNative(
  work: NativeWork,
  runner: NativeCommandRunner = run
): string | undefined {
  const preparedNew = work.prepare !== undefined && !fs.existsSync(work.prepare.root);
  let snapshot: CodexWrapperSnapshot | null = null;
  if (work.prepare && !preparedNew) {
    try {
      snapshot = snapshotCodexWrapper(work.prepare);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  const restorePrepared = (): string | undefined => {
    if (!work.prepare) return undefined;
    try {
      if (preparedNew) fs.rmSync(work.prepare.root, { recursive: true, force: true });
      else if (snapshot) restoreCodexWrapper(snapshot);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  if (work.prepare) {
    try {
      materializeCodexWrapper(work.prepare);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const restoreFailure = restorePrepared();
      return restoreFailure
        ? `${failure}; restoring Codex wrapper failed: ${restoreFailure}`
        : failure;
    }
  }
  for (const [index, args] of work.commands.entries()) {
    const result = runner(work.bin, args, work.env);
    if (result.status === 0) continue;
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    const failure = `${work.bin} ${args.join(' ')} failed: ${detail}`;
    const restoreFailure = restorePrepared();
    const failed = restoreFailure
      ? `${failure}; restoring Codex wrapper failed: ${restoreFailure}`
      : failure;
    if (index === 0 || work.compensate.length === 0) return failed;
    for (const undo of work.compensate) {
      const restored = runner(work.bin, undo, work.env);
      if (restored.status !== 0) {
        const why = restored.stderr.trim() || restored.stdout.trim() || `exit ${restored.status}`;
        return `${failed}; restoring the previous registration failed: ${work.bin} ${undo.join(' ')}: ${why}`;
      }
    }
    return failed;
  }

  if (work.setting) {
    try {
      reconcileSetting(work.setting);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (work.cleanup) {
    if (!contained(work.cleanup.stateRoot, work.cleanup.root)) {
      return `refusing to remove Codex wrapper outside ASB state: ${work.cleanup.root}`;
    }
    try {
      fs.rmSync(work.cleanup.root, { recursive: true, force: true });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

/**
 * The manager's own portable-marketplace declaration. Only asb's key is
 * touched: everything else in the settings document round-trips, and the map
 * disappears when its last entry does.
 */
function reconcileSetting(setting: NonNullable<NativeWork['setting']>): void {
  let document: Record<string, unknown> = {};
  if (fs.existsSync(setting.path)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(setting.path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`settings must contain a JSON object: ${setting.path}`);
    }
    document = parsed as Record<string, unknown>;
  }

  const current = document.extraKnownMarketplaces;
  const known =
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

  if (setting.source === null) {
    delete known[setting.marketplace];
  } else {
    const entry = known[setting.marketplace];
    const kept =
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? { ...(entry as Record<string, unknown>) }
        : {};
    kept.source = setting.source;
    known[setting.marketplace] = kept;
  }

  if (Object.keys(known).length > 0) document.extraKnownMarketplaces = known;
  else delete document.extraKnownMarketplaces;

  fs.mkdirSync(path.dirname(setting.path), { recursive: true });
  writeFileAtomic(setting.path, `${JSON.stringify(document, null, 2)}\n`);
}
