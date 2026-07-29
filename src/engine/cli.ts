import fs from 'node:fs';
import path from 'node:path';
import { checkbox, confirm, input } from '@inquirer/prompts';
import { Command } from 'commander';
import { AGENTS_SKILLS_UNION, APP_ROWS, type AppRow, appRows } from './apps.js';
import {
  type ComponentType,
  ConfigError,
  editSelection,
  effectivePlugins,
  effectiveSelection,
  loadConfig,
  type ResolvedConfig,
  resolveHomes,
  SELECTION_TYPES,
  withPluginExpansion,
} from './config.js';
import { expandHome, type RemoteSource } from './git.js';
import { type ImportOptions, type ImportResult, importFromApp } from './importer.js';
import {
  acquireRunLock,
  type Ledger,
  ledgerKey,
  ledgerPath,
  loadLedger,
  type RunLock,
  saveLedger,
} from './ledger.js';
import { buildPluginExpansion, type LibraryInventory, scanLibrary } from './library.js';
import { applyNative, captureNative, planNative } from './native.js';
import { loadPeerState, savePeerState } from './peer.js';
import {
  type Action,
  type CapturedHookApp,
  type CapturedMcpHost,
  type ExplainSlice,
  explainAgents,
  explainCommands,
  explainHooks,
  explainMcp,
  explainNative,
  explainRules,
  explainSkills,
  explainSources,
  groupKeyActions,
  planAgents,
  planCommands,
  planHooks,
  planLegacyOpencode,
  planMcp,
  planRules,
  planSkills,
  planSources,
  planStatusAll,
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
  parseStructured,
  removeBundleSlice,
  removeManagedFile,
  targetEscapesRoot,
  writeFileAtomic,
} from './shapes.js';
import {
  addLocalSource,
  addRemoteSource,
  ensureEntriesReady,
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
  /** Status-only: include inactive inventory and app/type probe rows. */
  all?: boolean;
  /** Status-only component id glob (`*` and `?`). */
  idGlob?: string;
  env?: NodeJS.ProcessEnv;
}

