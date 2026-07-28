import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { AGENTS_SKILLS_UNION, APP_ROWS } from './apps.js';
import {
  ConfigError,
  effectiveSelection,
  loadConfig,
  type ResolvedConfig,
  withPluginExpansion,
} from './config.js';
import { expandHome, type RemoteSource } from './git.js';
import {
  acquireRunLock,
  type Ledger,
  ledgerKey,
  ledgerPath,
  loadLedger,
  type RunLock,
  saveLedger,
} from './ledger.js';
import { buildPluginExpansion, scanLibrary } from './library.js';
import { applyNative, captureNative, planNative } from './native.js';
import { loadPeerState, savePeerState } from './peer.js';
import {
  type Action,
  type CapturedHookApp,
  type ExplainSlice,
  explainHooks,
  explainRules,
  explainSkills,
  explainSources,
  planHooks,
  planRules,
  planSkills,
  planSources,
  type SyncCapture,
} from './plan.js';
import {
  buildReport,
  FAILING_OUTCOMES,
  type Report,
  type ReportEntry,
  redactCredentials,
  renderExplain,
  renderReport,
} from './report.js';
import {
  applyBundleFiles,
  bundleFingerprint,
  hashContent,
  listTargetFiles,
  removeBundleSlice,
  removeManagedFile,
  targetEscapesRoot,
  writeFileAtomic,
} from './shapes.js';
import {
  addLocalSource,
  addRemoteSource,
  ensureSourcesReady,
  inferSourceName,
  isGitUrl,
  parseGitUrl,
  type ReadinessRow,
  readSourceCatalog,
  refreshableSources,
  removeSource,
  type SourceCatalog,
  type UpdateRow,
  updateSources,
  validateSourcePath,
} from './sources.js';

/**
 * Command bodies. `runSync` is the one reconciliation: load → capture →
 * plan → (apply) → report. Preview is the same pipeline with the writer
 * disabled — the actions are computed once from one captured input, so
 * preview and apply cannot diverge structurally.
 */

export interface SyncOptions {
  dryRun?: boolean;
  apps?: readonly string[];
  types?: readonly string[];
  profile?: string;
  project?: string;
  sources?: readonly string[];
  /** Refresh managed clones over the network before planning. */
  update?: boolean;
  /** Explicit suppression, including of `[plugins].auto_update`. */
  noUpdate?: boolean;
  env?: NodeJS.ProcessEnv;
}

