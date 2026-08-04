import fs from 'node:fs';
import path from 'node:path';
import { checkbox, confirm, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { AGENTS_SKILLS_UNION, APP_ROWS, type AppRow, appRows, projectAppRows } from './apps.js';
import {
  type ComponentType,
  ConfigError,
  editSelection,
  effectiveSelection,
  loadConfig,
  mergeIncrementalSelection,
  nearestKey,
  projectConfigPath,
  type ResolvedConfig,
  resolveHomes,
  SELECTION_TYPES,
  selectionDelta,
  withPluginExpansion,
} from './config.js';
import { expandHome, type RemoteSource } from './git.js';
import { type ImportOptions, type ImportResult, importFromApp } from './importer.js';
import { buildPluginExpansion, type LibraryInventory, scanLibrary } from './library.js';
import { applyNative, captureNative, planNative } from './native.js';
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
  type ProjectPlanPolicy,
  pathInside,
  planAgents,
  planCatalogStatus,
  planCodexProjectTrust,
  planCommands,
  planHooks,
  planLegacyOpencode,
  planMcp,
  planRules,
  planSelectedPluginGaps,
  planSkills,
  planSources,
  planStatusAll,
  preflightProjectActions,
  STATUS_TYPES,
  type SyncCapture,
} from './plan.js';
import {
  type ActionEntry,
  buildJsonEnvelope,
  buildReport,
  FAILING_OUTCOMES,
  type RenderOptions,
  type Report,
  type ReportEntry,
  redactCredentials,
  renderCompactStatus,
  renderExplain,
  renderReport,
} from './report.js';
import {
  acquireRunLock,
  clearOwnershipStores,
  lastRunPath,
  loadLastRun,
  type RunLock,
  saveLastRun,
} from './runstate.js';
import {
  applyBundleFiles,
  bundleFingerprint,
  hashContent,
  isContainedIn,
  legacyDedicatedRulesPath,
  listTargetFiles,
  parseStructured,
  removeBundleSlice,
  removeManagedFile,
  resolveWritePath,
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
  retireSourceSelection,
  type SourceCatalog,
  type UpdateRow,
  updateSources,
  validateSourcePath,
} from './sources.js';

/**
 * Command bodies. `runSync` is the one reconciliation: load → capture →
 * plan → (apply) → report, run once for the machine's scope and then, when a
 * project root is in play, once for what that repository adds over it.
 * Preview is the same pipeline with the writer disabled — the actions are
 * computed once from one captured input, so preview and apply cannot diverge
 * structurally.
 */

export interface SyncOptions {
  dryRun?: boolean;
  apps?: readonly string[];
  types?: readonly string[];
  /** Selection file standing in for `config.toml` this run. */
  profile?: string;
  /** Project root; the invocation directory's own `.asb.toml` is found without it. */
  project?: string;
  sources?: readonly string[];
  /** Component ids a retirement is taking out; no scope wants them this run. */
  retiring?: readonly string[];
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

/**
 * Containment for one declared target. A row rooted in the repository answers
 * the project phase's only question — does the write land inside it — so on
 * top of the parent-chain rule it is also measured on the path the write
 * resolves to: a leaf symlinked out of the tree is an escape, not the
 * write-through the user scope allows, a parent chain that leaves the
 * tree stays an escape even when the leaf loops back in, and a write
 * landing on one of the machine's own resolved surfaces is an escape
 * however the row reached it. Rows rooted elsewhere (the machine's Codex
 * trust host) keep the parent-chain rule alone.
 */
function escapesRoot(root: string, targetPath: string, project?: ProjectGuard): boolean {
  if (targetEscapesRoot(root, targetPath)) return true;
  if (project === undefined || !pathInside(project.root, path.resolve(root))) {
    return false;
  }
  if (!project.complete) return true;
  const resolved = locateWrite(targetPath);
  // Unresolvable (a link cycle in the chain): not provably contained.
  if (resolved === null) return true;
  return (
    !isContainedIn(project.root, resolved) ||
    project.surfaces.some((surface) => pathInside(surface, resolved))
  );
}

function captureFor(
  config: ResolvedConfig,
  table: readonly AppRow[],
  inventory: LibraryInventory,
  selection: (appId: string, type: ComponentType) => string[],
  allApps = false,
  project?: ProjectGuard
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
    const escapes = escapesRoot(root, targetPath, project);
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
    if (row.rules.dedicated) {
      const legacy = legacyDedicatedRulesPath(targetPath);
      captureFile(row.rules.root(config.homes, legacy), legacy);
    }
  }

  // Commands and agents are own-file targets. Snapshot every selected and
  // every known library filename; the planner never reverse-parses a filename
  // into an id.
  for (const appId of config.apps.enabled) {
    const app = table.find((candidate) => candidate.id === appId);
    if (!app) continue;
    for (const type of ['commands', 'agents'] as const) {
      const row = app[type];
      if (!row) continue;
      const root = row.root(config.homes);
      const dir = row.dir(config.homes);
      const ids = new Set([
        ...selection(appId, type),
        ...inventory.components
          .filter((component) => component.type === type)
          .map((component) => component.id),
      ]);
      for (const id of ids) captureFile(root, path.join(dir, row.filename(id)));
    }
  }

  // Skills parents: list present child dirs, then snapshot every bundle the
  // planner can possibly touch — selected or name-present.
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
      dir: AGENTS_SKILLS_UNION.dir(config.homes, config.project ?? undefined),
      root: AGENTS_SKILLS_UNION.root(config.homes, config.project ?? undefined),
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

    const selected = row.app === 'agents' ? [] : selection(row.app, 'skills');
    const unionSelected =
      row.app === 'agents'
        ? AGENTS_SKILLS_UNION.members
            .filter((member) => config.apps.enabled.includes(member))
            .flatMap((member) => selection(member, 'skills'))
        : [];
    const candidates = new Set(
      [...selected, ...unionSelected, ...present].filter(
        (id) => !id.startsWith('.') && !row.reserved.includes(id)
      )
    );
    for (const id of candidates) {
      const bundlePath = path.join(row.dir, id);
      if (capture.bundles[bundlePath]) continue;
      const escapes = escapesRoot(row.root, bundlePath, project);
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
              escapes: escapesRoot(opencode.skills.root(config.homes), legacyPath, project),
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

  // Hooks: the app config the groups merge into, and every bundle directory
  // a library hook could be sitting in.
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
      escapes: escapesRoot(root, configPath, project),
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

    // Every hook the library defines could have a bundle sitting there, so
    // each one is measured whether it is selected or not: that is what tells
    // a tree asb wrote from one it did not.
    const claimable = new Set([
      ...selection(appId, 'hooks'),
      ...inventory.components
        .filter((component) => component.type === 'hooks' && component.files !== undefined)
        .map((component) => component.id),
    ]);
    for (const id of claimable) {
      const bundlePath = path.join(row.bundleDir(config.homes), id);
      if (capture.bundles[bundlePath]) continue;
      const exists = fs.existsSync(bundlePath);
      capture.bundles[bundlePath] = {
        exists,
        files: exists ? listTargetFiles(bundlePath) : null,
        fingerprint: exists ? (bundleFingerprint(bundlePath) ?? null) : null,
        escapes: escapesRoot(root, bundlePath, project),
      };
    }
  }