function captureFor(
  config: ReturnType<typeof loadConfig>,
  ledger: Ledger,
  table: readonly AppRow[],
  inventory: LibraryInventory,
  allApps = false
): SyncCapture {
  const capture: SyncCapture = {
    installed: {},
    targets: {},
    rulePaths: {},
    bundles: {},
    bundleDirs: {},
    hooks: {},
    mcp: {},
    legacy: [],
  };

  const captureFile = (root: string, targetPath: string): void => {
    if (capture.targets[targetPath]) return;
    const escapes = targetEscapesRoot(root, targetPath);
    try {
      capture.targets[targetPath] = {
        exists: true,
        content: fs.readFileSync(targetPath, 'utf-8'),
        escapes,
      };
    } catch {
      capture.targets[targetPath] = { exists: fs.existsSync(targetPath), content: null, escapes };
    }
  };
  if (allApps) {
    for (const row of table) capture.installed[row.id] = fs.existsSync(row.detectDir(config.homes));
  }
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId);
    if (!row) continue;
    capture.installed[appId] ??= fs.existsSync(row.detectDir(config.homes));
    if (!row.rules) continue;
    const targetPath = row.rules.path(config.homes);
    capture.rulePaths[appId] = targetPath;
    captureFile(row.rules.root(config.homes, targetPath), targetPath);
    for (const stale of ledger.entries) {
      if (
        stale.app !== appId ||
        stale.type !== 'rules' ||
        stale.id !== null ||
        stale.path === targetPath ||
        capture.targets[stale.path]
      ) {
        continue;
      }
      captureFile(row.rules.root(config.homes, stale.path), stale.path);
    }
  }

  // Commands and agents are own-file targets. Snapshot every selected or
  // known library filename plus every recorded path; the planner never
  // reverse-parses a filename into an id.
  for (const appId of config.apps.enabled) {
    const app = table.find((candidate) => candidate.id === appId);
    if (!app) continue;
    for (const type of ['commands', 'agents'] as const) {
      const row = app[type];
      if (!row) continue;
      const root = row.root(config.homes);
      const dir = row.dir(config.homes);
      const ids = new Set([
        ...effectiveSelection(config, appId, type),
        ...inventory.components
          .filter((component) => component.type === type)
          .map((component) => component.id),
      ]);
      for (const id of ids) captureFile(root, path.join(dir, row.filename(id)));
      for (const entry of ledger.entries) {
        if (entry.app === appId && entry.type === type && entry.shape === 'own-file') {
          captureFile(root, entry.path);
        }
      }
    }
  }

  // Skills parents: list present child dirs, then snapshot every bundle the
  // planner can possibly touch — selected, recorded, or name-present.
  const skillRows: { app: string; dir: string; root: string; reserved: readonly string[] }[] = [];
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId);
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

  // OpenCode 0.4 wrote singular command/agent/skill directories. Recognition
  // comes from the current library ids and row filename function, never from
  // parsing arbitrary user filenames. A present but unreadable singular dir
  // is captured as a failure instead of silently disabling cleanup.
  const opencode = table.find((row) => row.id === 'opencode');
  if (config.apps.enabled.includes('opencode') && opencode) {
    for (const type of ['commands', 'agents'] as const) {
      const row = opencode[type];
      if (!row) continue;
      const currentDir = row.dir(config.homes);
      const legacyDir = path.join(
        path.dirname(currentDir),
        type === 'commands' ? 'command' : 'agent'
      );
      const scan: SyncCapture['legacy'][number] = { type, path: legacyDir, entries: [] };
      if (fs.existsSync(legacyDir)) {
        try {
          const names = new Map<string, string[]>();
          for (const component of inventory.components.filter((item) => item.type === type)) {
            const filename = row.filename(component.id);
            names.set(filename, [...(names.get(filename) ?? []), component.id]);
          }
          for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            const ids = names.get(entry.name);
            if (ids?.length !== 1) continue;
            const legacyPath = path.join(legacyDir, entry.name);
            captureFile(row.root(config.homes), legacyPath);
            scan.entries.push({
              type,
              id: ids[0],
              path: legacyPath,
              currentPath: path.join(currentDir, entry.name),
              root: row.root(config.homes),
              bundle: false,
            });
          }
        } catch (error) {
          scan.error = error instanceof Error ? error.message : String(error);
        }
      }
      capture.legacy.push(scan);
    }

    if (opencode.skills) {
      const currentDir = opencode.skills.dir(config.homes);
      const legacyDir = path.join(path.dirname(currentDir), 'skill');
      const scan: SyncCapture['legacy'][number] = { type: 'skills', path: legacyDir, entries: [] };
      if (fs.existsSync(legacyDir)) {
        try {
          const ids = new Set(
            inventory.components.filter((item) => item.type === 'skills').map((item) => item.id)
          );
          for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
            if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !ids.has(entry.name)) continue;
            const legacyPath = path.join(legacyDir, entry.name);
            const exists = fs.existsSync(legacyPath);
            capture.bundles[legacyPath] = {
              exists,
              files: exists ? listTargetFiles(legacyPath) : null,
              fingerprint: exists ? (bundleFingerprint(legacyPath) ?? null) : null,
              escapes: targetEscapesRoot(opencode.skills.root(config.homes), legacyPath),
            };
            scan.entries.push({
              type: 'skills',
              id: entry.name,
              path: legacyPath,
              currentPath: path.join(currentDir, entry.name),
              root: opencode.skills.root(config.homes),
              bundle: true,
            });
          }
        } catch (error) {
          scan.error = error instanceof Error ? error.message : String(error);
        }
      }
      capture.legacy.push(scan);
    }
  }

  // Hooks: the app config it merges into, the peer record that says which
  // groups are asb's, and every bundle directory that record can reclaim.
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId)?.hooks;
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

  // MCP hosts: the document each app keeps its server map in. The path is
  // resolved here (opencode prefers an existing .jsonc) so the planner reads
  // one settled location rather than probing the disk itself.
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId)?.mcp;
    if (!row) continue;
    const hostPath = row.path(config.homes);
    const captured: CapturedMcpHost = {
      path: hostPath,
      exists: fs.existsSync(hostPath),
      content: null,
      root: {},
      tables: [],
      escapes: targetEscapesRoot(row.root(config.homes), hostPath),
    };
    if (captured.exists) {
      try {
        captured.content = fs.readFileSync(hostPath, 'utf-8');
      } catch (error) {
        captured.root = null;
        captured.error = error instanceof Error ? error.message : String(error);
      }
      if (captured.content !== null) {
        const document = parseStructured(captured.content, row.format);
        captured.root = document.root;
        captured.tables = document.tables;
        if (document.error !== undefined) captured.error = document.error;
      }
    }
    capture.mcp[appId] = captured;
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
  let changed = false;
  for (const mutation of Array.isArray(action.ledger) ? action.ledger : [action.ledger]) {
    if (mutation.op === 'put') {
      const key = ledgerKey(mutation.entry);
      const index = ledger.entries.findIndex((entry) => ledgerKey(entry) === key);
      if (index >= 0) ledger.entries[index] = mutation.entry;
      else ledger.entries.push(mutation.entry);
      changed = true;
      continue;
    }
    const before = ledger.entries.length;
    ledger.entries = ledger.entries.filter((entry) => ledgerKey(entry) !== mutation.key);
    changed = changed || ledger.entries.length !== before;
  }
  return changed;
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
      if (action.op === 'write' && !Array.isArray(action.ledger) && action.ledger?.op === 'put') {
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
  const failedPaths = new Set<string>();

  for (const action of actions) {
    const slotKey = `${action.app}\0${action.type}`;
    const slot = failed.get(slotKey) ?? NO_FAILURES;

    const blocker = action.requires?.find((id) => slot.has(id));
    const pathBlocker = action.requiresPaths?.find((required) => failedPaths.has(required));
    if (blocker !== undefined || pathBlocker !== undefined) {
      entries.push({
        ...toEntry(action),
        outcome: 'skipped',
        detail: blocker !== undefined ? 'bundle-failed' : 'replacement-failed',
        reason:
          blocker !== undefined
            ? `hook bundle ${blocker} did not land this run; leaving this alone until it does`
            : `replacement target ${pathBlocker} did not land this run; preserving the previous target`,
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
    if (entry.path !== null && FAILING_OUTCOMES.has(entry.outcome)) failedPaths.add(entry.path);
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

function matchesIdGlob(id: string, glob: string): boolean {
  // ponytail: ID globs support `*` and `?`; add a dedicated matcher if the CLI
  // contract grows character classes or brace expansion.
  const source = [...glob]
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    )
    .join('');
  return new RegExp(`^${source}$`).test(id);
}

function isComponentType(value: string | null): value is ComponentType {
  return value !== null && (SELECTION_TYPES as readonly string[]).includes(value);
}

function statusActionMatchesId(action: Action, glob: string, config: ResolvedConfig): boolean {
  if (action.id !== null) return matchesIdGlob(action.id, glob);
  if (
    action.app === null ||
    !isComponentType(action.type) ||
    action.detail === 'app-lacks-type' ||
    action.detail === 'app-not-installed'
  ) {
    return false;
  }
  return effectiveSelection(config, action.app, action.type).some((id) => matchesIdGlob(id, glob));
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
  const table = appRows(config);

  // A real run takes the lock before ledger and capture: the whole
  // capture → plan → apply sequence executes against serialized state, so a
  // plan built from another run's pre-apply snapshot can never fire.
  const lock: RunLock | null = dryRun ? null : acquireRunLock(config.homes.stateHome);
  const scope = {
    profile: config.profile,
    project: config.project,
    dryRun,
  };

  try {
    const ledger = loadLedger(config.homes.stateHome);
    const sources = runSourcesPhase(config, opts, dryRun);
    let catalog = readSourceCatalog(config);

    // Readiness and resolution are pre-write conditions. Distributing against
    // a partial inventory re-renders every aggregate without the broken
    // source's members, so a real run reports what the sources phase found
    // and stops before it can write anything. Content asb could not read
    // inside a source that did resolve stays a contained row.
    if (
      !dryRun &&
      (catalog.unresolved.length > 0 || sources.readiness.some((row) => row.status === 'error'))
    ) {
      const aborted = buildReport(
        scope,
        planSources({
          config,
          catalog: { ...catalog, absent: [] },
          ...sources,
          entries: [],
          dryRun,
        }).map(toEntry),
        { aborted: true }
      );
      if (ledger.lastRun) aborted.lastRun = ledger.lastRun;
      return aborted;
    }

    let inventory = scanLibrary({ env, plugins: catalog.plugins });

    // What the sources contribute is only known after the scan, so the
    // expansion joins the configuration here rather than at load time.
    let resolved = withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));

    // An external entry is content the selection points at and the scan could
    // not see, so fetching one changes what the library holds: read it again.
    const sourceEntries = ensureEntriesReady(resolved, catalog, { dryRun });
    if (sourceEntries.some((entry) => entry.status === 'fetched')) {
      catalog = readSourceCatalog(config);
      inventory = scanLibrary({ env, plugins: catalog.plugins });
      resolved = withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));
    }

    const capture = captureFor(resolved, ledger, table, inventory, opts.all === true);
    const nativeState = captureNative(resolved, catalog, table, env, capture.installed, dryRun);

    const planInput = {
      config: resolved,
      inventory,
      ledger,
      capture,
      table,
      now: new Date().toISOString(),
    };
    let actions = [
      ...planSources({ config: resolved, catalog, ...sources, entries: sourceEntries, dryRun }),
      ...planRules(planInput),
      ...planCommands(planInput),
      ...planAgents(planInput),
      ...planSkills(planInput),
      ...planLegacyOpencode(planInput),
      ...planHooks(planInput),
      ...planMcp(planInput),
      // Native rows run last: their registration setting shares a document
      // with the hooks target, and this one re-reads it after that write.
      ...planNative({
        config: resolved,
        catalog,
        capture: nativeState,
        table,
        env,
        installed: capture.installed,
        dryRun,
      }),
    ];

    if (opts.all === true) {
      // The typed probe rows replace the rules planner's one generic app
      // absence row and make `--type` filtering unambiguous.
      actions = actions.filter(
        (action) =>
          !(action.app !== null && action.type === null && action.detail === 'app-not-installed')
      );
      const represented = new Set(
        actions.flatMap((action) =>
          action.id === null || action.type === null ? [] : [`${action.type}\0${action.id}`]
        )
      );
      actions.push(
        ...planStatusAll(planInput).filter(
          (action) =>
            action.detail !== 'not-selected' ||
            action.id === null ||
            action.type === null ||
            !represented.has(`${action.type}\0${action.id}`)
        )
      );
    }

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
    if (opts.idGlob) {
      actions = actions.filter((action) =>
        statusActionMatchesId(action, opts.idGlob as string, resolved)
      );
    }
    actions = groupKeyActions(actions);

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
  const table = appRows(config);
  const ledger = loadLedger(config.homes.stateHome);
  const catalog = readSourceCatalog(config);
  const inventory = scanLibrary({ env, plugins: catalog.plugins });
  const resolved = withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));
  const capture = captureFor(resolved, ledger, table, inventory);
  const nativeState = captureNative(resolved, catalog, table, env, capture.installed, true);

  const planInput = {
    config: resolved,
    inventory,
    ledger,
    capture,
    table,
    now: new Date().toISOString(),
  };
  const wantedTypes = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  const wants = (type: string): boolean => wantedTypes === null || wantedTypes.has(type);
  // Explain never clones or fetches: it reads what a preview would report.
  let slices = [
    ...explainSources(
      {
        config: resolved,
        catalog,
        readiness: ensureSourcesReady(resolved, { dryRun: true }),
        updates: [],
        pendingRefresh: [],
        entries: ensureEntriesReady(resolved, catalog, { dryRun: true }),
        dryRun: true,
      },
      target
    ),
    ...(wants('rules') ? explainRules(planInput, target) : []),
    ...(wants('commands') ? explainCommands(planInput, target) : []),
    ...(wants('agents') ? explainAgents(planInput, target) : []),
    ...(wants('skills') ? explainSkills(planInput, target) : []),
    ...(wants('hooks') ? explainHooks(planInput, target) : []),
    ...(wants('mcp') ? explainMcp(planInput, target) : []),
    ...(wants('native_plugins')
      ? explainNative(
          {
            config: resolved,
            catalog,
            capture: nativeState,
            table,
            env,
            installed: capture.installed,
            dryRun: true,
          },
          target
        )
      : []),
  ];
  if (opts.apps && opts.apps.length > 0) {
    const wanted = new Set(opts.apps);
    slices = slices.filter((slice) => slice.app === null || wanted.has(slice.app));
  }
  // A source row carries its configured location, which can carry a token.
  return slices.map((slice) => {
    const clean = { ...slice };
    if (slice.reason) clean.reason = redactCredentials(slice.reason);
    if (slice.path) clean.path = redactCredentials(slice.path);
    return clean;
  });
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

  // Retirement compares canonical ids, so it needs the same expansion the
  // selection was written against.
  const { retired } = removeSource(withPluginExpansion(config, expansion), namespace, {
    componentIds,
    pluginIds,
    env,
  });

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