function captureFor(config: ReturnType<typeof loadConfig>, ledger: Ledger): SyncCapture {
  const capture: SyncCapture = {
    installed: {},
    targets: {},
    bundles: {},
    bundleDirs: {},
    hooks: {},
  };
  for (const appId of config.apps.enabled) {
    const row = APP_ROWS.find((candidate) => candidate.id === appId);
    if (!row) continue;
    capture.installed[appId] = fs.existsSync(row.detectDir(config.homes));
    if (!row.rules) continue;
    const targetPath = row.rules.path(config.homes);
    const escapes = targetEscapesRoot(row.rules.root(config.homes), targetPath);
    try {
      capture.targets[targetPath] = {
        exists: true,
        content: fs.readFileSync(targetPath, 'utf-8'),
        escapes,
      };
    } catch {
      capture.targets[targetPath] = { exists: fs.existsSync(targetPath), content: null, escapes };
    }
  }

  // Skills parents: list present child dirs, then snapshot every bundle the
  // planner can possibly touch — selected, recorded, or name-present.
  const skillRows: { app: string; dir: string; root: string; reserved: readonly string[] }[] = [];
  for (const appId of config.apps.enabled) {
    const row = APP_ROWS.find((candidate) => candidate.id === appId);
    if (!row?.skills) continue;
    skillRows.push({
      app: appId,
      dir: row.skills.dir(config.homes),
      root: row.skills.root(config.homes),
      reserved: row.skills.reserved,
    });
  }
  if (AGENTS_SKILLS_UNION.participates(config.apps.enabled)) {
    skillRows.push({
      app: 'agents',
      dir: AGENTS_SKILLS_UNION.dir(config.homes),
      root: AGENTS_SKILLS_UNION.root(config.homes),
      reserved: AGENTS_SKILLS_UNION.reserved,
    });
  }
  for (const row of skillRows) {
    let present: string[] = [];
    try {
      present = fs
        .readdirSync(row.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('.') && !row.reserved.includes(name));
    } catch {
      // parent absent: nothing present
    }
    capture.bundleDirs[row.dir] = present;

    const recorded = ledger.entries
      .filter(
        (entry) =>
          entry.app === row.app &&
          entry.type === 'skills' &&
          entry.id !== null &&
          path.dirname(entry.path) === row.dir
      )
      .map((entry) => entry.id as string);
    const selected = row.app === 'agents' ? [] : effectiveSelection(config, row.app, 'skills');
    const unionSelected =
      row.app === 'agents'
        ? AGENTS_SKILLS_UNION.members
            .filter((member) => config.apps.enabled.includes(member))
            .flatMap((member) => effectiveSelection(config, member, 'skills'))
        : [];
    const candidates = new Set(
      [...selected, ...unionSelected, ...recorded, ...present].filter(
        (id) => !id.startsWith('.') && !row.reserved.includes(id)
      )
    );
    for (const id of candidates) {
      const bundlePath = path.join(row.dir, id);
      if (capture.bundles[bundlePath]) continue;
      const escapes = targetEscapesRoot(row.root, bundlePath);
      const exists = fs.existsSync(bundlePath);
      capture.bundles[bundlePath] = {
        exists,
        files: exists ? listTargetFiles(bundlePath) : null,
        fingerprint: exists ? (bundleFingerprint(bundlePath) ?? null) : null,
        escapes,
      };
    }
  }

  // Hooks: the app config it merges into, the peer record that says which
  // groups are asb's, and every bundle directory that record can reclaim.
  for (const appId of config.apps.enabled) {
    const row = APP_ROWS.find((candidate) => candidate.id === appId)?.hooks;
    if (!row) continue;
    const configPath = row.path(config.homes);
    const root = row.root(config.homes);
    const captured: CapturedHookApp = {
      path: configPath,
      exists: fs.existsSync(configPath),
      content: null,
      config: {},
      escapes: targetEscapesRoot(root, configPath),
      state: loadPeerState(config.homes.asbHome, row.stateTarget),
    };
    if (captured.exists) {
      try {
        captured.content = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(captured.content) as unknown;
        captured.config =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      } catch (error) {
        captured.config = null;
        captured.error = error instanceof Error ? error.message : String(error);
      }
    }
    capture.hooks[appId] = captured;

    const claimable = new Set([
      ...effectiveSelection(config, appId, 'hooks'),
      ...captured.state.bundles,
    ]);
    for (const id of claimable) {
      const bundlePath = path.join(row.bundleDir(config.homes), id);
      if (capture.bundles[bundlePath]) continue;
      const exists = fs.existsSync(bundlePath);
      capture.bundles[bundlePath] = {
        exists,
        files: exists ? listTargetFiles(bundlePath) : null,
        fingerprint: exists ? (bundleFingerprint(bundlePath) ?? null) : null,
        escapes: targetEscapesRoot(root, bundlePath),
      };
    }
  }
  return capture;
}

function toEntry(action: Action): ReportEntry {
  const entry: ReportEntry = {
    app: action.app,
    type: action.type,
    id: action.id,
    path: action.path,
    outcome: action.outcome,
  };
  if (action.detail !== undefined) entry.detail = action.detail;
  if (action.reason !== undefined) entry.reason = action.reason;
  return entry;
}