  // MCP hosts: the document each app keeps its server map in. The path is
  // resolved here (opencode prefers an existing .jsonc) so the planner reads
  // one settled location rather than probing the disk itself.
  // A project run also reads the hosts of apps it is not enabled for, so a key
  // it wrote there before comes out when the app leaves the selection. Only an
  // existing file is opened, so this costs a stat per app.
  const mcpApps = new Set([
    ...config.apps.enabled,
    ...(config.project ? table.filter((row) => row.mcp).map((row) => row.id) : []),
  ]);
  for (const appId of mcpApps) {
    const row = table.find((candidate) => candidate.id === appId)?.mcp;
    if (!row) continue;
    const hostPath = row.path(config.homes);
    const captured: CapturedMcpHost = {
      path: hostPath,
      exists: fs.existsSync(hostPath),
      content: null,
      root: {},
      tables: [],
      escapes: escapesRoot(row.root(config.homes), hostPath, project),
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
  if (config.project && config.apps.enabled.includes('codex')) {
    const root = path.join(config.homes.agentsHome, '.codex');
    const hostPath = path.join(root, 'config.toml');
    const captured: CapturedMcpHost = {
      path: hostPath,
      exists: fs.existsSync(hostPath),
      content: null,
      root: {},
      tables: [],
      escapes: escapesRoot(root, hostPath, project),
    };
    if (captured.exists) {
      try {
        captured.content = fs.readFileSync(hostPath, 'utf-8');
      } catch (error) {
        captured.root = null;
        captured.error = error instanceof Error ? error.message : String(error);
      }
      if (captured.content !== null) {
        const document = parseStructured(captured.content, 'toml');
        captured.root = document.root;
        captured.tables = document.tables;
        if (document.error !== undefined) captured.error = document.error;
      }
    }
    capture.projectTrust = captured;
  }
  return capture;
}

function toEntry(action: Action): ActionEntry {
  const entry: ActionEntry = {
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

export function executeAction(action: Action, project?: ProjectGuard): ActionEntry {
  // Native rows own no file: the manager's own verbs are the apply, and its
  // reported state is the proof.
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
    ): ActionEntry => {
      const entry: ActionEntry = {
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
    if (escapesRoot(action.root, action.path, project)) {
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

      let leftBehind: string[] = [];
      try {
        if (action.op === 'write') {
          leftBehind = applyBundleFiles(action.path, action.bundle.files, action.bundle.stale);
        } else if (action.bundle.exclusive) {
          fs.rmSync(action.path, { recursive: true });
        } else {
          // A deletion that did not happen is never reported as one, or the
          // payload is orphaned by a false success: what is still on disk is
          // named instead, and the next run measures it again.
          const leftBehind = removeBundleSlice(action.path, action.bundle.stale);
          if (leftBehind.length > 0) {
            return failure(
              'left-behind',
              'remove-failed',
              `could not delete ${leftBehind.length} distributed file(s) under ${action.path}; it is still installed — fix its permissions or delete it yourself, then re-run asb sync`
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure('failed', 'write-error', message);
      }

      // A tree that cannot be measured after the write is a tree no later run
      // can prove is asb's, which is the same as never having written it.
      if (action.op === 'write' && bundleFingerprint(action.path) === undefined) {
        return failure(
          'failed',
          'write-error',
          'bundle is unprovable after writing (symlink or special file appeared)'
        );
      }

      if (leftBehind.length > 0) {
        return failure(
          'left-behind',
          'remove-failed',
          `could not delete ${leftBehind.length} distributed file(s) under ${action.path}; fix its permissions or delete it yourself, then re-run asb sync`
        );
      }

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

  return toEntry(action);
}

const NO_FAILURES: ReadonlySet<string> = new Set();

function reconcile(
  actions: readonly Action[],
  run: (action: Action) => ActionEntry
): ActionEntry[] {
  const entries: ActionEntry[] = [];
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

    const entry = run(action);
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

/**
 * Which source a row belongs to, for `--source`. Component ids carry their
 * plugin as a prefix, so attribution is a lookup, not a guess. A row nothing
 * attributes to a source — an app-level skip, an aggregate target, a write
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
    if (cut >= 0) return owners.get(action.id.slice(0, cut)) ?? 'library';
    if (action.type === 'plugins') {
      // A plugin ref nothing resolved still names its source after the `@`;
      // a ref with no recognizable source is never hidden by the filter.
      const at = action.id.lastIndexOf('@');
      if (at > 0) {
        const namespace = action.id.slice(at + 1);
        return owners.has(namespace) ? namespace : null;
      }
      return null;
    }
    return 'library';
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

function statusActionMatchesId(
  action: Action,
  glob: string,
  selection: (appId: string, type: ComponentType) => string[]
): boolean {
  if (action.id !== null) return matchesIdGlob(action.id, glob);
  if (
    action.app === null ||
    !isComponentType(action.type) ||
    action.detail === 'app-lacks-type' ||
    action.detail === 'app-not-installed'
  ) {
    return false;
  }
  return selection(action.app, action.type).some((id) => matchesIdGlob(id, glob));
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
  const only = opts.sources && opts.sources.length > 0 ? opts.sources : undefined;
  const readiness = ensureSourcesReady(config, { dryRun, only });
  const refreshing = opts.update === true || (config.plugins.autoUpdate && opts.noUpdate !== true);
  if (!refreshing) return { readiness, updates: [], pendingRefresh: [] };

  if (dryRun) {
    const scoped = refreshableSources(config).filter(
      (namespace) => !only || only.includes(namespace)
    );
    return { readiness, updates: [], pendingRefresh: scoped };
  }
  return { readiness, updates: updateSources(config, only ? { only } : {}), pendingRefresh: [] };
}

function extensionCutoverWarning(asbHome: string): Action[] {
  const extensions = path.join(asbHome, 'extensions');
  let found = false;
  try {
    found = fs
      .readdirSync(extensions, { withFileTypes: true })
      .some((entry) => entry.isFile() && /\.(?:mjs|js)$/i.test(entry.name));
  } catch {
    return [];
  }
  if (!found) return [];
  return [
    {
      app: null,
      type: null,
      id: null,
      path: extensions,
      op: 'none',
      outcome: 'skipped',
      detail: 'extensions-removed',
      reason:
        'executable .mjs/.js extensions were removed in 0.5; replace them with [targets.<id>]. These files still serve a 0.4 peer sharing the library and are not deleted at cut-over',
    },
  ];
}

/** Resolve through symlinks where possible; an absent path is its own answer. */
function canonical(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * `[plugins.sources]` outside `config.toml` is inert: the machine's own
 * configuration is the only one that can put a source on this machine, so a
 * profile's or a repository's declaration is reported and never cloned,
 * refreshed, or resolved. Its ids resolve against the machine's library like
 * any other. A declaration repeating `config.toml`'s own is reported too: it
 * is inert all the same, and the operator reads where the namespace resolves
 * from the row. Only one physical file read as two layers has nothing to say.
 */
function inertSources(config: ResolvedConfig, kind: 'profile' | 'project'): Action[] {
  const layer = config.layers.find((candidate) => candidate.kind === kind);
  const machine = config.layers.find((candidate) => candidate.kind === 'user');
  if (!layer || !machine || canonical(layer.path) === canonical(machine.path)) return [];
  return Object.entries(layer.values.plugins?.sources ?? {}).map(([namespace]) => ({
    app: null,
    type: null,
    id: namespace,
    path: layer.path,
    op: 'none' as const,
    outcome: 'skipped' as const,
    detail: `${kind}-source`,
    reason: `declared in ${kind === 'profile' ? 'this profile' : 'the project layer'}; sources live in ${machine.path} only, so nothing was cloned or resolved from it`,
  }));
}

/**
 * `-p`/`ASB_PROFILE` names the file the run reads its selection from, so a
 * name with no file behind it reconciles against nothing at all. An empty
 * report reads as a healthy no-op, which is the one thing this run is not.
 * A missing `config.toml` is left alone: that is a machine with no selection
 * yet, not a name that resolved to nothing.
 */
function missingProfile(config: ResolvedConfig): Action[] {
  const layer = config.layers.find((candidate) => candidate.kind === 'profile');
  if (!layer || layer.exists) return [];
  return [
    {
      app: null,
      type: null,
      id: config.profile,
      path: layer.path,
      op: 'none',
      outcome: 'missing',
      detail: 'profile-missing',
      reason: `no selection file at ${layer.path}; create it, or check the name given to -p / ASB_PROFILE`,
    },
  ];
}

/**
 * A profile that exists and enables no applications reconciles nothing.
 * Without the row that is indistinguishable from a run with nothing left to
 * do, and a profile is a file the run was told to read. `config.toml` enabling
 * nothing is that same empty run, and has always reported as one.
 */
function idleSelection(config: ResolvedConfig): Action[] {
  if (config.profile === null || config.apps.enabled.length > 0) return [];
  const layer = config.layers.find((candidate) => candidate.kind === 'profile');
  if (!layer?.exists) return [];
  return [
    {
      app: null,
      type: null,
      id: null,
      path: layer.path,
      op: 'none',
      outcome: 'skipped',
      detail: 'no-applications',
      reason:
        'this selection file enables no applications, so the run reconciles nothing; list them under [applications] enabled',
    },
  ];
}

/**
 * A cell with no project destination cannot host an increment: the repository
 * asked for content the project table has nowhere to put, so the gap is a row
 * rather than a silent drop.
 */
function unhostedIncrements(
  config: ResolvedConfig,
  table: readonly AppRow[],
  selection: (appId: string, type: ComponentType) => string[]
): Action[] {
  const actions: Action[] = [];
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId);
    if (!row) continue;
    for (const type of SELECTION_TYPES) {
      if (row[type] !== undefined) continue;
      const ids = selection(appId, type);
      if (ids.length === 0) continue;
      actions.push({
        app: appId,
        type,
        id: null,
        path: null,
        op: 'none',
        outcome: 'skipped',
        detail: 'no-project-target',
        reason: `${appId} has no project destination for ${type}; ${ids.join(', ')} reached no repository target`,
      });
    }
  }
  return actions;
}

/** resolveWritePath, with a link cycle resolving nowhere. */
function locateWrite(target: string): string | null {
  try {
    return resolveWritePath(target);
  } catch {
    return null;
  }
}

/**
 * The machine's own declared write surfaces for the rows given: files, and
 * managed parents. Which rows count is the caller's question — the refusal
 * scan speaks for the apps this run syncs, while the guard covers every row,
 * because a disabled app's dormant config is still the machine's file.
 */
function userSurfaces(
  base: ResolvedConfig,
  rows: readonly AppRow[],
  union: boolean
): { leaves: { what: string; dir: string }[]; dirs: string[]; complete: boolean } {
  let complete = true;
  const children = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).map((name) => path.join(dir, name));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') complete = false;
      return [];
    }
  };
  const leaves: { what: string; dir: string }[] = [];
  const dirs: string[] = [];
  for (const row of rows) {
    const paths: string[] = [];
    if (row.rules) {
      const targetPath = row.rules.path(base.homes);
      paths.push(targetPath);
      if (row.rules.dedicated) paths.push(legacyDedicatedRulesPath(targetPath));
    }
    if (row.mcp) paths.push(...(row.mcp.paths?.(base.homes) ?? [row.mcp.path(base.homes)]));
    if (row.hooks) {
      const bundleDir = row.hooks.bundleDir(base.homes);
      dirs.push(bundleDir);
      paths.push(row.hooks.path(base.homes), ...children(bundleDir));
    }
    for (const type of ['commands', 'agents'] as const) {
      const entry = row[type];
      if (!entry) continue;
      const dir = entry.dir(base.homes);
      dirs.push(dir);
      paths.push(...children(dir));
      if (row.id === 'opencode') {
        const legacyDir = path.join(path.dirname(dir), type === 'commands' ? 'command' : 'agent');
        dirs.push(legacyDir);
        paths.push(...children(legacyDir));
      }
      if (entry.config) paths.push(entry.config.path(base.homes));
    }
    if (row.skills) {
      const dir = row.skills.dir(base.homes);
      dirs.push(dir);
      paths.push(...children(dir));
      if (row.id === 'opencode') {
        const legacyDir = path.join(path.dirname(dir), 'skill');
        dirs.push(legacyDir);
        paths.push(...children(legacyDir));
      }
    }
    for (const leaf of paths) leaves.push({ what: `a ${row.id} user file`, dir: leaf });
  }
  if (union) {
    const dir = AGENTS_SKILLS_UNION.dir(base.homes);
    dirs.push(dir);
    for (const leaf of children(dir)) {
      leaves.push({ what: 'a shared agents skill', dir: leaf });
    }
  }
  return { leaves, dirs, complete };
}

/**
 * What the project phase must never touch: its containment root, plus the
 * resolved write locations of the machine's own configuration. Enumerating
 * project cells cannot be complete — cleanup reaches disabled apps and a
 * project leaf link redirects within the repository — so every project-phase
 * target is also measured against these at its own write location.
 */
export interface ProjectGuard {
  root: string;
  surfaces: readonly string[];
  complete: boolean;
}

function projectGuard(
  base: ResolvedConfig,
  userTable: readonly AppRow[],
  root: string
): ProjectGuard {
  const { leaves, dirs, complete: enumerationComplete } = userSurfaces(base, userTable, true);
  let complete = enumerationComplete;
  const locateSurface = (target: string): string | null => {
    try {
      fs.realpathSync(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ELOOP' && code !== 'ENOENT' && code !== 'ENOTDIR') {
        complete = false;
      }
    }
    try {
      return resolveWritePath(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== 'ELOOP' &&
        code !== 'ENOENT' &&
        code !== 'ENOTDIR' &&
        !(error instanceof Error && error.message.startsWith('ELOOP:'))
      ) {
        complete = false;
      }
      return null;
    }
  };
  const surfaces = [...leaves.map(({ dir }) => dir), ...dirs].flatMap(
    (target) => locateSurface(target) ?? []
  );
  return {
    root,
    surfaces,
    complete,
  };
}

/**
 * A user-scope leaf symlink is written through (Mackup), so a leaf whose
 * write location is a managed project destination hands the project phase the
 * user phase's own bytes as removable renders. Parent-chain links already
 * block as escapes and directory aliases match the root candidates; a leaf
 * link onto a project cell is the remaining static overlap. Both sides
 * resolve with the write path's own rule — dangling links followed, missing
 * tails lexical — so the scan sees exactly what a write would touch. A leaf
 * resolving elsewhere in the repository collides with nothing the project
 * phase manages and keeps both phases.
 */
function userLeafOnProjectCell(
  base: ResolvedConfig,
  userTable: readonly AppRow[],
  overlay: ResolvedConfig,
  overlayTable: readonly AppRow[]
): { what: string; dir: string } | null {
  const root = overlay.project as string;
  const cells: string[] = [];
  for (const row of overlayTable) {
    if (!overlay.apps.enabled.includes(row.id)) continue;
    if (row.rules?.projectPath) cells.push(row.rules.projectPath(root));
    for (const type of ['commands', 'agents'] as const) {
      const dir = row[type]?.projectDir?.(root);
      if (dir) cells.push(dir);
    }
    if (row.skills?.projectDir) cells.push(row.skills.projectDir(root));
    if (row.hooks?.projectPath) cells.push(row.hooks.projectPath(root));
    if (row.hooks?.projectBundleDir) cells.push(row.hooks.projectBundleDir(root));
    if (row.mcp?.projectPath) cells.push(row.mcp.projectPath(root));
  }
  if (AGENTS_SKILLS_UNION.participates(overlay.apps.enabled)) {
    cells.push(AGENTS_SKILLS_UNION.dir(base.homes, root));
  }
  // A cell resolving out of the repository is the outward alias the project
  // phase already blocks per row; only cells that stay inside can overlap.
  const resolvedCells = cells.flatMap((cell) => {
    const real = locateWrite(cell);
    return real !== null && pathInside(root, real) ? real : [];
  });

  const enabledRows = userTable.filter((row) => base.apps.enabled.includes(row.id));
  return (
    userSurfaces(
      base,
      enabledRows,
      AGENTS_SKILLS_UNION.participates(base.apps.enabled)
    ).leaves.find(({ dir }) => {
      const real = locateWrite(dir);
      return real !== null && resolvedCells.some((cell) => pathInside(cell, real));
    }) ?? null
  );
}

/**
 * The two views one run reconciles: the base selection file, and that file
 * with the project's own `.asb.toml` over it. `-P` names the project root;
 * otherwise the invocation directory's own `.asb.toml` names it, and only that
 * directory — a subdirectory of a repository is not the repository.
 */
function resolveScopes(
  opts: SyncOptions,
  env: NodeJS.ProcessEnv
): {
  base: ResolvedConfig;
  overlay: ResolvedConfig | null;
  userTable: readonly AppRow[];
  supersetTable: readonly AppRow[];
  projectTable: readonly AppRow[];
  project: ProjectPlanPolicy | undefined;
  /** User-scope rows the run earns before any phase plans. */
  notices: Action[];
} {
  const projectRoot =
    opts.project ??
    (fs.existsSync(path.join(process.cwd(), '.asb.toml')) ? process.cwd() : undefined);
  const base = loadConfig({ profile: opts.profile, env });
  const notices: Action[] = inertSources(base, 'profile');

  // The user phase never loads the project layer, so a `.asb.toml` that
  // replaces a list can never rewrite a global target, whatever directory the
  // run happens from.
  const userTable = appRows(base);

  // A repository the run only found by looking costs the project phase when
  // its layer is unusable, never the machine's own reconciliation: the row
  // carries what the loader said and the user phase still reconciles. Under
  // `-P` the root is the caller's own instruction, so the error is the answer.
  let overlay: ResolvedConfig | null = null;
  let overlayTable = userTable;
  if (projectRoot) {
    try {
      overlay = loadConfig({ profile: opts.profile, project: projectRoot, env });
      overlayTable = appRows(overlay);
    } catch (error) {
      if (opts.project !== undefined || !(error instanceof ConfigError)) throw error;
      overlay = null;
      notices.push({
        app: null,
        type: null,
        id: null,
        path: projectConfigPath(projectRoot),
        op: 'none',
        outcome: 'failed',
        detail: 'project-config',
        reason: `${error.message}; no project phase ran`,
      });
    }
  }

  // Two scopes writing one physical tree would let the project phase treat the
  // fresh user-phase writes under it as removable renders, so a root that
  // holds the agents home — or holds one enabled app's own directory, aliased
  // into it — is refused whole and the report says so.
  if (overlay?.project) {
    const root = overlay.project;
    const held = [
      { what: 'the agents home', dir: base.homes.agentsHome },
      // The union row writes under a root no single app row declares.
      ...(AGENTS_SKILLS_UNION.participates(base.apps.enabled)
        ? [{ what: 'the shared agents directory', dir: AGENTS_SKILLS_UNION.root(base.homes) }]
        : []),
      ...userTable
        .filter((row) => base.apps.enabled.includes(row.id))
        .flatMap((row) =>
          [
            // Detection and writing may live apart (Trae detects in the
            // vendor data dir, writes under ~/.trae), so every declared
            // containment root counts, not the detection heuristic alone.
            row.detectDir(base.homes),
            ...(['rules', 'commands', 'agents', 'skills', 'hooks', 'mcp'] as const).flatMap(
              (type) => row[type]?.root(base.homes) ?? []
            ),
          ].map((dir) => ({ what: `${row.id}'s own directory`, dir }))
        ),
    ].find((candidate) => pathInside(root, canonical(candidate.dir)));
    const overlap = held ?? userLeafOnProjectCell(base, userTable, overlay, overlayTable);
    if (overlap) {
      notices.push({
        app: null,
        type: null,
        id: null,
        path: root,
        op: 'none',
        outcome: 'skipped',
        detail: 'project-refused',
        reason: `project root holds ${overlap.what} (${overlap.dir}); one tree cannot be both scopes, so no project phase ran`,
      });
      overlay = null;
    }
  }

  const supersetTable = overlay ? overlayTable : userTable;
  const mode = overlay?.distribution.project.mode;
  const project: ProjectPlanPolicy | undefined =
    overlay?.project && (mode === 'managed' || mode === 'exclusive')
      ? {
          root: overlay.project,
          mode,
          collision: mode === 'exclusive' ? 'takeover' : overlay.distribution.project.collision,
          explicit: opts.project !== undefined,
        }
      : undefined;
  return {
    base,
    overlay,
    userTable,
    supersetTable,
    // Mode "none" leaves the project phase out of the run entirely.
    projectTable: project ? projectAppRows(supersetTable, project.root) : [],
    project,
    notices,
  };
}

export async function runSync(opts: SyncOptions = {}, heldLock?: RunLock): Promise<Report> {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun === true;

  const {
    base,
    overlay,
    userTable,
    supersetTable,
    projectTable,
    project: projectPolicy,
    notices,
  } = resolveScopes(opts, env);
  const preludeRows = [
    ...notices,
    ...missingProfile(base),
    ...idleSelection(base),
    ...extensionCutoverWarning(base.homes.asbHome),
  ];
  const knownTypes = new Set<string>(STATUS_TYPES);
  for (const type of opts.types ?? []) {
    if (knownTypes.has(type)) continue;
    const suggestion = nearestKey(type, STATUS_TYPES);
    throw new ConfigError(
      `Unknown status type "${type}"${suggestion ? ` — did you mean "${suggestion}"?` : '.'}`
    );
  }
  const appIds = supersetTable.map((row) => row.id);
  const knownApps = new Set(appIds);
  for (const app of opts.apps ?? []) {
    if (knownApps.has(app)) continue;
    const suggestion = nearestKey(app, appIds);
    throw new ConfigError(
      `Unknown app "${app}"${suggestion ? ` — did you mean "${suggestion}"?` : '.'}`
    );
  }

  // A real run takes the lock before the first capture and holds it across
  // both phases: every capture → plan → apply sequence executes against
  // serialized state, so a plan built from another run's pre-apply snapshot
  // can never fire.
  const lock: RunLock | null = dryRun ? null : (heldLock ?? acquireRunLock(base.homes.stateHome));
  const ownsLock = !dryRun && heldLock === undefined;
  // Only a project the run actually reconciles is this run's scope: a root
  // refused, or left out by mode "none", is named by its own row instead.
  const scope = {
    profile: base.profile,
    project: projectPolicy?.root ?? null,
    dryRun,
  };

  try {
    const previousLastRun = loadLastRun(base.homes.stateHome);
    if (!dryRun) clearOwnershipStores(base.homes.stateHome, base.homes.asbHome);
    // Sources, catalog, inventory and expansion describe the one library both
    // phases read, and it is the machine's: they materialize once, from the
    // base infrastructure alone, so no clone, fetch, or namespace resolution
    // can originate in a repository. Overlay selections resolve against what
    // that library holds.
    const sources = runSourcesPhase(base, opts, dryRun);
    let catalog = readSourceCatalog(base);

    // Readiness and resolution are pre-write conditions. Distributing against
    // a partial inventory re-renders every aggregate without the broken
    // source's members, so a real run reports what the sources phase found
    // and stops before it can write anything. Content asb could not read
    // inside a source that did resolve stays a contained row.
    const selectedSources = opts.sources?.length ? new Set(opts.sources) : null;
    const blockingUnresolved = catalog.unresolved.filter(
      (row) => selectedSources === null || selectedSources.has(row.namespace)
    );
    if (blockingUnresolved.length > 0 || sources.readiness.some((row) => row.status === 'error')) {
      const aborted = buildReport(
        scope,
        [
          ...preludeRows,
          ...planSources({
            config: base,
            catalog: { ...catalog, absent: [] },
            ...sources,
            entries: [],
            dryRun,
          }),
        ].map((action) => ({ ...toEntry(action), scope: 'user' as const })),
        { aborted: true }
      );
      if (previousLastRun) aborted.lastRun = previousLastRun;
      return aborted;
    }

    let inventory = scanLibrary({ env, plugins: catalog.plugins });
    let expansion = buildPluginExpansion(catalog.plugins, inventory);

    // An external entry is content the selection points at and the scan could
    // not see, so fetching one changes what the library holds: read it again.
    const sourceEntries = ensureEntriesReady(withPluginExpansion(base, expansion), catalog, {
      dryRun,
    });
    if (sourceEntries.some((entry) => entry.status === 'fetched')) {
      catalog = readSourceCatalog(base);
      inventory = scanLibrary({ env, plugins: catalog.plugins });
      expansion = buildPluginExpansion(catalog.plugins, inventory);
    }

    // What the sources contribute is only known after the scan, so the
    // expansion joins both views here rather than at load time.
    const resolvedBase = withPluginExpansion(base, expansion);
    const resolvedOverlay = overlay ? withPluginExpansion(overlay, expansion) : null;

    // Readiness materializes before planning, so a real run's catalog already
    // proves what a cloned source provides; only a dry run still has
    // namespaces whose content is unknowable.
    const pendingNamespaces = new Set(
      dryRun
        ? sources.readiness
            .filter((row) => row.action && row.status !== 'error')
            .map((row) => row.namespace)
        : []
    );
    // What the machine's own selection file points at is what the library owes
    // it, so the user phase reports exactly these; a repository adds a gap of
    // its own, never hides or invents one at user scope.
    const baseGaps = planSelectedPluginGaps(resolvedBase, catalog, pendingNamespaces);
    const baseGapIds = new Set(baseGaps.map((action) => action.id));

    // Ids a retirement is taking out are wanted in neither scope this run:
    // whatever the selection files still say, this run distributes none of
    // them, so the sweep takes every copy while the library can still prove
    // it instead of stranding one past its own entry.
    const retiring = new Set(opts.retiring ?? []);
    const wanted = (ids: readonly string[]): string[] =>
      retiring.size === 0 ? [...ids] : ids.filter((id) => !retiring.has(id));
    const userSelection = (appId: string, type: ComponentType): string[] =>
      wanted(effectiveSelection(resolvedBase, appId, type));

    const outOfScopeUnresolved =
      selectedSources === null
        ? []
        : catalog.unresolved.filter((row) => !selectedSources.has(row.namespace));

    /**
     * One pipeline, run once per scope: capture → plan → filters → shared-host
     * merge → project preflight → reconcile. Rows about the library itself
     * belong to the user phase, which speaks for it once.
     */
    const runPhase = (
      config: ResolvedConfig,
      table: readonly AppRow[],
      selection: (appId: string, type: ComponentType) => string[],
      project?: ProjectPlanPolicy
    ): ReportEntry[] => {
      const userPhase = project === undefined;
      const guard = project ? projectGuard(resolvedBase, userTable, project.root) : undefined;
      const capture = captureFor(config, table, inventory, selection, opts.all === true, guard);
      const planInput = {
        config,
        inventory,
        capture,
        table,
        selection,
        ...(project ? { project } : {}),
      };
      const mcpActions = planMcp(planInput);
      let actions = [
        ...(userPhase
          ? [
              ...preludeRows,
              ...planSources({
                config: resolvedBase,
                catalog,
                ...sources,
                entries: sourceEntries,
                dryRun,
              }),
            ]
          : [...inertSources(config, 'project'), ...unhostedIncrements(config, table, selection)]),
        ...planRules(planInput),
        ...planCommands(planInput),
        ...planAgents(planInput),
        ...planSkills(planInput),
        ...(userPhase ? planLegacyOpencode(planInput) : []),
        ...planHooks(planInput),
        ...mcpActions,
        // Project trust is written for a repository, from an explicit root:
        // the user phase has no project to trust.
        ...(project ? planCodexProjectTrust(planInput, mcpActions) : []),
        // Native rows run last: their registration setting shares a document
        // with the hooks target, and this one re-reads it after that write. A
        // plugin manager is the machine's, so only the user phase speaks to it.
        ...(userPhase
          ? planNative({
              config,
              catalog,
              capture: captureNative(config, catalog, table, env, capture.installed, dryRun),
              table,
              env,
              installed: capture.installed,
              dryRun,
            })
          : []),
      ];

      if (outOfScopeUnresolved.length > 0) {
        const names = outOfScopeUnresolved.map((row) => row.namespace).join(', ');
        actions = actions.map((action) =>
          action.app !== null &&
          action.id === null &&
          action.type !== null &&
          ['rules', 'hooks', 'mcp'].includes(action.type)
            ? {
                app: action.app,
                type: action.type,
                id: null,
                path: action.path,
                op: 'none',
                outcome: 'failed',
                detail: 'aggregate-blocked',
                reason: `source(s) ${names} are unresolved outside this --source run; previous aggregate content is left in place`,
              }
            : action
        );
      }

      if (userPhase && opts.all === true) {
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
      // The catalog is the machine's, so the phase that speaks for it reports
      // what it holds.
      if (userPhase && (opts.all === true || opts.types?.includes('plugins') === true)) {
        actions.push(...planCatalogStatus(resolvedBase, catalog, inventory));
      }
      // Each phase names the refs its own selection cannot resolve, less the
      // ones the user phase already reported.
      actions.push(
        ...(userPhase
          ? baseGaps
          : planSelectedPluginGaps(config, catalog, pendingNamespaces).filter(
              (action) => !baseGapIds.has(action.id)
            ))
      );

      // Filters select which actions execute, never which inputs the planner saw.
      if (opts.apps && opts.apps.length > 0) {
        const wanted = new Set(opts.apps);
        actions = actions.filter(
          (action) =>
            action.app === null ||
            wanted.has(action.app) ||
            action.members?.some((member) => wanted.has(member)) === true
        );
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
        actions = actions.filter(
          (action) =>
            action.detail === 'extensions-removed' ||
            statusActionMatchesId(action, opts.idGlob as string, selection)
        );
      }
      actions = groupKeyActions(actions);
      if (project) actions = preflightProjectActions(actions, project);

      const phaseScope: ReportEntry['scope'] = userPhase ? 'user' : 'project';
      return reconcile(actions, dryRun ? toEntry : (action) => executeAction(action, guard)).map(
        (entry) => ({
          ...entry,
          scope: phaseScope,
        })
      );
    };

    // Strictly in order: the project phase captures after the user phase has
    // applied, so it plans against what that phase wrote (the shared Codex
    // config) instead of stale bytes.
    const entries = runPhase(resolvedBase, userTable, userSelection);
    if (projectPolicy && resolvedOverlay) {
      // A repository carries only what it adds: user-scope content is already
      // visible to every app in every directory, so distributing it again
      // would double-load it.
      const overlayConfig = resolvedOverlay;
      const projectSelection = (appId: string, type: ComponentType): string[] =>
        wanted(selectionDelta(overlayConfig, resolvedBase, appId, type));
      entries.push(...runPhase(overlayConfig, projectTable, projectSelection, projectPolicy));
    }

    // Every real run stamps the last-run fact and `status` (dry) reports it:
    // the one thing a run leaves behind that the next one does not re-derive.
    // It is the user phase's, like every other machine-local file — the
    // project phase writes nothing outside the repository.
    if (!dryRun) {
      const counts = new Map<string, number>();
      for (const entry of entries) {
        counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
      }
      try {
        saveLastRun(base.homes.stateHome, {
          at: new Date().toISOString(),
          summary:
            [...counts.entries()].map(([outcome, count]) => `${count} ${outcome}`).join(', ') ||
            'nothing to do',
        });
      } catch (error) {
        // The marker is a convenience, not proof of anything: every slice
        // re-derives next run whether or not this landed. Say so and move on.
        const message = error instanceof Error ? error.message : String(error);
        entries.push({
          app: null,
          type: null,
          id: null,
          path: lastRunPath(base.homes.stateHome),
          outcome: 'failed',
          detail: 'write-error',
          reason: `last-run marker could not be saved (${message})`,
          scope: 'user',
        });
      }
    }

    const report = buildReport(scope, entries);
    if (previousLastRun) report.lastRun = previousLastRun;
    return report;
  } finally {
    if (ownsLock) lock?.release();
  }
}

/** An explain row carries the phase that produced it, as a report entry does. */
export type ScopedSlice = ExplainSlice & { scope: ReportEntry['scope'] };

export async function runExplain(
  target: string,
  opts: SyncOptions = {}
): Promise<{ scope: Report['scope']; slices: ScopedSlice[] }> {
  const env = opts.env ?? process.env;
  const {
    base,
    overlay,
    userTable,
    projectTable,
    project: projectPolicy,
  } = resolveScopes(opts, env);
  validateAppIds(overlay ?? base, opts.apps ?? []);
  // The library is the machine's in both phases, so it resolves from the base
  // infrastructure exactly as a sync resolves it.
  const catalog = readSourceCatalog(base);
  const inventory = scanLibrary({ env, plugins: catalog.plugins });
  const expansion = buildPluginExpansion(catalog.plugins, inventory);
  const resolvedBase = withPluginExpansion(base, expansion);
  const resolvedOverlay = overlay ? withPluginExpansion(overlay, expansion) : null;

  const wantedTypes = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  const wants = (type: string): boolean => wantedTypes === null || wantedTypes.has(type);

  // The same two scopes a sync reconciles, read instead of applied.
  const explainPhase = (
    config: ResolvedConfig,
    table: readonly AppRow[],
    selection: (appId: string, type: ComponentType) => string[],
    project?: ProjectPlanPolicy
  ): ScopedSlice[] => {
    const scope: ReportEntry['scope'] = project === undefined ? 'user' : 'project';
    const guard = project ? projectGuard(resolvedBase, userTable, project.root) : undefined;
    const capture = captureFor(config, table, inventory, selection, false, guard);
    const planInput = {
      config,
      inventory,
      capture,
      table,
      selection,
      ...(project ? { project } : {}),
    };
    return [
      ...(wants('rules') ? explainRules(planInput, target) : []),
      ...(wants('commands') ? explainCommands(planInput, target) : []),
      ...(wants('agents') ? explainAgents(planInput, target) : []),
      ...(wants('skills') ? explainSkills(planInput, target) : []),
      ...(wants('hooks') ? explainHooks(planInput, target) : []),
      ...(wants('mcp') ? explainMcp(planInput, target) : []),
      ...(project === undefined && wants('native_plugins')
        ? explainNative(
            {
              config,
              catalog,
              capture: captureNative(config, catalog, table, env, capture.installed, true),
              table,
              env,
              installed: capture.installed,
              dryRun: true,
            },
            target
          )
        : []),
    ].map((slice) => ({ ...slice, scope }));
  };

  // Explain never clones or fetches: it reads what a preview would report.
  let slices: ScopedSlice[] = [
    ...explainSources(
      {
        config: resolvedBase,
        catalog,
        readiness: ensureSourcesReady(resolvedBase, { dryRun: true }),
        updates: [],
        pendingRefresh: [],
        entries: ensureEntriesReady(resolvedBase, catalog, { dryRun: true }),
        dryRun: true,
      },
      target,
      inventory
    ).map((slice) => ({ ...slice, scope: 'user' as const })),
    ...explainPhase(resolvedBase, userTable, (appId, type) =>
      effectiveSelection(resolvedBase, appId, type)
    ),
    ...(projectPolicy && resolvedOverlay
      ? explainPhase(
          resolvedOverlay,
          projectTable,
          (appId, type) => selectionDelta(resolvedOverlay, resolvedBase, appId, type),
          projectPolicy
        )
      : []),
  ];
  if (opts.apps && opts.apps.length > 0) {
    const wanted = new Set(opts.apps);
    slices = slices.filter((slice) => slice.app === null || wanted.has(slice.app));
  }
  // A source row carries its configured location, which can carry a token.
  return {
    // The scopes the answer covers are the ones this read resolved, exactly as
    // a sync names them: a root refused, or left out by mode "none", is no
    // more this answer's project than an absent one.
    scope: { profile: base.profile, project: projectPolicy?.root ?? null, dryRun: false },
    slices: slices.map((slice) => {
      const clean = { ...slice };
      if (slice.reason) clean.reason = redactCredentials(slice.reason);
      if (slice.path) clean.path = redactCredentials(slice.path);
      return clean;
    }),
  };
}

// ---------------------------------------------------------------------------
// Source lifecycle commands
// ---------------------------------------------------------------------------

export interface AddSourceOptions extends SyncOptions {
  /** Namespace to file the source under; inferred from the location otherwise. */
  as?: string;
  ref?: string;
  subtree?: boolean;
  /** Require the source to carry a marketplace manifest. */
  marketplace?: boolean;
}

/**
 * Declare a source. A git transport clones (or subtrees) into asb's own tree
 * first and is declared only once that succeeded; anything else is a local
 * directory the user keeps owning. The persisted declaration is always
 * credential-free, so a token in the argument never reaches the selection file.
 */
export async function runAddSource(location: string, opts: AddSourceOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const config = loadConfig({ profile: opts.profile, env });
  const namespace = opts.as?.trim() || inferSourceName(location);
  const scope = { profile: config.profile, project: config.project, dryRun: false };

  const expanded = expandHome(location);
  if (opts.marketplace && !isGitUrl(expanded) && !expanded.endsWith('.git')) {
    const validation = validateSourcePath(expanded);
    if (!validation.valid || validation.kind !== 'marketplace') {
      throw new ConfigError('Source does not contain a marketplace manifest.');
    }
  }
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
  if (opts.marketplace && contents?.kind !== 'marketplace') {
    removeSource(loadConfig({ profile: opts.profile, env }), namespace, { env });
    throw new ConfigError('Source does not contain a marketplace manifest.');
  }
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
      scope: 'user',
    },
  ]);
}

/** One row per id this command disabled: a config edit is never silent. */
function retiredEntries(
  retired: readonly { type: ComponentType | 'plugins' | 'native_plugins'; id: string }[],
  namespace: string
): ReportEntry[] {
  return retired.map((row) => ({
    app: null,
    type: row.type,
    id: row.id,
    path: null,
    outcome: 'removed' as const,
    detail: 'retired',
    reason: `disabled in [${row.type}] because source "${namespace}" provided it`,
    scope: 'user' as const,
  }));
}

/**
 * Retire a source: its managed content, its declaration, its derived caches,
 * and every enabled entry it put there. The retired ids are reported one per
 * row — a config edit the user did not type is never silent.
 *
 * A distributed slice proves it is asb's by matching what the library renders,
 * so the order is load-bearing: this source's entries leave the selection
 * first, a full distribution takes their targets out while the source can
 * still be rendered, and only then does the content itself go. Removing the
 * content first would leave every file it distributed behind, unprovable.
 */
export async function runRemoveSource(namespace: string, opts: SyncOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const lock = acquireRunLock(resolveHomes(env).stateHome);
  try {
    const config = loadConfig({ profile: opts.profile, env });
    let scope = { profile: config.profile, project: config.project, dryRun: false };
    const catalog = readSourceCatalog(config);
    const source = catalog.sources.find((candidate) => candidate.namespace === namespace);
    if (!source?.configured) throw new ConfigError(`Source "${namespace}" not found.`);
    if (catalog.failed.some((failure) => failure.namespace === namespace)) {
      return buildReport(scope, [
        {
          app: null,
          type: null,
          id: namespace,
          path: source.path,
          outcome: 'blocked',
          reason: `kept: source "${namespace}" could not be read completely; repair it before removal`,
          scope: 'user',
        },
      ]);
    }

    const inventory = scanLibrary({ env, plugins: catalog.plugins });
    const expansion = buildPluginExpansion(catalog.plugins, inventory);
    const sourcePlugins = catalog.plugins.filter((plugin) => plugin.source === namespace);
    const pluginIds = sourcePlugins.map((plugin) => plugin.id);
    const pluginIdSet = new Set(pluginIds);
    const failed = inventory.failed.filter((component) => pluginIdSet.has(component.source));
    const componentIds = [
      ...new Set([
        ...pluginIds.flatMap((id) => Object.values(expansion.byPlugin[id] ?? {}).flat()),
        ...failed.map((component) => component.id),
      ]),
    ];
    const distributedTypes = new Set<ComponentType>([
      ...pluginIds.flatMap((id) => Object.keys(expansion.byPlugin[id] ?? {}) as ComponentType[]),
      ...failed.map((component) => component.type),
    ]);
    const enabledApps = new Set(config.apps.enabled);
    const assumeInstalled = new Set(config.apps.assumeInstalled);
    const hasNative = sourcePlugins.some((plugin) => plugin.native !== undefined);
    const inactive = appRows(config)
      .filter((row) => !enabledApps.has(row.id))
      .filter((row) => assumeInstalled.has(row.id) || fs.existsSync(row.detectDir(config.homes)))
      .filter(
        (row) =>
          [...distributedTypes].some((type) => row[type] !== undefined) ||
          (hasNative && row.native !== undefined)
      )
      .map((row) => row.id);
    if (inactive.length > 0) {
      return buildReport(scope, [
        {
          app: null,
          type: null,
          id: namespace,
          path: source.path,
          outcome: 'blocked',
          reason: `kept: installed but inactive app(s) ${inactive.join(', ')} may still hold content from this source; enable and sync them before re-running asb remove ${namespace}`,
          scope: 'user',
        },
      ]);
    }

    // Retirement compares canonical ids, so it needs the same expansion the
    // selection was written against. Every channel goes at once: a component
    // still selected through the plugin list or a per-app override would
    // survive the sweep below and outlive the library entry that proves it.
    const retired = retireSourceSelection(
      withPluginExpansion(config, expansion),
      namespace,
      componentIds,
      pluginIds,
      env
    );
    // Unfiltered on purpose: a `--source`, `--app`, or `--type` narrowing meant
    // for the report would otherwise leave part of what this source distributed
    // behind, and nothing could prove it later.
    const swept = await runSync(
      {
        profile: opts.profile,
        project: opts.project,
        // The project layer is the repository's file, not asb's to edit, so a
        // `.asb.toml` still naming these ids keeps wanting them. Naming them
        // here is what lets the sweep take their project copies while the
        // library can still prove them.
        retiring: componentIds,
        noUpdate: true,
        env,
      },
      lock
    );
    // The sweep is what reaches a repository at all, so from here on its own
    // header is the run's scope: anything else names a root these rows contradict.
    scope = swept.scope;
    const unrelatedAbort =
      swept.exitCode === 2 &&
      swept.entries.some(
        (entry) =>
          entry.id !== namespace && entry.outcome === 'failed' && entry.detail === 'source-error'
      );
    if (unrelatedAbort) {
      return buildReport(scope, [
        {
          app: null,
          type: null,
          id: namespace,
          path: source.path,
          outcome: 'blocked',
          reason: `kept: the cleanup run aborted before it could prove every distributed slice was removed; resolve the rows below and re-run asb remove ${namespace}`,
          scope: 'user',
        },
        ...retiredEntries(retired, namespace),
        ...swept.entries,
      ]);
    }

    // A slice this source distributed that the sweep could not take is the one
    // state the source has to outlive: while it is still declared the library
    // can render that slice, so fixing the cause and re-running finishes the
    // job. `missing` and a hand-edited copy are not that state — neither
    // resolves on a later run, and holding the source hostage to them would
    // pin it in the config forever.
    const distributed = new Set(componentIds);
    const stranded = swept.entries.filter((entry) => {
      const mine =
        entry.id !== null
          ? distributed.has(entry.id)
          : entry.type !== null && distributedTypes.has(entry.type as ComponentType);
      if (!mine) return false;
      if (
        entry.outcome === 'failed' ||
        entry.outcome === 'blocked' ||
        entry.outcome === 'conflict'
      ) {
        return true;
      }
      // A deletion the file system refused, and one a project collision
      // suppressed, are the retryable shapes: the bytes are still the ones the
      // library renders, so the next run takes them once the cause is fixed.
      return (
        (entry.outcome === 'left-behind' && entry.detail === 'remove-failed') ||
        (entry.outcome === 'skipped' && entry.detail === 'project-preflight')
      );
    });
    if (stranded.length > 0) {
      return buildReport(scope, [
        {
          app: null,
          type: null,
          id: namespace,
          path: source.path,
          outcome: 'blocked',
          reason: `kept: ${stranded.length} slice(s) it distributed could not be taken, and removing it now would leave them with nothing able to prove them; resolve the rows below and re-run asb remove ${namespace}`,
          scope: 'user',
        },
        ...retiredEntries(retired, namespace),
        ...swept.entries,
      ]);
    }

    const remaining = loadConfig({ profile: opts.profile, env });
    retired.push(
      ...removeSource(withPluginExpansion(remaining, expansion), namespace, {
        componentIds,
        pluginIds,
        env,
      }).retired
    );

    const entries: ReportEntry[] = [
      {
        app: null,
        type: null,
        id: namespace,
        path: source.path,
        outcome: 'removed',
        reason: 'source removed with everything it distributed',
        scope: 'user',
      },
      ...retiredEntries(retired, namespace),
    ];
    return buildReport(scope, [...entries, ...swept.entries]);
  } finally {
    lock.release();
  }
}

export async function runImport(
  app: string,
  sourcePath: string | undefined,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const base = loadConfig();
  const catalog = readSourceCatalog(base);
  const inventory = scanLibrary({ plugins: catalog.plugins });
  const config = withPluginExpansion(base, buildPluginExpansion(catalog.plugins, inventory));
  const row = appRows(config).find((candidate) => candidate.id === app);
  if (!row) throw new ConfigError(`Unknown app "${app}".`);
  return importFromApp(row, config.homes, sourcePath, options, { config, inventory });
}

export interface InitResult {
  path: string;
  outcome: 'written' | 'skipped';
  agentsPath?: string;
}

/** Write the commented project example a sync in this directory reads. */
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
    '# `asb sync` in this directory reconciles your user scope first, then',
    '# distributes what this file adds on top of it into this repository.',
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
  | { command: 'summary' | 'sync' | 'status'; options: CliOptions }
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
    .option('-p, --profile <name>', 'selection file to use in place of config.toml')
    .option('-P, --project <dir>', 'project root; otherwise ./.asb.toml is detected')
    .option('--json', 'machine-readable output');
}

export function parseCliArgs(argv: readonly string[]): CliInvocation {
  if (argv.length === 0) {
    return {
      command: 'summary',
      options: {
        dryRun: true,
        update: false,
        noUpdate: false,
        sources: [],
        apps: [],
        types: [],
        all: false,
        json: false,
      },
    };
  }
  let parsed: CliInvocation | null = null;

  const program = new Command();
  const version = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
  ).version as string;
  program
    .name('asb')
    .description(
      'reconcile agent configuration in two scopes: the machine from its selection file, then a repository from its own .asb.toml'
    )
    .version(version)
    .exitOverride();
  program.configureOutput({
    writeOut: (message) => process.stdout.write(message),
    writeErr: () => {},
  });
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
    program
      .command('sync')
      .description(
        'reconcile every installed app: user scope from the selection file, then the project increment'
      )
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
        .description(`${command} library components; with no ids opens the picker`)
        .argument('[ids...]', 'component or plugin ids')
    ).action((ids: string[], _args: unknown, cmd: Command) => {
      parsed = { command, ids, options: scopeOptions(cmd) };
    });
  }