export async function runImport(
  app: string,
  sourcePath: string | undefined,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const config = loadConfig();
  const row = appRows(config).find((candidate) => candidate.id === app);
  if (!row) throw new ConfigError(`Unknown app "${app}".`);
  return importFromApp(row, config.homes, sourcePath, options);
}

export interface InitResult {
  path: string;
  outcome: 'written' | 'skipped';
  agentsPath?: string;
}

/** Write the dormant M6 project example; M7 owns making project scope live. */
export function runInit(
  projectDir: string,
  options: { force?: boolean; createAgentsMd?: boolean } = {}
): InitResult {
  const root = path.resolve(projectDir);
  const configPath = path.join(root, '.asb.toml');
  if (fs.existsSync(configPath) && !options.force) return { path: configPath, outcome: 'skipped' };

  const homes = resolveHomes(process.env);
  const detected = new Set(
    APP_ROWS.filter((row) => fs.existsSync(row.detectDir(homes))).map((row) => row.id)
  );
  const appLines = APP_ROWS.map((row) =>
    detected.has(row.id) ? `#   "${row.id}", # detected` : `#   # "${row.id}",`
  );
  const cells = (['rules', 'commands', 'agents', 'skills', 'hooks', 'mcp'] as const).flatMap(
    (type) => ['', `# [${type}]`, '# enabled = [] # add library component ids']
  );
  const scaffold = [
    '# ASB project configuration',
    '# Docs: README.md#project-configuration',
    '# Uncomment the sections you want M7 project scope to apply.',
    '',
    '# [applications]',
    '# enabled = [',
    ...appLines,
    '# ]',
    ...cells,
    '',
  ].join('\n');
  fs.mkdirSync(root, { recursive: true });
  writeFileAtomic(configPath, scaffold);

  const agentsPath = path.join(root, 'AGENTS.md');
  if (options.createAgentsMd && !fs.existsSync(agentsPath)) {
    writeFileAtomic(
      agentsPath,
      '# AGENTS.md\n\n## Project\n\nDescribe the project.\n\n## Commands\n\n```bash\n# Add project commands.\n```\n'
    );
    return { path: configPath, outcome: 'written', agentsPath };
  }
  return { path: configPath, outcome: 'written' };
}