function applyLedgerMutation(ledger: Ledger, action: Action): boolean {
  if (!action.ledger) return false;
  if (action.ledger.op === 'put') {
    const key = ledgerKey(action.ledger.entry);
    const index = ledger.entries.findIndex((entry) => ledgerKey(entry) === key);
    if (index >= 0) ledger.entries[index] = action.ledger.entry;
    else ledger.entries.push(action.ledger.entry);
    return true;
  }
  const key = action.ledger.key;
  const before = ledger.entries.length;
  ledger.entries = ledger.entries.filter((entry) => ledgerKey(entry) !== key);
  return ledger.entries.length !== before;
}

export function executeAction(action: Action, ledger: Ledger): ReportEntry {
  // Native rows own no file: the manager's own verbs are the apply, and its
  // reported state is the proof, so nothing here reaches the ledger.
  if (action.native) {
    const failure = applyNative(action.native);
    if (failure === undefined) return toEntry(action);
    return {
      app: action.app,
      type: action.type,
      id: action.id,
      path: action.path,
      outcome: 'failed',
      detail: 'write-error',
      reason: failure,
    };
  }

  if (action.op === 'write' || action.op === 'remove') {
    const failure = (
      outcome: 'blocked' | 'conflict' | 'left-behind' | 'failed',
      detail: string | undefined,
      reason: string
    ): ReportEntry => {
      const entry: ReportEntry = {
        app: action.app,
        type: action.type,
        id: action.id,
        path: action.path,
        outcome,
        reason,
      };
      if (detail !== undefined) entry.detail = detail;
      return entry;
    };

    // Mutations without a declared containment root are refused, never
    // silently unchecked.
    if (!action.path || !action.root) {
      return failure(
        'blocked',
        'path-escape',
        'action carries no containment root; not touching it'
      );
    }
    if (targetEscapesRoot(action.root, action.path)) {
      return failure(
        'blocked',
        'path-escape',
        `parent directory of ${action.path} resolves outside the app root; not touching it`
      );
    }

    // The plan's proof was for the captured state; re-check at action time
    // and refuse on drift rather than overwrite or delete unproven content.
    if (action.bundle) {
      const expected = action.expectedHash ?? null;
      const drifted =
        expected === null
          ? fs.existsSync(action.path)
          : (bundleFingerprint(action.path) ?? null) !== expected;
      if (drifted) {
        return action.op === 'write'
          ? failure('conflict', undefined, 'changed between planning and apply; re-run asb sync')
          : failure(
              'left-behind',
              'modified',
              'changed between planning and apply; re-run asb sync'
            );
      }

      try {
        if (action.op === 'write') {
          applyBundleFiles(action.path, action.bundle.files, action.bundle.stale);
        } else {
          // A deletion that did not happen is never reported as one: the
          // claim stays with the ledger or the peer record, so the payload
          // remains reclaimable instead of orphaned by a false success.
          const leftBehind = removeBundleSlice(action.path, action.bundle.stale);
          if (leftBehind.length > 0) {
            return failure(
              'left-behind',
              'remove-failed',
              `could not delete ${leftBehind.length} recorded file(s) under ${action.path}; it is still installed — fix its permissions or delete it yourself, then re-run asb sync`
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure('failed', 'write-error', message);
      }

      // The recorded proof is the measured post-write tree, foreign extras
      // included; an unprovable result records no ownership at all.
      if (action.op === 'write' && action.ledger?.op === 'put') {
        const measured = bundleFingerprint(action.path);
        if (measured === undefined) {
          return failure(
            'failed',
            'write-error',
            'bundle is unprovable after writing (symlink or special file appeared); no ownership recorded'
          );
        }
        applyLedgerMutation(ledger, {
          ...action,
          ledger: { op: 'put', entry: { ...action.ledger.entry, hash: measured } },
        });
        return toEntry(action);
      }

      applyLedgerMutation(ledger, action);
      return toEntry(action);
    }

    let live: string | null = null;
    try {
      live = fs.readFileSync(action.path, 'utf-8');
    } catch {
      live = null;
    }
    const liveHash = live !== null ? hashContent(live) : null;
    if (liveHash !== (action.expectedHash ?? null)) {
      return action.op === 'write'
        ? failure('conflict', undefined, 'changed between planning and apply; re-run asb sync')
        : failure('left-behind', 'modified', 'changed between planning and apply; re-run asb sync');
    }

    try {
      if (action.op === 'write') {
        writeFileAtomic(action.path, action.content ?? '');
      } else {
        removeManagedFile(action.path, action.content);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure('failed', 'write-error', message);
    }
  }

  applyLedgerMutation(ledger, action);

  // The peer record is published only once its own slice landed: a config
  // holding groups no record claims is a leak, and a record claiming groups
  // no config holds authorizes deleting the user's.
  if (action.peer) {
    try {
      savePeerState(action.peer.asbHome, action.peer.target, action.peer.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...toEntry(action),
        outcome: 'failed',
        detail: 'write-error',
        reason: `hook ownership state could not be saved (${message})`,
      };
    }
  }
  return toEntry(action);
}

const NO_FAILURES: ReadonlySet<string> = new Set();

/**
 * One gated pass over the plan. An action whose required bundles did not land
 * is skipped instead of executed — an app config may not point at payload
 * this run failed to distribute, and the record that authorizes deleting it
 * may not claim it. The record also goes out still claiming anything whose
 * removal failed, so shared state never says less than what remains on disk.
 * Preview walks the same gate, so a dry run cannot promise a write the real
 * run refuses.
 */
function reconcile(
  actions: readonly Action[],
  run: (action: Action) => ReportEntry
): ReportEntry[] {
  const entries: ReportEntry[] = [];
  const failed = new Map<string, Set<string>>();

  for (const action of actions) {
    const slotKey = `${action.app}\0${action.type}`;
    const slot = failed.get(slotKey) ?? NO_FAILURES;

    const blocker = action.requires?.find((id) => slot.has(id));
    if (blocker !== undefined) {
      entries.push({
        ...toEntry(action),
        outcome: 'skipped',
        detail: 'bundle-failed',
        reason: `hook bundle ${blocker} did not land this run; leaving this alone until it does`,
      });
      continue;
    }

    // A failed write blocks its own config through `requires` above, so an id
    // that reaches a peer publish failed to be REMOVED: it is still
    // distributed, and the record must keep saying so.
    const entry = run(
      action.peer && slot.size > 0
        ? {
            ...action,
            peer: {
              ...action.peer,
              state: {
                ...action.peer.state,
                bundles: [...new Set([...action.peer.state.bundles, ...slot])],
              },
            },
          }
        : action
    );
    entries.push(entry);

    if (entry.id !== null && FAILING_OUTCOMES.has(entry.outcome)) {
      const bucket = failed.get(slotKey);
      if (bucket) bucket.add(entry.id);
      else failed.set(slotKey, new Set([entry.id]));
    }
  }
  return entries;
}

/** Scope flags whose engine wiring lands with a later cell fail closed. */
function rejectUnwiredScope(opts: SyncOptions): void {
  if (opts.project) {
    throw new ConfigError('project scope is not available in this engine build');
  }
}

/**
 * Which source a row belongs to, for `--source`. Component ids carry their
 * plugin as a prefix, so attribution is a lookup, not a guess. A row nothing
 * attributes to a source — an app-level skip, an aggregate target, a ledger
 * failure — is never hidden by the filter.
 */
function sourceAttribution(catalog: SourceCatalog): (action: Action) => string | null {
  const owners = new Map<string, string>();
  for (const source of catalog.sources) owners.set(source.namespace, source.namespace);
  for (const plugin of catalog.plugins) {
    owners.set(plugin.id, plugin.source);
    if (plugin.native?.install) owners.set(plugin.native.install.ref, plugin.source);
  }
  return (action) => {
    if (action.id === null) return null;
    const direct = owners.get(action.id);
    if (direct !== undefined) return direct;
    const cut = action.id.lastIndexOf(':');
    if (cut < 0) return 'library';
    return owners.get(action.id.slice(0, cut)) ?? 'library';
  };
}

/**
 * The sources phase: materialize configured clones, then refresh them when the
 * run asked for it. It runs before the scan and produces no components of its
 * own — the scan reads whatever it left on disk.
 *
 * Refresh is the one place a filter reaches an input rather than an action:
 * `--source` names what to fetch, because fetching is the request. Readiness
 * is never filtered, so a narrowed run still plans against the whole library.
 */
function runSourcesPhase(
  config: ResolvedConfig,
  opts: SyncOptions,
  dryRun: boolean
): { readiness: ReadinessRow[]; updates: UpdateRow[]; pendingRefresh: string[] } {
  const readiness = ensureSourcesReady(config, { dryRun });
  const refreshing = opts.update === true || (config.plugins.autoUpdate && opts.noUpdate !== true);
  if (!refreshing) return { readiness, updates: [], pendingRefresh: [] };

  const only = opts.sources && opts.sources.length > 0 ? opts.sources : undefined;
  if (dryRun) {
    const scoped = refreshableSources(config).filter(
      (namespace) => !only || only.includes(namespace)
    );
    return { readiness, updates: [], pendingRefresh: scoped };
  }
  return { readiness, updates: updateSources(config, only ? { only } : {}), pendingRefresh: [] };
}

export async function runSync(opts: SyncOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun === true;

  rejectUnwiredScope(opts);
  const config = loadConfig({ profile: opts.profile, env });

  // A real run takes the lock before ledger and capture: the whole
  // capture → plan → apply sequence executes against serialized state, so a
  // plan built from another run's pre-apply snapshot can never fire.
  const lock: RunLock | null = dryRun ? null : acquireRunLock(config.homes.stateHome);
  try {
    const ledger = loadLedger(config.homes.stateHome);
    const sources = runSourcesPhase(config, opts, dryRun);
    const catalog = readSourceCatalog(config);
    const inventory = scanLibrary({ env, plugins: catalog.plugins });

    // What the sources contribute is only known after the scan, so the
    // expansion joins the configuration here rather than at load time.
    const resolved = withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));
    const capture = captureFor(resolved, ledger);
    const nativeState = captureNative(resolved, catalog, APP_ROWS, env, capture.installed);

    const planInput = {
      config: resolved,
      inventory,
      ledger,
      capture,
      table: APP_ROWS,
      now: new Date().toISOString(),
    };
    let actions = [
      ...planSources({ config: resolved, catalog, ...sources, dryRun }),
      ...planRules(planInput),
      ...planSkills(planInput),
      ...planHooks(planInput),
      // Native rows run last: their registration setting shares a document
      // with the hooks target, and this one re-reads it after that write.
      ...planNative({
        config: resolved,
        catalog,
        capture: nativeState,
        table: APP_ROWS,
        env,
        installed: capture.installed,
        dryRun,
      }),
    ];

    // Filters select which actions execute, never which inputs the planner saw.
    if (opts.apps && opts.apps.length > 0) {
      const wanted = new Set(opts.apps);
      actions = actions.filter((action) => action.app === null || wanted.has(action.app));
    }
    if (opts.types && opts.types.length > 0) {
      const wanted = new Set(opts.types);
      actions = actions.filter((action) => action.type === null || wanted.has(action.type));
    }
    if (opts.sources && opts.sources.length > 0) {
      const wanted = new Set(opts.sources);
      const owner = sourceAttribution(catalog);
      actions = actions.filter((action) => {
        const source = owner(action);
        return source === null || wanted.has(source);
      });
    }

    const scope = {
      profile: config.profile,
      project: config.project,
      dryRun,
    };

    if (dryRun) {
      const preview = buildReport(scope, reconcile(actions, toEntry));
      if (ledger.lastRun) preview.lastRun = ledger.lastRun;
      return preview;
    }

    const entries = reconcile(actions, (action) => executeAction(action, ledger));

    // Every real run stamps the last-run fact; `status` (dry) reports it.
    const previousLastRun = ledger.lastRun;
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
    }
    ledger.lastRun = {
      at: planInput.now,
      summary:
        [...counts.entries()].map(([outcome, count]) => `${count} ${outcome}`).join(', ') ||
        'nothing to do',
    };

    try {
      saveLedger(config.homes.stateHome, ledger);
    } catch (error) {
      // Files changed but the proof did not persist: that is a failure of
      // this run, reported as such — identity adoption re-proves ownership
      // on the next run.
      const message = error instanceof Error ? error.message : String(error);
      entries.push({
        app: null,
        type: null,
        id: null,
        path: ledgerPath(config.homes.stateHome),
        outcome: 'failed',
        detail: 'write-error',
        reason: `ownership ledger could not be saved (${message})`,
      });
    }

    const report = buildReport(scope, entries);
    if (previousLastRun) report.lastRun = previousLastRun;
    return report;
  } finally {
    lock?.release();
  }
}

export async function runExplain(target: string, opts: SyncOptions = {}): Promise<ExplainSlice[]> {
  const env = opts.env ?? process.env;
  rejectUnwiredScope(opts);
  const config = loadConfig({ profile: opts.profile, env });
  const ledger = loadLedger(config.homes.stateHome);
  const catalog = readSourceCatalog(config);
  const inventory = scanLibrary({ env, plugins: catalog.plugins });
  const resolved = withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));
  const capture = captureFor(resolved, ledger);

  const planInput = {
    config: resolved,
    inventory,
    ledger,
    capture,
    table: APP_ROWS,
    now: new Date().toISOString(),
  };
  // Explain never clones or fetches: it reads what a preview would report.
  let slices = [
    ...explainSources(
      {
        config: resolved,
        catalog,
        readiness: ensureSourcesReady(resolved, { dryRun: true }),
        updates: [],
        pendingRefresh: [],
        dryRun: true,
      },
      target
    ),
    ...explainRules(planInput, target),
    ...explainSkills(planInput, target),
    ...explainHooks(planInput, target),
  ];
  if (opts.apps && opts.apps.length > 0) {
    const wanted = new Set(opts.apps);
    slices = slices.filter((slice) => slice.app === null || wanted.has(slice.app));
  }
  return slices.map((slice) =>
    slice.reason ? { ...slice, reason: redactCredentials(slice.reason) } : slice
  );
}