  registerScopeFlags(
    program
      .command('explain')
      .description('one target: owner, current and desired hashes, desired content')
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
      .option('--marketplace', 'require a marketplace manifest')
  ).action((location: string, args: Record<string, unknown>, cmd: Command) => {
    parsed = {
      command: 'add',
      location,
      options: {
        ...scopeOptions(cmd),
        as: args.as as string | undefined,
        ref: args.ref as string | undefined,
        subtree: args.subtree === true,
        marketplace: args.marketplace === true,
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
  const allowedScope = new Map<CliInvocation['command'], ReadonlySet<string>>([
    ['summary', new Set()],
    [
      'sync',
      new Set(['dryRun', 'update', 'noUpdate', 'sources', 'apps', 'types', 'profile', 'project']),
    ],
    ['status', new Set(['apps', 'types', 'profile', 'project', 'all'])],
    ['explain', new Set(['apps', 'types', 'profile', 'project'])],
    ['enable', new Set(['apps', 'types', 'profile', 'project'])],
    ['disable', new Set(['apps', 'types', 'profile', 'project'])],
    ['add', new Set()],
    ['remove', new Set()],
    ['import', new Set(['types'])],
    ['init', new Set()],
  ]);
  const root = program.opts();
  const options = 'options' in invocation ? invocation.options : {};
  const scopeValues: Record<string, unknown> = {
    dryRun: 'dryRun' in options ? options.dryRun : root.dryRun,
    update: 'update' in options ? options.update : root.update,
    noUpdate: 'noUpdate' in options ? options.noUpdate : root.update === false,
    sources: 'sources' in options ? options.sources : root.source,
    apps: 'apps' in options ? options.apps : root.app,
    types: 'types' in options ? options.types : root.type,
    all: 'all' in options ? options.all : root.all,
    profile: 'profile' in options ? options.profile : root.profile,
    project: 'project' in options ? options.project : root.project,
  };
  const flagNames: Record<string, string> = {
    dryRun: '--dry-run',
    update: '--update',
    noUpdate: '--no-update',
    sources: '--source',
    apps: '--app',
    types: '--type',
    all: '--all',
    profile: '--profile',
    project: '--project',
  };
  for (const [key, value] of Object.entries(scopeValues)) {
    const used = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
    if (used && !allowedScope.get(invocation.command)?.has(key)) {
      throw new ConfigErrorLike(`${flagNames[key]} is not available on ${invocation.command}.`);
    }
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
  reason?: string;
}

function validateAppIds(config: ResolvedConfig, ids: readonly string[]): void {
  const known = appRows(config).map((row) => row.id);
  for (const id of ids) {
    if (known.includes(id)) continue;
    const suggestion = nearestKey(id, known);
    throw new ConfigError(
      `Unknown app "${id}"${suggestion ? ` — did you mean "${suggestion}"?` : '.'}`
    );
  }
}

export function selectedFor(
  config: ResolvedConfig,
  type: SelectableType,
  app: string | undefined
): string[] {
  const targetKind = config.project ? 'project' : config.profile ? 'profile' : 'user';
  const layer = config.layers.find((candidate) => candidate.kind === targetKind);
  if (!layer) return [];
  if (!app) return [...(layer.values[type]?.enabled ?? [])];
  const override = layer.values.applications?.[app]?.[type];
  return mergeIncrementalSelection([], override);
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
  if (
    config.plugins.expansion?.pluginAliases[id] !== undefined ||
    catalog.plugins.some((plugin) => plugin.id === id) ||
    config.selection.plugins.includes(id)
  ) {
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
  const lock = acquireRunLock(resolveHomes(options.env ?? process.env).stateHome);
  try {
    const config = loadConfig({
      profile: options.profile,
      project: options.project,
      env: options.env,
    });
    validateAppIds(config, options.apps ?? []);
    const catalog = readSourceCatalog(config);
    const inventory = scanLibrary({ env: options.env, plugins: catalog.plugins });
    const resolved = withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));
    const grouped = new Map<SelectableType, string[]>();
    for (const id of ids) {
      for (const type of selectionTypes(id, options.types ?? [], resolved, inventory, catalog)) {
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
      entries.push(
        ...values.map((id): SelectionEntry => {
          const known =
            type === 'plugins'
              ? resolved.plugins.expansion?.pluginAliases[id] !== undefined
              : inventory.components.some(
                  (component) => component.type === type && component.id === id
                );
          return {
            type,
            id,
            outcome: 'written',
            ...(command === 'enable' && !known
              ? { reason: 'cannot validate this id yet; it will be validated at the next sync' }
              : {}),
          };
        })
      );
    }
    return { entries, exitCode: 0 };
  } finally {
    lock.release();
  }
}

async function runSelectionPicker(
  options: CliOptions
): Promise<{ entries: SelectionEntry[]; exitCode: 0 }> {
  const lock = acquireRunLock(resolveHomes(options.env ?? process.env).stateHome);
  try {
    return await runLockedSelectionPicker(options);
  } finally {
    lock.release();
  }
}

async function runLockedSelectionPicker(
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
  validateAppIds(config, options.apps ?? []);
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
 * The one place the surface is decided: a terminal gets the interactive
 * layout, anything redirected keeps the text scripts already parse, and color
 * follows chalk's reading of FORCE_COLOR, TERM, CI, and Windows. Chalk 5 has
 * no NO_COLOR support of its own, so the standard's own rule — set and
 * non-empty means no color — is applied here rather than assumed.
 */
function surface(command?: RenderOptions['command']): RenderOptions {
  return {
    layout: process.stdout.isTTY ? 'interactive' : 'plain',
    color: (process.env.NO_COLOR ?? '') === '' && chalk.level > 0,
    command,
  };
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
    if ((error as { exitCode?: number }).exitCode === 0) return 0;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }

  try {
    const jsonScope = (options?: SyncOptions): Report['scope'] => ({
      profile: options?.profile ?? process.env.ASB_PROFILE?.trim() ?? null,
      project: options?.project ? path.resolve(options.project) : null,
      dryRun: options?.dryRun === true,
    });
    if (invocation.command === 'enable' || invocation.command === 'disable') {
      const result =
        invocation.ids.length > 0
          ? await runSelectionCommand(invocation.command, invocation.ids, invocation.options)
          : await runSelectionPicker(invocation.options);
      process.stdout.write(
        invocation.options.json
          ? `${JSON.stringify(buildJsonEnvelope(jsonScope(invocation.options), result.entries, result.exitCode), null, 2)}\n`
          : `${result.entries.map((entry) => `written ${entry.type}:${entry.id}${entry.reason ? ` (${entry.reason})` : ''}`).join('\n')}\n`
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
          ? `${JSON.stringify(buildJsonEnvelope(jsonScope(), result.entries, result.exitCode as 0 | 1), null, 2)}\n`
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
      const json = invocation.options.json;
      if (fs.existsSync(configPath) && !invocation.options.force) {
        // A machine consumer never gets a prompt: without --force an existing
        // config is answered with a skipped envelope instead of a question.
        const declined =
          json ||
          !(await confirm({ message: '.asb.toml already exists. Overwrite?', default: false }));
        if (declined) {
          process.stdout.write(
            json
              ? `${JSON.stringify(
                  buildJsonEnvelope(
                    jsonScope(),
                    [
                      {
                        path: configPath,
                        outcome: 'skipped',
                        reason: '.asb.toml already exists; pass --force to overwrite',
                      },
                    ],
                    0
                  ),
                  null,
                  2
                )}\n`
              : `skipped ${configPath} (.asb.toml already exists; pass --force to overwrite)\n`
          );
          return 0;
        }
      }
      const createAgentsMd =
        invocation.options.agentsMd ||
        (!json &&
          !fs.existsSync(path.join(process.cwd(), 'AGENTS.md')) &&
          (await confirm({ message: 'Create AGENTS.md skeleton?', default: true })));
      const result = runInit(process.cwd(), { force: true, createAgentsMd });
      process.stdout.write(
        invocation.options.json
          ? `${JSON.stringify(buildJsonEnvelope(jsonScope(), [result], 0), null, 2)}\n`
          : `written ${result.path}${result.agentsPath ? `\nwritten ${result.agentsPath}` : ''}\n`
      );
      return 0;
    }

    if (invocation.command === 'explain') {
      const { scope, slices } = await runExplain(invocation.target, invocation.options);
      // `explain` answers a question about one target, so it reports on the
      // wider set: a slice asb declined to touch is a run working as intended
      // but an answer of "not resolved", and a script asking about it wants
      // to hear so.
      const exitCode =
        slices.length > 0 && !slices.some((slice) => FAILING_OUTCOMES.has(slice.outcome)) ? 0 : 1;
      process.stdout.write(
        invocation.options.json
          ? `${JSON.stringify(buildJsonEnvelope(scope, slices, exitCode), null, 2)}\n`
          : renderExplain(slices, invocation.target, surface())
      );
      return exitCode;
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
      invocation.options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : invocation.command === 'summary'
          ? renderCompactStatus(report, surface(invocation.command))
          : renderReport(report, surface(invocation.command))
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