// ---------------------------------------------------------------------------
// Argument parsing: scope flags are registered chain-wide and resolved once,
// so any flag ordering yields identical behavior.
// ---------------------------------------------------------------------------

export type CliOptions = SyncOptions & {
  json: boolean;
  update: boolean;
  noUpdate: boolean;
  all: boolean;
  sources: string[];
};

export type CliInvocation =
  | { command: 'sync' | 'status'; options: CliOptions }
  | { command: 'explain'; target: string; options: CliOptions }
  | { command: 'add'; location: string; options: CliOptions & AddSourceOptions }
  | { command: 'remove'; namespace: string; options: CliOptions }
  | {
      command: 'import';
      app: string;
      path: string | undefined;
      options: { types: string[]; recursive: boolean; force: boolean; json: boolean };
    }
  | { command: 'init'; options: { force: boolean; agentsMd: boolean; json: boolean } }
  | { command: 'enable' | 'disable'; ids: string[]; options: CliOptions };

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function resolvePickerOrder(value: string, selected: readonly string[]): string[] {
  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length !== selected.length) {
    throw new ConfigError(`Picker order must contain exactly ${selected.length} items.`);
  }
  const result = tokens.map((token) => {
    if (/^\d+$/.test(token)) return selected[Number.parseInt(token, 10) - 1];
    return selected.includes(token) ? token : undefined;
  });
  if (result.some((id) => id === undefined))
    throw new ConfigError('Picker order contains an unknown item.');
  if (new Set(result).size !== result.length)
    throw new ConfigError('Picker order contains a duplicate item.');
  return result as string[];
}