// ---------------------------------------------------------------------------
// Source lifecycle commands
// ---------------------------------------------------------------------------

export interface AddSourceOptions extends SyncOptions {
  /** Namespace to file the source under; inferred from the location otherwise. */
  as?: string;
  ref?: string;
  subtree?: boolean;
}

/**
 * Declare a source. A git transport clones (or subtrees) into asb's own tree
 * first and is declared only once that succeeded; anything else is a local
 * directory the user keeps owning. The persisted declaration is always
 * credential-free, so a token in the argument never reaches config.toml.
 */
export async function runAddSource(location: string, opts: AddSourceOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const config = loadConfig({ profile: opts.profile, env });
  const namespace = opts.as?.trim() || inferSourceName(location);
  const scope = { profile: config.profile, project: config.project, dryRun: false };

  const expanded = expandHome(location);
  if (isGitUrl(expanded) || expanded.endsWith('.git')) {
    const parsed = parseGitUrl(location);
    const remote: RemoteSource = { url: parsed.url, type: opts.subtree ? 'subtree' : 'clone' };
    const ref = opts.ref?.trim() || parsed.ref;
    if (ref) remote.ref = ref;
    if (parsed.subdir) remote.subdir = parsed.subdir;
    addRemoteSource(config, namespace, remote, env);
  } else {
    addLocalSource(config, namespace, location, env);
  }

  // Read back through the same path every other command uses, so what `add`
  // reports is what the next `sync` will see.
  const catalog = readSourceCatalog(loadConfig({ profile: opts.profile, env }));
  const source = catalog.sources.find((candidate) => candidate.namespace === namespace);
  const plugins = catalog.plugins.filter((plugin) => plugin.source === namespace);
  const contents = source ? validateSourcePath(source.path) : undefined;
  const detail =
    contents && !contents.valid
      ? '; it holds no rules, commands, agents, skills, or hooks yet'
      : contents?.kind === 'marketplace'
        ? `; ${plugins.length} plugin(s) catalogued`
        : contents
          ? `; contributes ${contents.found.join(', ')}`
          : '';

  return buildReport(scope, [
    {
      app: null,
      type: null,
      id: namespace,
      path: source?.path ?? null,
      outcome: 'written',
      reason: `added as "${namespace}"${detail}`,
    },
  ]);
}