function registerScopeFlags(target: Command): Command {
  return target
    .option('-n, --dry-run', 'plan and report; write nothing, clone nothing')
    .option('--update', 'refresh managed clones after readiness, before planning')
    .option('--no-update', 'suppress refresh (including plugins.auto_update)')
    .option('--source <name>', 'filter the plan to entries from named sources', collect, [])
    .option('--app <app>', 'narrow the plan to named apps', collect, [])
    .option('--type <type>', 'narrow the plan to named types', collect, [])
    .option('--all', 'include inactive inventory and app/type probe rows (status only)')
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
      all: local.all === true || global.all === true,
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
    program
      .command('status')
      .description('inventory × selection × per-app reality')
      .argument('[idGlob]', 'component id glob')
  ).action((idGlob: string | undefined, _args: unknown, cmd: Command) => {
    parsed = {
      command: 'status',
      options: { ...scopeOptions(cmd), ...(idGlob === undefined ? {} : { idGlob }) },
    };
  });

  for (const command of ['enable', 'disable'] as const) {
    registerScopeFlags(
      program
        .command(command)
        .description(`${command} library components; enable with no ids opens the picker`)
        .argument('[ids...]', 'component or plugin ids')
    ).action((ids: string[], _args: unknown, cmd: Command) => {
      parsed = { command, ids, options: scopeOptions(cmd) };
    });
  }

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

  program
    .command('import')
    .description('copy existing app-side files into the ASB library')
    .argument('<app>', 'app id')
    .argument('[path]', 'source path; requires exactly one --type')
    .option('--type <type>', 'narrow to an importable type', collect, [])
    .option('-r, --recursive', 'walk source directories recursively')
    .option('-f, --force', 'overwrite existing library entries')
    .option('--json', 'machine-readable output')
    .action(
      (
        app: string,
        sourcePath: string | undefined,
        args: Record<string, unknown>,
        cmd: Command
      ) => {
        const global = cmd.parent?.opts() ?? {};
        parsed = {
          command: 'import',
          app,
          path: sourcePath,
          options: {
            types: [...(global.type ?? []), ...((args.type as string[] | undefined) ?? [])],
            recursive: args.recursive === true,
            force: args.force === true,
            json: args.json === true || global.json === true,
          },
        };
      }
    );

  program
    .command('init')
    .description('write a commented project .asb.toml scaffold')
    .option('-f, --force', 'overwrite an existing .asb.toml')
    .option('--agents-md', 'create an AGENTS.md skeleton when absent')
    .option('--json', 'machine-readable output')
    .action((args: Record<string, unknown>, cmd: Command) => {
      const global = cmd.parent?.opts() ?? {};
      parsed = {
        command: 'init',
        options: {
          force: args.force === true,
          agentsMd: args.agentsMd === true,
          json: args.json === true || global.json === true,
        },
      };
    });

  program.parse([...argv], { from: 'user' });

  if (!parsed) {
    throw new ConfigErrorLike('No command given.');
  }
  const invocation = parsed as CliInvocation;
  if (
    invocation.command !== 'status' &&
    'all' in invocation.options &&
    invocation.options.all === true
  ) {
    throw new ConfigErrorLike('--all is only available on status.');
  }
  return invocation;
}

class ConfigErrorLike extends Error {
  readonly exitCode = 2;
}

const SELECTABLE_TYPES = [
  'rules',
  'commands',
  'agents',
  'skills',
  'hooks',
  'mcp',
  'plugins',
] as const;
type SelectableType = (typeof SELECTABLE_TYPES)[number];

interface SelectionEntry {
  type: SelectableType;
  id: string;
  outcome: 'written';
}

function selectedFor(
  config: ResolvedConfig,
  type: SelectableType,
  app: string | undefined
): string[] {
  if (type === 'plugins') return app ? effectivePlugins(config, app) : config.selection.plugins;
  return app ? effectiveSelection(config, app, type) : config.selection[type];
}

function selectionTypes(
  id: string,
  requested: readonly string[],
  config: ResolvedConfig,
  inventory: LibraryInventory,
  catalog: SourceCatalog
): SelectableType[] {
  if (requested.length > 0) {
    const types = [...new Set(requested)];
    for (const type of types) {
      if (!SELECTABLE_TYPES.includes(type as SelectableType)) {
        throw new ConfigError(`Unknown selection type "${type}".`);
      }
    }
    return types as SelectableType[];
  }
  if (catalog.plugins.some((plugin) => plugin.id === id) || config.selection.plugins.includes(id)) {
    return ['plugins'];
  }
  const matches = SELECTABLE_TYPES.filter(
    (type) =>
      type !== 'plugins' &&
      (inventory.components.some((component) => component.type === type && component.id === id) ||
        config.selection[type].includes(id))
  );
  if (matches.length === 0) {
    throw new ConfigError(`Unknown component "${id}"; pass --type to record an unresolved id.`);
  }
  if (matches.length > 1) {
    throw new ConfigError(
      `Ambiguous component "${id}"; use ${matches.map((type) => `--type ${type}`).join(' or ')}.`
    );
  }
  return matches;
}