/**
 * Retire a source: its managed content, its declaration, its derived caches,
 * and every enabled entry it put there. The retired ids are reported one per
 * row — a config edit the user did not type is never silent.
 */
export async function runRemoveSource(namespace: string, opts: SyncOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const config = loadConfig({ profile: opts.profile, env });
  const scope = { profile: config.profile, project: config.project, dryRun: false };

  const catalog = readSourceCatalog(config);
  const source = catalog.sources.find((candidate) => candidate.namespace === namespace);
  const inventory = scanLibrary({ env, plugins: catalog.plugins });
  const expansion = buildPluginExpansion(catalog.plugins, inventory);
  const pluginIds = catalog.plugins
    .filter((plugin) => plugin.source === namespace)
    .map((plugin) => plugin.id);
  const componentIds = pluginIds.flatMap((id) =>
    Object.values(expansion.byPlugin[id] ?? {}).flat()
  );

  const { retired } = removeSource(config, namespace, { componentIds, pluginIds, env });

  const entries: ReportEntry[] = [
    {
      app: null,
      type: null,
      id: namespace,
      path: source?.path ?? null,
      outcome: 'removed',
      reason: 'source removed; run asb sync to retire what it distributed',
    },
  ];
  for (const row of retired) {
    entries.push({
      app: null,
      type: row.type,
      id: row.id,
      path: null,
      outcome: 'removed',
      detail: 'retired',
      reason: `disabled in [${row.type}] because source "${namespace}" provided it`,
    });
  }
  return buildReport(scope, entries);
}

// ---------------------------------------------------------------------------
// Argument parsing: scope flags are registered chain-wide and resolved once,
// so any flag ordering yields identical behavior.
// ---------------------------------------------------------------------------

export type CliOptions = SyncOptions & {
  json: boolean;
  update: boolean;
  noUpdate: boolean;
  sources: string[];
};

export type CliInvocation =
  | { command: 'sync' | 'status'; options: CliOptions }
  | { command: 'explain'; target: string; options: CliOptions }
  | { command: 'add'; location: string; options: CliOptions & AddSourceOptions }
  | { command: 'remove'; namespace: string; options: CliOptions };

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function registerScopeFlags(target: Command): Command {
  return target
    .option('-n, --dry-run', 'plan and report; write nothing, clone nothing')
    .option('--update', 'refresh managed clones after readiness, before planning')
    .option('--no-update', 'suppress refresh (including plugins.auto_update)')
    .option('--source <name>', 'filter the plan to entries from named sources', collect, [])
    .option('--app <app>', 'narrow the plan to named apps', collect, [])
    .option('--type <type>', 'narrow the plan to named types', collect, [])
    .option('-p, --profile <name>', 'per-machine selection set')
    .option('-P, --project <dir>', 'apply that repo project config at project scope')
    .option('--json', 'machine-readable output');
}