export async function runSelectionCommand(
  command: 'enable' | 'disable',
  ids: readonly string[],
  options: CliOptions
): Promise<{ entries: SelectionEntry[]; exitCode: 0 }> {
  const config = loadConfig({
    profile: options.profile,
    project: options.project,
    env: options.env,
  });
  const catalog = readSourceCatalog(config);
  const inventory = scanLibrary({ env: options.env, plugins: catalog.plugins });
  const grouped = new Map<SelectableType, string[]>();
  for (const id of ids) {
    for (const type of selectionTypes(id, options.types ?? [], config, inventory, catalog)) {
      grouped.set(type, [...(grouped.get(type) ?? []), id]);
    }
  }
  const apps = options.apps?.length ? options.apps : [undefined];
  const entries: SelectionEntry[] = [];
  for (const [type, values] of grouped) {
    for (const app of apps) {
      editSelection({
        type,
        ...(command === 'enable' ? { enable: values } : { disable: values }),
        ...(app ? { app } : {}),
        profile: options.profile,
        project: options.project,
        env: options.env,
      });
    }
    entries.push(...values.map((id) => ({ type, id, outcome: 'written' as const })));
  }
  return { entries, exitCode: 0 };
}

async function runSelectionPicker(
  options: CliOptions
): Promise<{ entries: SelectionEntry[]; exitCode: 0 }> {
  if ((options.apps?.length ?? 0) > 1) {
    throw new ConfigError('The interactive picker accepts at most one --app.');
  }
  const config = loadConfig({
    profile: options.profile,
    project: options.project,
    env: options.env,
  });
  const catalog = readSourceCatalog(config);
  const inventory = scanLibrary({ env: options.env, plugins: catalog.plugins });
  const app = options.apps?.[0];
  const requested = options.types?.length ? options.types : SELECTABLE_TYPES;
  const types = requested.map((type) => {
    if (!SELECTABLE_TYPES.includes(type as SelectableType)) {
      throw new ConfigError(`Unknown selection type "${type}".`);
    }
    return type as SelectableType;
  });
  const choices = new Map<string, { name: string; checked: boolean }>();
  for (const type of types) {
    const current = selectedFor(config, type, app);
    const ids =
      type === 'plugins'
        ? catalog.plugins.map((plugin) => plugin.id)
        : inventory.components
            .filter((component) => component.type === type)
            .map((component) => component.id);
    for (const id of [...current, ...ids]) {
      const value = `${type}\0${id}`;
      choices.set(value, { name: `${type}: ${id}`, checked: current.includes(id) });
    }
  }
  const picked = await checkbox({
    message: 'Select components to enable',
    choices: [...choices].map(([value, choice]) => ({ value, ...choice })),
  });
  const desired = new Map<SelectableType, string[]>();
  for (const token of picked) {
    const [type, id] = token.split('\0') as [SelectableType, string];
    desired.set(type, [...(desired.get(type) ?? []), id]);
  }
  const entries: SelectionEntry[] = [];
  for (const type of types) {
    let order = desired.get(type) ?? [];
    if (order.length > 1) {
      while (true) {
        const answer = await input({
          message: `Order ${type} (comma-separated ids or positions; blank keeps order)`,
        });
        if (!answer.trim()) break;
        try {
          order = resolvePickerOrder(answer, order);
          break;
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
    const current = selectedFor(config, type, app);
    if (app) {
      editSelection({
        type,
        app,
        enable: order.filter((id) => !current.includes(id)),
        disable: current.filter((id) => !order.includes(id)),
        profile: options.profile,
        project: options.project,
        env: options.env,
      });
    } else {
      editSelection({
        type,
        replace: order,
        profile: options.profile,
        project: options.project,
        env: options.env,
      });
    }
    entries.push(...order.map((id) => ({ type, id, outcome: 'written' as const })));
  }
  return { entries, exitCode: 0 };
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
    if (invocation.command === 'enable' || invocation.command === 'disable') {
      const result =
        invocation.ids.length > 0
          ? await runSelectionCommand(invocation.command, invocation.ids, invocation.options)
          : await runSelectionPicker(invocation.options);
      process.stdout.write(
        invocation.options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${result.entries.map((entry) => `written ${entry.type}:${entry.id}`).join('\n')}\n`
      );
      return 0;
    }

    if (invocation.command === 'import') {
      const result = await runImport(invocation.app, invocation.path, {
        ...invocation.options,
        confirm: (targetPath) =>
          confirm({ message: `File exists: ${targetPath}. Overwrite?`, default: false }),
      });
      process.stdout.write(
        invocation.options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${result.entries
              .map(
                (entry) =>
                  `${entry.outcome} ${entry.type}:${entry.id || '(source)'} ${entry.path || entry.sourcePath}${entry.reason ? ` (${entry.reason})` : ''}`
              )
              .join('\n')}\n`
      );
      return result.exitCode;
    }

    if (invocation.command === 'init') {
      const configPath = path.join(process.cwd(), '.asb.toml');
      if (
        fs.existsSync(configPath) &&
        !invocation.options.force &&
        !(await confirm({ message: '.asb.toml already exists. Overwrite?', default: false }))
      ) {
        return 0;
      }
      const createAgentsMd =
        invocation.options.agentsMd ||
        (!fs.existsSync(path.join(process.cwd(), 'AGENTS.md')) &&
          (await confirm({ message: 'Create AGENTS.md skeleton?', default: true })));
      const result = runInit(process.cwd(), { force: true, createAgentsMd });
      process.stdout.write(
        invocation.options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `written ${result.path}${result.agentsPath ? `\nwritten ${result.agentsPath}` : ''}\n`
      );
      return 0;
    }

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