export function parseCliArgs(argv: readonly string[]): CliInvocation {
  let parsed: CliInvocation | null = null;

  const program = new Command();
  program.name('asb').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerScopeFlags(program);

  // Merge by hand: optsWithGlobals lets a subcommand's [] defaults shadow
  // values collected before the subcommand name. Arrays concatenate in argv
  // order; scalars prefer the later (subcommand) position.
  const scopeOptions = (cmd: Command): CliOptions => {
    const local = cmd.opts();
    const global = cmd.parent?.opts() ?? {};
    const update = local.update ?? global.update;
    return {
      dryRun: local.dryRun === true || global.dryRun === true,
      update: update === true,
      // Commander maps --no-update onto `update: false`; `noUpdate` reports
      // the explicit suppression distinctly from "flag absent".
      noUpdate: update === false,
      sources: [...(global.source ?? []), ...(local.source ?? [])],
      apps: [...(global.app ?? []), ...(local.app ?? [])],
      types: [...(global.type ?? []), ...(local.type ?? [])],
      profile: (local.profile ?? global.profile) as string | undefined,
      project: (local.project ?? global.project) as string | undefined,
      json: local.json === true || global.json === true,
    };
  };

  registerScopeFlags(
    program.command('sync').description('reconcile every installed app to the library')
  ).action((_args: unknown, cmd: Command) => {
    parsed = { command: 'sync', options: scopeOptions(cmd) };
  });

  registerScopeFlags(
    program.command('status').description('inventory × selection × per-app reality')
  ).action((_args: unknown, cmd: Command) => {
    parsed = { command: 'status', options: scopeOptions(cmd) };
  });

  registerScopeFlags(
    program
      .command('explain')
      .description('one target: owner, recorded and current hashes, desired content')
      .argument('<target>', 'component id, app id, or target path')
  ).action((target: string, _args: unknown, cmd: Command) => {
    parsed = { command: 'explain', target, options: scopeOptions(cmd) };
  });

  registerScopeFlags(
    program
      .command('add')
      .description('add a plugin source: a git URL or a local directory')
      .argument('<location>', 'git URL or local directory')
      .option('--as <name>', 'namespace to file the source under')
      .option('--ref <ref>', 'branch, tag, or commit to track')
      .option('--subtree', 'commit the source into the library repository')
  ).action((location: string, args: Record<string, unknown>, cmd: Command) => {
    parsed = {
      command: 'add',
      location,
      options: {
        ...scopeOptions(cmd),
        as: args.as as string | undefined,
        ref: args.ref as string | undefined,
        subtree: args.subtree === true,
      },
    };
  });

  registerScopeFlags(
    program
      .command('remove')
      .description('remove a plugin source and retire what it enabled')
      .argument('<name>', 'source namespace')
  ).action((namespace: string, _args: unknown, cmd: Command) => {
    parsed = { command: 'remove', namespace, options: scopeOptions(cmd) };
  });

  program.parse([...argv], { from: 'user' });

  if (!parsed) {
    throw new ConfigErrorLike('No command given.');
  }
  return parsed;
}

class ConfigErrorLike extends Error {
  readonly exitCode = 2;
}

/**
 * CLI entry: parse, run, render, set the exit code. Never calls
 * process.exit — the exit code is set on process.exitCode so stdout always
 * flushes before the process ends.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let invocation: CliInvocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }

  try {
    if (invocation.command === 'explain') {
      const slices = await runExplain(invocation.target, invocation.options);
      process.stdout.write(
        invocation.options.json
          ? `${JSON.stringify(slices, null, 2)}\n`
          : renderExplain(slices, invocation.target)
      );
      return slices.length > 0 ? 0 : 1;
    }

    const report =
      invocation.command === 'add'
        ? await runAddSource(invocation.location, invocation.options)
        : invocation.command === 'remove'
          ? await runRemoveSource(invocation.namespace, invocation.options)
          : await runSync({
              ...invocation.options,
              dryRun: invocation.command === 'status' ? true : invocation.options.dryRun,
            });
    process.stdout.write(
      invocation.options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report)
    );
    return report.exitCode;
  } catch (error) {
    // Anything a source operation throws can carry the remote it was reaching,
    // and a remote can carry a token. Nothing leaves here unredacted.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactCredentials(message)}\n`);
    const exitCode = (error as { exitCode?: number }).exitCode;
    return exitCode === 2 ? 2 : 1;
  }
}
