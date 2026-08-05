import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AGENTS_SKILLS_UNION,
  type AppRow,
  type EntryTargetRow,
  type HooksTargetRow,
  type McpTargetRow,
  type RulesTargetRow,
} from './apps.js';
import {
  type ComponentType,
  effectiveIncludeDelimiters,
  effectivePlugins,
  isPlainObject,
  type ResolvedConfig,
  SELECTION_TYPES,
  selectedPluginIds,
} from './config.js';
import { preferHomeVar, sanitizeMcpName } from './dialects.js';
import { hookGroupOwner, stripLegacyMarkerLines } from './hooks.js';
import type { Component, HookEventMap, LibraryInventory } from './library.js';
import { type NativePlanInput, type NativeWork, planNative } from './native.js';
import type { Outcome } from './report.js';
import {
  applyKeysEdits,
  type BundleFile,
  composedFromRuleBlocks,
  composeRules,
  hashContent,
  type KeysEdit,
  type KeysFormat,
  keyedArrayProblem,
  keyedArraySegment,
  legacyDedicatedRulesPath,
  mergeProjectRegion,
  projectRegion,
  sliceHash,
  type TargetFile,
  targetModeMatchesSourceExecutableBits,
  tomlHeaderName,
  valueAtKeyPath,
} from './shapes.js';
import type { EntryRow, ReadinessRow, SourceCatalog, UpdateRow } from './sources.js';

/**
 * The pure planner: selection × inventory × table × captured fs state →
 * actions. Nothing here touches the filesystem; the capture is taken
 * once and shared by preview and apply, so they cannot diverge structurally.
 *
 * A rules target is asb's while it holds what the library renders for it, so
 * a selected slice that differs is written in one pass and a target that
 * already matches is left alone. Deselection removes only what the filename
 * still claims: a dedicated target asb named, never a shared host carrying
 * the app's own conventional name.
 */

export interface CapturedTarget {
  exists: boolean;
  content: string | null;
  /** Parent chain of the declared path resolves outside the app root. */
  escapes?: boolean;
}

export interface CapturedBundle {
  exists: boolean;
  /** Live file inventory; null when the tree is unprovable (symlinks etc.). */
  files: TargetFile[] | null;
  /** 0.4 `tree:` fingerprint of the live directory; null when unprovable. */
  fingerprint: string | null;
  /** Parent chain of the bundle directory resolves outside the app root. */
  escapes?: boolean;
}

export interface CapturedHookApp {
  path: string;
  exists: boolean;
  /** Current bytes; null when the config is absent or unreadable. */
  content: string | null;
  /** Parsed config root; null when it is not a JSON object. */
  config: Record<string, unknown> | null;
  /** Why the config could not be parsed, when it could not. */
  error?: string;
  /** Parent chain of the config path resolves outside the app root. */
  escapes?: boolean;
}

export interface CapturedMcpHost {
  /** Resolved host document; opencode's jsonc probe is settled here. */
  path: string;
  exists: boolean;
  content: string | null;
  /** Parsed document root; null when it is unreadable or not an object. */
  root: Record<string, unknown> | null;
  /** Why the document could not be parsed, when it could not. */
  error?: string;
  /** TOML table headers the byte-splice writer can address, one segment array per header. */
  tables: string[][];
  /** Parent chain of the host path resolves outside the app root. */
  escapes?: boolean;
}

export interface CapturedLegacyEntry {
  type: 'commands' | 'agents' | 'skills';
  id: string;
  path: string;
  currentPath: string;
  root: string;
  bundle: boolean;
}

export interface CapturedLegacyScan {
  type: CapturedLegacyEntry['type'];
  path: string;
  entries: CapturedLegacyEntry[];
  error?: string;
}

export interface SyncCapture {
  /** Detection probe results per app id. */
  installed: Record<string, boolean>;
  /** Current bytes per absolute target path (null when unreadable). */
  targets: Record<string, CapturedTarget>;
  /** Rules path resolved once per app during capture (dynamic rows included). */
  rulePaths: Record<string, string>;
  /** Live bundle state per absolute bundle directory. */
  bundles: Record<string, CapturedBundle>;
  /** Non-dot child directory names per managed skills parent. */
  bundleDirs: Record<string, string[]>;
  /** Hook config per app id. */
  hooks: Record<string, CapturedHookApp>;
  /** MCP host document per app id. */
  mcp: Record<string, CapturedMcpHost>;
  /** Global Codex TOML captured separately from the project MCP host. */
  projectTrust?: CapturedMcpHost;
  /** Recognized OpenCode singular-layout entries and any scan failure. */
  legacy: CapturedLegacyScan[];
}

export interface Action {
  app: string | null;
  type: string | null;
  id: string | null;
  path: string | null;
  op: 'write' | 'remove' | 'none';
  outcome: Outcome;
  detail?: string;
  reason?: string;
  /**
   * Desired bytes for `write`; on a `remove` whose target must survive as an
   * empty document, the form written through a symlinked target.
   */
  content?: string;
  /**
   * Component ids in this app whose own actions must land before this one may
   * run: a config may not point at payload the run failed to distribute.
   */
  requires?: string[];
  /** Target-path dependencies used when retiring a dynamically moved row. */
  requiresPaths?: string[];
  /**
   * Own-dir payload: files to reconcile and the rels on disk the render no
   * longer names. Present ⇒ the executor treats path as a bundle directory.
   */
  bundle?: { files: BundleFile[]; stale: string[]; exclusive?: boolean };
  /** Containment root for write/remove actions. */
  root?: string;
  /**
   * Hash the target must still carry at apply time (null = must be absent);
   * the executor re-reads and refuses on drift since planning.
   */
  expectedHash?: string | null;
  /**
   * Native-manager work: the app's own plugin manager owns the result, so
   * there is no path or hash — the commands are the apply.
   */
  native?: NativeWork;
  /** Structured edits retained so cells sharing one host can merge once. */
  keyEdits?: { format: KeysFormat; edits: KeysEdit[]; baseContent: string };
  /** Apps contributing to one shared project slice. */
  members?: string[];
  /** Project-triggered work outside the project root (Codex trust). */
  projectAction?: boolean;
}

export interface ProjectPlanPolicy {
  root: string;
  mode: 'managed' | 'exclusive';
  collision: 'warn-skip' | 'error' | 'takeover';
  /** `-P` named this root; a root detected in the cwd did not. */
  explicit: boolean;
}

export interface PlanInput {
  config: ResolvedConfig;
  inventory: LibraryInventory;
  capture: SyncCapture;
  table: readonly AppRow[];
  /**
   * The wanted set per app and type: the base file's selection in the user
   * phase, its increment over that file in the project phase. Planners never
   * derive it themselves, so one subtraction in the sync composition decides
   * what every planner distributes.
   */
  selection(appId: string, type: ComponentType): string[];
  /** Present exactly in the project phase. */
  project?: ProjectPlanPolicy;
}

export const STATUS_TYPES = [...SELECTION_TYPES, 'native_plugins', 'plugins'] as const;
type StatusType = (typeof STATUS_TYPES)[number];

function appSupports(row: AppRow, type: StatusType): boolean {
  if (type === 'plugins') return false;
  return type === 'native_plugins' ? row.native !== undefined : row[type] !== undefined;
}

/** Extra inventory/probe rows requested by `status --all`. */
export function planStatusAll(input: PlanInput): Action[] {
  const { config, inventory, capture, table } = input;
  const actions: Action[] = [];
  const selected = new Set<string>();
  for (const app of config.apps.enabled) {
    for (const type of SELECTION_TYPES) {
      for (const id of input.selection(app, type)) selected.add(`${type}\0${id}`);
    }
  }

  for (const component of inventory.components) {
    if (selected.has(`${component.type}\0${component.id}`)) continue;
    actions.push({
      app: null,
      type: component.type,
      id: component.id,
      path: component.path,
      op: 'none',
      outcome: 'skipped',
      detail: 'not-selected',
      reason: 'library component is not selected by any enabled app',
    });
  }

  const assumed = new Set(config.apps.assumeInstalled);
  for (const row of table) {
    for (const type of STATUS_TYPES) {
      if (type === 'plugins') continue;
      if (!appSupports(row, type)) {
        actions.push({
          app: row.id,
          type,
          id: null,
          path: null,
          op: 'none',
          outcome: 'skipped',
          detail: 'app-lacks-type',
          reason: `${row.id} has no ${type} target`,
        });
      } else if (capture.installed[row.id] !== true && !assumed.has(row.id)) {
        actions.push({
          app: row.id,
          type,
          id: null,
          path: null,
          op: 'none',
          outcome: 'skipped',
          detail: 'app-not-installed',
          reason: `${row.detectDir(config.homes)} not found; add "${row.id}" to [applications].assume_installed to sync anyway`,
        });
      }
    }
  }
  return actions;
}

/** Source and plugin catalog rows, including entries with no components. */
export function planCatalogStatus(
  config: ResolvedConfig,
  catalog: SourceCatalog,
  inventory: LibraryInventory
): Action[] {
  const selected = selectedPluginIds(config);
  const componentCounts = new Map<string, number>();
  for (const component of inventory.components) {
    componentCounts.set(component.source, (componentCounts.get(component.source) ?? 0) + 1);
  }
  const absentPaths = new Map(catalog.absent.map((plugin) => [plugin.id, plugin.path]));

  return [
    ...catalog.sources.map((source): Action => {
      const plugins = catalog.plugins.filter((plugin) => plugin.source === source.namespace);
      const components = plugins.reduce(
        (count, plugin) => count + (componentCounts.get(plugin.id) ?? 0),
        0
      );
      return {
        app: null,
        type: 'plugins',
        id: source.namespace,
        path: source.path,
        op: 'none',
        outcome: 'unchanged',
        detail: source.configured ? 'configured-source' : 'discovered-source',
        reason: `source is resolved; ${plugins.length} plugin(s), ${components} component(s)`,
      };
    }),
    ...catalog.plugins.map((plugin): Action => {
      const enabled = selected.has(plugin.id);
      const resolved = plugin.root !== undefined;
      return {
        app: null,
        type: 'plugins',
        id: plugin.id,
        path: plugin.root ?? absentPaths.get(plugin.id) ?? null,
        op: 'none',
        outcome: enabled && !resolved ? 'missing' : enabled ? 'unchanged' : 'skipped',
        detail: enabled ? (resolved ? 'selected' : 'unavailable') : 'not-selected',
        reason: `${enabled ? 'selected' : 'not selected'}; ${resolved ? 'resolved' : 'not materialized'}; ${componentCounts.get(plugin.id) ?? 0} component(s)`,
      };
    }),
  ];
}

/** Selected plugin refs nothing resolves or declares: visible in every run. */
export function planSelectedPluginGaps(
  config: ResolvedConfig,
  catalog: SourceCatalog,
  pendingNamespaces: ReadonlySet<string> = new Set()
): Action[] {
  const aliases = config.plugins.expansion?.pluginAliases ?? {};
  // Bare names stay out of `known`: an unambiguous name has an alias, so a
  // known bare name that reaches the filter is an ambiguous one that resolves
  // to nothing and must be visible.
  const known = new Set([
    ...catalog.plugins.map((plugin) => plugin.id),
    ...catalog.absent.map((plugin) => plugin.id),
  ]);
  const claimants = new Map<string, string[]>();
  for (const plugin of catalog.plugins) {
    claimants.set(plugin.name, [...(claimants.get(plugin.name) ?? []), plugin.source]);
  }
  const selected = [
    ...new Set([
      ...config.selection.plugins,
      ...config.apps.enabled.flatMap((appId) => effectivePlugins(config, appId)),
    ]),
  ];
  return selected
    .filter((ref) => aliases[ref] === undefined && !known.has(ref))
    .filter((ref) => {
      // A ref of a source this run still plans to materialize is not a gap:
      // the source's own pending row carries the next step.
      const at = ref.lastIndexOf('@');
      return at <= 0 || !pendingNamespaces.has(ref.slice(at + 1));
    })
    .map((ref): Action => {
      const providers = claimants.get(ref) ?? [];
      return {
        app: null,
        type: 'plugins',
        id: ref,
        path: null,
        op: 'none',
        outcome: 'missing',
        detail: 'unavailable',
        reason:
          providers.length > 1
            ? `${providers.length} sources provide "${ref}"; spell it name@source (${providers
                .map((source) => `${ref}@${source}`)
                .join(', ')})`
            : 'selected, but no source provides it; disable it or add its source',
      };
    });
}

interface ResolvedRuleSet {
  present: Component[];
  missing: string[];
  content: string;
}

/**
 * Per-app rules resolution: the phase's wanted set for the app composed with
 * its effective delimiter setting. Apps sharing one wanted set share one
 * composition.
 */
function rulesResolver(input: PlanInput): (appId: string) => ResolvedRuleSet {
  const { config, inventory } = input;
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'rules')
      .map((component) => [component.id, component])
  );
  const cache = new Map<string, ResolvedRuleSet>();
  return (appId) => {
    const ids = input.selection(appId, 'rules');
    const includeDelimiters = effectiveIncludeDelimiters(config, appId);
    const key = JSON.stringify([includeDelimiters, ids]);
    let resolved = cache.get(key);
    if (!resolved) {
      const present: Component[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const component = byId.get(id);
        if (component) present.push(component);
        else missing.push(id);
      }
      resolved = {
        present,
        missing,
        content: composeRules(present, { includeDelimiters }).content,
      };
      cache.set(key, resolved);
    }
    return resolved;
  };
}

/**
 * Every library rule rendered as the block a composition would carry it as.
 * A host file assembled from these is a render, whatever was selected when it
 * was written.
 */
function ruleBlockResolver(
  config: ResolvedConfig,
  inventory: LibraryInventory
): (appId: string) => string[] {
  const rules = inventory.components.filter((component) => component.type === 'rules');
  const cache = new Map<boolean, string[]>();
  return (appId) => {
    const includeDelimiters = effectiveIncludeDelimiters(config, appId);
    let blocks = cache.get(includeDelimiters);
    if (!blocks) {
      blocks = rules.map((rule) => composeRules([rule], { includeDelimiters }).content);
      cache.set(includeDelimiters, blocks);
    }
    return blocks;
  };
}

/** Stand-in body used to read a render's wrapper; no rule content holds it. */
const RENDER_PROBE = 'ASB_RULES_BODY';

/**
 * Whether a dedicated target holds a render of library rules — the current
 * one or a stale one — which is the proof a markerless shared host already
 * gets. The render wraps the composed body, so rendering a probe body names
 * the wrapper, and what is left inside it has to reassemble from library rule
 * blocks. Anything else is content the repository wrote.
 */
function rendersRuleBlocks(
  row: RulesTargetRow,
  targetPath: string,
  content: string | null,
  blocks: readonly string[]
): boolean {
  if (content === null) return false;
  const [prefix, suffix, ...extra] = row.render(RENDER_PROBE, targetPath).split(RENDER_PROBE);
  if (suffix === undefined || extra.length > 0) return false;
  if (content.length < prefix.length + suffix.length) return false;
  if (!content.startsWith(prefix) || !content.endsWith(suffix)) return false;
  return composedFromRuleBlocks(
    content.slice(prefix.length, content.length - suffix.length),
    blocks
  );
}

/**
 * The rules region inside a repository's AGENTS.md. The file belongs to the
 * repository and asb owns only what its delimiters enclose, exactly as in a
 * shared host under a home directory: the markers locate the slice and prove
 * it, bytes outside them survive every sync, and deselection takes the region
 * away and nothing else.
 */
function planSharedProjectRules(
  input: PlanInput,
  resolveFor: (appId: string) => ResolvedRuleSet
): Action[] {
  if (!input.project) return [];
  const { config, capture, table, project } = input;
  const targetPath = path.join(project.root, 'AGENTS.md');
  const assumeInstalled = new Set(config.apps.assumeInstalled);
  const members = config.apps.enabled.filter((appId) => {
    const rules = table.find((row) => row.id === appId)?.rules;
    return (
      rules?.path(config.homes) === targetPath &&
      (capture.installed[appId] === true || assumeInstalled.has(appId))
    );
  });
  if (members.length === 0) return [];

  const missing = [...new Set(members.flatMap((appId) => resolveFor(appId).missing))];
  const base = {
    app: 'project',
    type: 'rules',
    id: null,
    path: targetPath,
    members,
    projectAction: true,
  };
  if (missing.length > 0) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'aggregate-blocked',
        reason: `missing rule(s): ${missing.join(', ')}; the previous project block is left in place`,
      },
    ];
  }
  const bodies = [...new Set(members.map((appId) => resolveFor(appId).content))];
  if (bodies.length > 1) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'conflict',
        detail: 'shared-writer',
        reason: `shared AGENTS.md contributors render different rule sets (${members.join(', ')}); align their project selections`,
      },
    ];
  }

  const current = capture.targets[targetPath] ?? { exists: false, content: null };
  if (current.escapes === true) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'blocked',
        detail: 'path-escape',
        reason: `parent directory of ${targetPath} resolves outside the project root; not touching it`,
      },
    ];
  }
  if (current.exists && current.content === null) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'blocked',
        detail: 'foreign',
        reason: 'AGENTS.md exists but cannot be read; not touching it',
      },
    ];
  }

  const existing = current.content ?? '';
  let desiredHost: string;
  try {
    desiredHost = mergeProjectRegion(
      existing,
      bodies[0] ?? '',
      config.distribution.project.rulesPlacement
    );
  } catch (error) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'conflict',
        detail: 'malformed-marker',
        reason: `${error instanceof Error ? error.message : String(error)}; AGENTS.md left unchanged`,
      },
    ];
  }
  const desiredSlice = projectRegion(desiredHost);

  if (desiredHost === existing) {
    return desiredSlice === null ? [] : [{ ...base, op: 'none', outcome: 'unchanged' }];
  }

  return [
    {
      ...base,
      op: desiredSlice === null && desiredHost.length === 0 ? 'remove' : 'write',
      outcome: desiredSlice === null ? 'removed' : 'written',
      detail: current.exists ? 'updated' : 'created',
      content: desiredHost,
      root: project.root,
      expectedHash: current.content === null ? null : hashContent(current.content),
    },
  ];
}

export function planRules(input: PlanInput): Action[] {
  const { config, inventory, capture, table } = input;
  const actions: Action[] = [];
  const staleActions: Action[] = [];

  // Library-level facts belong to the one library both phases read, so the
  // user phase is their single voice: failures always surface, selected or not
  // (containment: the failed entry errors, everything else proceeds), and an
  // id two sources both claim resolves to the first reading with the losing
  // source named, so the collision is visible rather than inferred from
  // content nobody asked for.
  if (!input.project) {
    for (const failure of inventory.failed) {
      actions.push({
        app: null,
        type: failure.type,
        id: failure.id,
        path: failure.path,
        op: 'none',
        outcome: 'failed',
        detail: 'parse-error',
        reason: failure.error,
      });
    }

    for (const duplicate of inventory.duplicates) {
      actions.push({
        app: null,
        type: duplicate.type,
        id: duplicate.id,
        path: duplicate.path,
        op: 'none',
        outcome: 'skipped',
        detail: 'duplicate-id',
        reason: `"${duplicate.id}" is already provided by ${duplicate.keptSource}; ${duplicate.source} is not used`,
      });
    }
  }

  const resolveFor = rulesResolver(input);
  const ruleBlocksFor = ruleBlockResolver(config, inventory);

  // One library-level row per id any enabled app selects but the library
  // lacks; per-app blocking happens inside the app loop.
  const missingUnion: string[] = [];
  const seenMissing = new Set<string>();
  for (const appId of config.apps.enabled) {
    for (const id of resolveFor(appId).missing) {
      if (seenMissing.has(id)) continue;
      seenMissing.add(id);
      missingUnion.push(id);
    }
  }
  for (const id of missingUnion) {
    actions.push({
      app: null,
      type: 'rules',
      id,
      path: null,
      op: 'none',
      outcome: 'missing',
      reason: `enabled but not in the library (expected ${config.homes.asbHome}/rules/${id}.md)`,
    });
  }

  const assumeInstalled = new Set(config.apps.assumeInstalled);

  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId);
    if (!row) continue;

    const detected = capture.installed[appId] === true || assumeInstalled.has(appId);
    if (!detected) {
      actions.push({
        app: appId,
        type: null,
        id: null,
        path: null,
        op: 'none',
        outcome: 'skipped',
        detail: 'app-not-installed',
        reason: `${row.detectDir(config.homes)} not found; add "${appId}" to [applications].assume_installed to sync anyway`,
      });
      continue;
    }

    if (!row.rules) continue;

    const targetPath = capture.rulePaths[appId] ?? row.rules.path(config.homes);
    if (input.project && targetPath === path.join(input.project.root, 'AGENTS.md')) continue;
    const root = row.rules.root(config.homes, targetPath);
    const current = capture.targets[targetPath] ?? { exists: false, content: null };

    const { present, missing, content } = resolveFor(appId);

    // The filename an earlier version gave this same slice. It holds no
    // library id, so location plus the retired prefix is the whole claim, and
    // it is swept whether or not rules are still selected. Only a path this
    // table names had that predecessor spelling; at a path configuration
    // chose, an `asb-` sibling is a file someone else wrote. The name sweep
    // also stays out of a project tree, which the repository shares.
    const legacyPath = row.rules.ownsName ? legacyDedicatedRulesPath(targetPath) : null;
    const legacy = legacyPath ? capture.targets[legacyPath] : undefined;
    if (legacyPath && legacy?.exists && legacy.content !== null && !input.project) {
      staleActions.push({
        app: appId,
        type: 'rules',
        id: null,
        path: legacyPath,
        op: 'remove',
        outcome: 'removed',
        detail: 'stale-copy',
        root: row.rules.root(config.homes, legacyPath),
        expectedHash: hashContent(legacy.content),
        ...(present.length + missing.length > 0 ? { requiresPaths: [targetPath] } : {}),
      });
    }

    // A missing member blocks that app's aggregate slice: rendering without
    // it would silently drop content the user selected for this app.
    if (missing.length > 0) {
      actions.push({
        app: appId,
        type: 'rules',
        id: null,
        path: targetPath,
        op: 'none',
        outcome: 'failed',
        detail: 'aggregate-blocked',
        reason: `missing rule(s): ${missing.join(', ')}; the previous content is left in place`,
      });
      continue;
    }

    const desired = content.length > 0 ? row.rules.render(content, targetPath) : '';
    const currentHash = current.content !== null ? hashContent(current.content) : null;
    const base = { app: appId, type: 'rules' as const, id: null, path: targetPath };

    if (legacyPath && legacy?.exists && input.project) {
      if (desired.length > 0 && legacy.content === desired) {
        staleActions.push({
          app: appId,
          type: 'rules',
          id: null,
          path: legacyPath,
          op: 'remove',
          outcome: 'removed',
          detail: 'stale-copy',
          root: row.rules.root(config.homes, legacyPath),
          expectedHash: hashContent(legacy.content),
          requiresPaths: [targetPath],
        });
      } else {
        staleActions.push({
          app: appId,
          type: 'rules',
          id: null,
          path: legacyPath,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason:
            legacy.content === null
              ? 'retired project rules path is unreadable; preserved'
              : 'retired project rules path is not the current render; preserved',
        });
      }
    }

    // A shared host belongs to the user; asb owns only the marked region
    // inside it. The markers both locate the slice and prove it, so bytes
    // outside them survive every sync and deselection takes the region away
    // without touching anything else.
    if (!row.rules.dedicated) {
      if (current.exists && current.content === null) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'blocked',
          detail: 'foreign',
          reason: 'occupied but unreadable; asb cannot prove what it would be overwriting',
        });
        continue;
      }
      const composed = current.content ?? '';
      let desiredHost: string;
      // Every read of the existing markers happens here: a malformed pair is
      // one app's conflict row, not an exception that takes the whole run
      // down with it.
      try {
        // A version that wrote the whole file left no markers. Recognizing
        // that composition is what lets the region replace it instead of
        // being prepended above it, which would leave the rules in the file
        // twice.
        const host =
          projectRegion(composed) === null && composedFromRuleBlocks(composed, ruleBlocksFor(appId))
            ? ''
            : composed;
        desiredHost = mergeProjectRegion(host, desired);
      } catch (error) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'conflict',
          detail: 'malformed-marker',
          reason: `${error instanceof Error ? error.message : String(error)}; left unchanged`,
        });
        continue;
      }
      const desiredSlice = projectRegion(desiredHost);
      if (desiredHost === composed) {
        if (desiredSlice !== null) actions.push({ ...base, op: 'none', outcome: 'unchanged' });
        continue;
      }
      actions.push({
        ...base,
        op: desiredSlice === null && desiredHost.length === 0 ? 'remove' : 'write',
        outcome: desiredSlice === null ? 'removed' : 'written',
        detail: current.exists ? 'updated' : 'created',
        content: desiredHost,
        root,
        expectedHash: currentHash,
      });
      continue;
    }

    // Removal is authorized only by true deselection. A selected set that
    // happens to compose to empty bytes (delimiters off, empty rule bodies)
    // falls through and writes the empty composition instead.
    if (present.length === 0) {
      // Nothing selected renders to no bytes, so comparison proves nothing
      // here and the filename is the only claim left. A path this table names
      // carries the name asb chose for the slice, so location is the proof.
      // The name sweep stays out of a project tree the repository shares.
      if (!current.exists) continue;
      // In a project tree the name proves nothing, so what a file holds is the
      // whole claim: bytes composed of library rule blocks are a render this
      // repository no longer has any increment for, and they go.
      if (input.project) {
        if (
          currentHash !== null &&
          rendersRuleBlocks(row.rules, targetPath, current.content, ruleBlocksFor(appId))
        ) {
          actions.push({
            ...base,
            op: 'remove',
            outcome: 'removed',
            detail: 'stale-copy',
            root,
            expectedHash: currentHash,
          });
        }
        continue;
      }
      if (currentHash === null) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason: 'occupied but unreadable; asb cannot prove it is safe to remove',
        });
        continue;
      }
      // A path configuration chose is the user's, so nothing here proves the
      // bytes are asb's: the file is named and kept, never deleted for
      // sitting where a custom target points.
      if (!row.rules.ownsName) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason: `nothing is selected for ${appId} and this target's path comes from configuration, so asb cannot prove it wrote the file; delete it yourself or enable rules`,
        });
        continue;
      }
      actions.push({
        ...base,
        op: 'remove',
        outcome: 'removed',
        detail: 'stale-copy',
        root,
        expectedHash: currentHash,
      });
      continue;
    }

    if (!current.exists) {
      actions.push({
        ...base,
        op: 'write',
        outcome: 'written',
        detail: 'created',
        content: desired,
        root,
        expectedHash: null,
      });
      continue;
    }

    if (current.content === desired) {
      actions.push({ ...base, op: 'none', outcome: 'unchanged' });
      continue;
    }

    if (currentHash === null) {
      actions.push({
        ...base,
        op: 'none',
        outcome: 'blocked',
        detail: 'foreign',
        reason: 'occupied but unreadable; asb cannot prove what it would be overwriting',
      });
      continue;
    }

    // Occupied with bytes that are not the current render. Globally the
    // filename is asb's own, so the render is written in one pass. A project
    // tree is shared with the repository: a stale render is still asb's and
    // follows the increment, while anything else is the repository's and is
    // preserved — a kept edit is the run working as intended, so the row
    // carries the signal without failing the run. `collision = "error"` is the
    // setting that asks for a failure instead; takeover overwrites.
    const stale = rendersRuleBlocks(row.rules, targetPath, current.content, ruleBlocksFor(appId));
    if (input.project && input.project.collision !== 'takeover' && !stale) {
      const errors = input.project.collision === 'error';
      actions.push({
        ...base,
        op: 'none',
        outcome: errors ? 'conflict' : 'left-behind',
        detail: errors ? 'foreign' : 'unproven',
        reason: 'project target holds content that is not a render of library rules; preserved',
      });
      continue;
    }
    actions.push({
      ...base,
      op: 'write',
      outcome: 'written',
      detail: input.project && !stale ? 'takeover' : 'updated',
      content: desired,
      root,
      expectedHash: currentHash,
    });
  }

  // Escaping targets are decided here, from the capture, so dry-run and the
  // real run report the identical blocked entry; the executor re-checks live.
  return [...actions, ...staleActions, ...planSharedProjectRules(input, resolveFor)].map(
    (action) => {
      if (
        (action.op === 'write' || action.op === 'remove') &&
        action.path !== null &&
        capture.targets[action.path]?.escapes === true
      ) {
        return {
          app: action.app,
          type: action.type,
          id: action.id,
          path: action.path,
          op: 'none' as const,
          outcome: 'blocked' as const,
          detail: 'path-escape',
          reason: `parent directory of ${action.path} resolves outside the app root; not touching it`,
        };
      }
      return action;
    }
  );
}

interface SkillRowPlan {
  app: string;
  members: string[];
  dir: string;
  root: string;
  reserved: readonly string[];
  selected: string[];
}

/**
 * Own-dir planner for skills. Emits per-bundle slices only; app-detection
 * skip rows and library-level parse failures are planRules' single voice
 * (both planners always run together through runSync).
 *
 * Ownership of an own-dir slice is derived from the library, not recorded.
 * A selected skill is brought to its render in one pass, leaving files the
 * render does not name untouched. Deletion needs the stronger claim that the
 * whole tree is byte-for-byte that render, so an edited or stale bundle is
 * reported and preserved rather than removed.
 */
export function planSkills(input: PlanInput): Action[] {
  const { config, inventory, capture, table } = input;
  const actions: Action[] = [];

  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'skills')
      .map((component) => [component.id, component])
  );
  const failedIds = new Set(
    inventory.failed.filter((failure) => failure.type === 'skills').map((failure) => failure.id)
  );
  const assumeInstalled = new Set(config.apps.assumeInstalled);
  const detected = (appId: string): boolean =>
    capture.installed[appId] === true || assumeInstalled.has(appId);

  // One library-level row per id any enabled app selects but the library
  // lacks; skills aggregate nothing, so a missing id blocks no other slice.
  const missingUnion = new Set<string>();

  const rows: SkillRowPlan[] = [];
  const useAgentsDir = config.distribution.useAgentsDir;
  const unionMembers = new Set(AGENTS_SKILLS_UNION.members);
  const activeMembers = AGENTS_SKILLS_UNION.members.filter(
    (member) => config.apps.enabled.includes(member) && detected(member)
  );

  const memberEffective = new Map<string, Set<string>>();
  const memberDirs = new Map<string, string>();

  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId);
    if (!row?.skills || !detected(appId)) continue;
    const effective = input.selection(appId, 'skills');
    for (const id of effective) {
      if (!byId.has(id) && !failedIds.has(id)) missingUnion.add(id);
    }
    if (unionMembers.has(appId)) {
      memberEffective.set(appId, new Set(effective));
      memberDirs.set(appId, row.skills.dir(config.homes));
    }
    rows.push({
      app: appId,
      members: [appId],
      dir: row.skills.dir(config.homes),
      root: row.skills.root(config.homes),
      reserved: row.skills.reserved,
      // In agents mode the union members' own rows deselect everything:
      // their copies are stale by design and leave through the proof-gated
      // removal path.
      selected: useAgentsDir && unionMembers.has(appId) ? [] : effective,
    });
  }

  // A union member without a skills cell (traecli) drives union writes only
  // in agents-dir mode, so only then do its missing selections reach the
  // library-level report; with the mode off it has no skills destination at
  // all, and reporting would false-fail an otherwise complete run.
  if (useAgentsDir) {
    for (const member of activeMembers) {
      if (table.find((candidate) => candidate.id === member)?.skills) continue;
      for (const id of input.selection(member, 'skills')) {
        if (!byId.has(id) && !failedIds.has(id)) missingUnion.add(id);
      }
    }
  }

  // A copy that only moved (agents-dir toggle) is removed strictly after its
  // replacement is proven on disk: every desired file present, byte- and
  // mode-clean, at the destination this same capture saw. Until then the
  // remove defers, so a failed destination write or an `--app` filter can
  // never leave the user with no copy at all.
  const bundleCleanAt = (bundlePath: string, component: Component | undefined): boolean => {
    if (!component?.files || component.files.length === 0) return false;
    const capturedThere = capture.bundles[bundlePath];
    if (!capturedThere?.exists || capturedThere.files === null) return false;
    const liveByRel = new Map(capturedThere.files.map((file) => [file.rel, file]));
    return component.files.every((file) => {
      const live = liveByRel.get(file.rel);
      return (
        live !== undefined &&
        live.hash === hashContent(file.bytes) &&
        targetModeMatchesSourceExecutableBits(file.mode, live.mode)
      );
    });
  };

  const unionSelected =
    useAgentsDir && activeMembers.length > 0
      ? [...new Set(activeMembers.flatMap((member) => input.selection(member, 'skills')))]
      : [];
  const unionDir = AGENTS_SKILLS_UNION.dir(config.homes, config.project ?? undefined);
  // Dormant unless a member is enabled AND detected: an enabled but
  // uninstalled member must not wake cleanup of union-written state.
  const unionRowActive =
    activeMembers.length > 0 &&
    ((capture.bundleDirs[unionDir]?.length ?? 0) > 0 || unionSelected.length > 0);
  if (unionRowActive) {
    rows.push({
      app: 'agents',
      members: activeMembers,
      dir: unionDir,
      root: AGENTS_SKILLS_UNION.root(config.homes, config.project ?? undefined),
      reserved: AGENTS_SKILLS_UNION.reserved,
      selected: unionSelected,
    });
  }

  for (const id of missingUnion) {
    actions.push({
      app: null,
      type: 'skills',
      id,
      path: null,
      op: 'none',
      outcome: 'missing',
      reason: `enabled but not in the library (expected ${config.homes.asbHome}/skills/${id}/)`,
    });
  }

  const physicalRows: SkillRowPlan[] = [];
  for (const row of rows) {
    const shared = input.project
      ? physicalRows.find((candidate) => candidate.dir === row.dir)
      : undefined;
    if (!shared) {
      physicalRows.push({ ...row, members: [...row.members], selected: [...row.selected] });
      continue;
    }
    shared.members = [...new Set([...shared.members, ...row.members])];
    shared.selected = [...new Set([...shared.selected, ...row.selected])];
    shared.reserved = [...new Set([...shared.reserved, ...row.reserved])];
  }

  for (const row of physicalRows) {
    const present = capture.bundleDirs[row.dir] ?? [];
    const candidates = [
      ...new Set([
        ...row.selected,
        ...present.filter((name) => input.project?.mode === 'exclusive' || byId.has(name)),
      ]),
    ].filter((id) => !row.reserved.includes(id) && !id.startsWith('.'));

    for (const id of candidates) {
      const bundlePath = path.join(row.dir, id);
      const captured: CapturedBundle = capture.bundles[bundlePath] ?? {
        exists: false,
        files: null,
        fingerprint: null,
      };
      const isSelected = row.selected.includes(id);
      const component = byId.get(id);

      // A selected id whose SKILL.md fails to parse already has its failed
      // row; the target (owned or not) is left exactly as it is.
      if (isSelected && failedIds.has(id)) continue;
      // Missing library entry: reported at library level above.
      if (isSelected && !component) continue;

      const desired = component?.files ?? [];
      const desiredByRel = new Map(desired.map((file) => [file.rel, file]));
      const capturedByRel =
        captured.files !== null ? new Map(captured.files.map((file) => [file.rel, file])) : null;

      const sliceClean = (): boolean => {
        if (capturedByRel === null) return false;
        for (const file of desired) {
          const live = capturedByRel.get(file.rel);
          if (!live) return false;
          if (live.hash !== hashContent(file.bytes)) return false;
          if (!targetModeMatchesSourceExecutableBits(file.mode, live.mode)) return false;
        }
        return true;
      };
      const identicalToDesired = (): boolean => {
        if (capturedByRel === null || captured.files === null) return false;
        if (captured.files.length !== desired.length) return false;
        return sliceClean();
      };

      /**
       * Ownership is decided from the library, not from a record:
       * `identicalToDesired` asks whether this tree is the current render,
       * which both means there is nothing to write and is the only claim that
       * authorizes deleting it. Anything else is the user's: overwritten
       * while the skill is selected, left alone once it is not.
       */
      const base = {
        app: row.app,
        type: 'skills',
        id,
        path: bundlePath,
        ...(row.members.length > 1 ? { members: row.members } : {}),
      };

      if (!captured.exists) {
        if (isSelected) {
          actions.push({
            ...base,
            op: 'write',
            outcome: 'written',
            detail: 'created',
            bundle: { files: desired, stale: [] },
            root: row.root,
            expectedHash: null,
            // Hash is measured post-write by the executor.
          });
        }
        continue;
      }

      if (input.project?.mode === 'exclusive' && !isSelected) {
        if (captured.files === null || captured.fingerprint === null) {
          actions.push({
            ...base,
            op: 'none',
            outcome: 'failed',
            detail: 'scan-error',
            reason: 'exclusive project bundle cannot be proven safe to remove',
          });
        } else {
          actions.push({
            ...base,
            op: 'remove',
            outcome: 'removed',
            detail: 'exclusive-cleanup',
            bundle: {
              files: [],
              stale: captured.files.map((file) => file.rel),
              exclusive: true,
            },
            root: row.root,
            expectedHash: captured.fingerprint,
          });
        }
        continue;
      }

      if (isSelected) {
        if (captured.files === null || captured.fingerprint === null) {
          actions.push({
            ...base,
            op: 'none',
            outcome: 'left-behind',
            detail: 'unproven',
            reason:
              'directory matches this skill by name but contains symlinks or special files asb cannot prove ownership of; move it away or delete it yourself',
          });
        } else if (identicalToDesired()) {
          actions.push({ ...base, op: 'none', outcome: 'unchanged' });
        } else if (input.project && input.project.collision !== 'takeover') {
          actions.push({
            ...base,
            op: 'none',
            outcome: 'conflict',
            detail: 'foreign',
            reason: 'project bundle is occupied and the peer manifest does not own it; preserved',
          });
        } else {
          // A distributed bundle mirrors its library directory: the render is
          // written and anything the render does not name is cleared. That is
          // what makes a synced bundle byte-identical to its render, which is
          // in turn what lets deselection remove it later without a stored
          // record. Editing a distributed copy is not supported; edit the
          // library entry instead.
          actions.push({
            ...base,
            op: 'write',
            outcome: 'written',
            detail: input.project ? 'takeover' : 'updated',
            bundle: {
              files: desired,
              stale: captured.files.map((file) => file.rel).filter((rel) => !desiredByRel.has(rel)),
            },
            root: row.root,
            expectedHash: captured.fingerprint,
          });
        }
        continue;
      }

      // Deselected. A tree that is byte-for-byte the render is provably asb's
      // and comes out on that proof alone. A tree that is not carries either
      // edits or an older render, and is swept on the weaker claim that an id
      // matching a library skill, sitting under a skills parent the app table
      // declares, is asb's layout rather than something the user put there.
      //
      // ponytail: a name is weaker evidence than bytes, so a directory you
      // wrote by hand under a library skill's id is destroyed here. Removing
      // only on byte proof is the safer rule, and it is what stranded every
      // copy distributed before ownership was derived. To go back to it,
      // report this branch as `left-behind (unproven)` instead of removing.
      if (captured.files === null || captured.fingerprint === null) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason:
            'directory matches a library skill by name but contains symlinks or special files asb cannot prove safe to remove; delete it yourself',
        });
        continue;
      }

      const proven = identicalToDesired();
      // A project tree is shared with the repository, so the name sweep stays
      // out of it: at project scope only a proven copy is removed.
      if (!proven && input.project) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason:
            'project bundle is not the current render and the peer manifest does not own it; preserved',
        });
        continue;
      }

      // Held back while an agents-dir toggle still needs this copy at its
      // counterpart location.
      const waitingOn: string[] = [];
      if (useAgentsDir && unionMembers.has(row.app) && memberEffective.get(row.app)?.has(id)) {
        const unionPath = path.join(unionDir, id);
        if (!bundleCleanAt(unionPath, component)) waitingOn.push(unionPath);
      }
      if (row.app === 'agents') {
        for (const [member, dir] of memberDirs) {
          if (!memberEffective.get(member)?.has(id)) continue;
          const memberPath = path.join(dir, id);
          if (!bundleCleanAt(memberPath, component)) waitingOn.push(memberPath);
        }
      }
      if (waitingOn.length > 0) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'skipped',
          detail: 'not-selected',
          reason: `kept until ${waitingOn.join(', ')} carries this skill; run asb sync again`,
        });
        continue;
      }

      actions.push({
        ...base,
        op: 'remove',
        outcome: 'removed',
        ...(proven ? {} : { detail: 'stale-copy' }),
        bundle: {
          files: [],
          stale: proven ? desired.map((file) => file.rel) : captured.files.map((file) => file.rel),
        },
        root: row.root,
        expectedHash: captured.fingerprint,
      });
    }
  }

  return actions.map((action) => {
    if (
      (action.op === 'write' || action.op === 'remove') &&
      action.path !== null &&
      capture.bundles[action.path]?.escapes === true
    ) {
      return {
        app: action.app,
        type: action.type,
        id: action.id,
        path: action.path,
        op: 'none' as const,
        outcome: 'blocked' as const,
        detail: 'path-escape',
        reason: `parent directory of ${action.path} resolves outside the app root; not touching it`,
      };
    }
    return action;
  });
}

// ---------------------------------------------------------------------------
// Commands and agents: one owned file per selected component
// ---------------------------------------------------------------------------

type EntryType = 'commands' | 'agents';

interface ConfigCandidate {
  component: Component;
  filename: string;
  rolePath: string;
}

function tableCanSplice(captured: CapturedMcpHost, keyPath: readonly string[]): string | null {
  const name = tomlHeaderName(keyPath);
  const nested = captured.tables.find(
    (parts) =>
      parts.length > keyPath.length && keyPath.every((part, index) => parts[index] === part)
  );
  if (nested) return `[${tomlHeaderName(nested)}] nests under ${name} in ${captured.path}`;
  const exact = captured.tables.some(
    (parts) =>
      parts.length === keyPath.length && keyPath.every((part, index) => parts[index] === part)
  );
  return exact ? null : `${name} is not written as a table in ${captured.path}`;
}

function planEntryConfig(
  input: PlanInput,
  app: string,
  target: EntryTargetRow,
  candidates: readonly ConfigCandidate[],
  deselected: readonly ConfigCandidate[]
): Action[] {
  const spec = target.config;
  if (!spec) return [];
  const { config, capture } = input;
  const captured = capture.mcp[app];
  const base = { app, type: 'agents', id: null, path: spec.path(config.homes) };
  if (!captured || captured.path !== base.path) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'capture-error',
        reason: 'structured config host was not captured',
      },
    ];
  }
  if (captured.escapes === true) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'blocked',
        detail: 'path-escape',
        reason: `parent directory of ${captured.path} resolves outside the app root; not touching it`,
      },
    ];
  }
  if (captured.root === null) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'parse-error',
        reason: `cannot read ${path.basename(captured.path)}, agent roles not merged: ${captured.error ?? 'document root must be an object'}`,
      },
    ];
  }

  const actions: Action[] = [];
  const edits: KeysEdit[] = [];
  const requiredPaths = new Set<string>();
  const addSlice = (
    id: string | null,
    keyPath: string[],
    value: unknown,
    text: string | undefined,
    rolePath?: string
  ): void => {
    if (rolePath) requiredPaths.add(rolePath);
    const current = valueAtKeyPath(captured.root, keyPath);
    const sliceBase = { app, type: 'agents', id, path: captured.path };
    if (current === undefined) {
      edits.push({ keyPath, value, ...(text ? { text } : { scalar: true as const }) });
      return;
    }
    if (sliceHash(current) === sliceHash(value)) {
      actions.push({ ...sliceBase, op: 'none', outcome: 'unchanged' });
      return;
    }
    const unspliceable = text ? tableCanSplice(captured, keyPath) : null;
    if (unspliceable) {
      actions.push({
        ...sliceBase,
        op: 'none',
        outcome: 'blocked',
        detail: 'foreign',
        reason: `${unspliceable}; move it or remove it by hand`,
      });
      return;
    }
    edits.push({ keyPath, value, ...(text ? { text } : { scalar: true as const }) });
  };

  for (const candidate of candidates) {
    const slice = spec.component(candidate.component, candidate.filename);
    addSlice(candidate.component.id, slice.keyPath, slice.value, slice.text, candidate.rolePath);
  }
  if (candidates.length > 0 && spec.activation) {
    addSlice(null, spec.activation.keyPath, spec.activation.value, undefined);
  }

  // Role keys nothing selects any more, on the same rule as an MCP server:
  // the key comes out while it holds the render, and a key holding anything
  // else is the user's. The activation flag is never removed — `multi_agent =
  // true` is what a Codex user running their own roles also writes, so there
  // is nothing in it to tell the two apart.
  for (const candidate of deselected) {
    let slice: { keyPath: string[]; value: unknown; text?: string };
    try {
      slice = spec.component(candidate.component, candidate.filename);
    } catch {
      continue;
    }
    const current = valueAtKeyPath(captured.root, slice.keyPath);
    if (current === undefined) continue;
    const id = candidate.component.id;
    const proven = sliceHash(current) === sliceHash(slice.value);
    const unspliceable = slice.text ? tableCanSplice(captured, slice.keyPath) : null;
    if (proven && !unspliceable) {
      edits.push({ keyPath: slice.keyPath, remove: true });
      continue;
    }
    if (!proven && !editedRender(current, slice.value, ['config_file'])) continue;
    actions.push({
      app,
      type: 'agents',
      id,
      path: captured.path,
      op: 'none',
      outcome: 'left-behind',
      detail: 'modified',
      reason: unspliceable
        ? `${unspliceable}; delete it yourself`
        : `${tomlHeaderName(slice.keyPath)} in ${captured.path} is no longer the library's definition; delete it yourself or re-enable the role`,
    });
  }

  if (edits.length === 0) return actions;
  let content: string;
  try {
    content = applyKeysEdits(captured.content ?? '', spec.format, edits);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    actions.push({ ...base, op: 'none', outcome: 'failed', detail: 'parse-error', reason });
    return actions;
  }
  actions.push({
    ...base,
    op: 'write',
    outcome: 'written',
    detail: captured.exists ? 'merged' : 'created',
    content,
    root: spec.root(config.homes),
    expectedHash: captured.content === null ? null : hashContent(captured.content),
    requiresPaths: [...requiredPaths],
    keyEdits: { format: spec.format, edits, baseContent: captured.content ?? '' },
  });
  return actions;
}

function planEntries(input: PlanInput, type: EntryType): Action[] {
  const { config, inventory, capture, table } = input;
  const actions: Action[] = [];
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === type)
      .map((component) => [component.id, component])
  );
  const failedIds = new Set(
    inventory.failed.filter((failure) => failure.type === type).map((failure) => failure.id)
  );
  const missing = new Set<string>();
  for (const app of config.apps.enabled) {
    for (const id of input.selection(app, type)) {
      if (!byId.has(id) && !failedIds.has(id)) missing.add(id);
    }
  }
  for (const id of missing) {
    actions.push({
      app: null,
      type,
      id,
      path: null,
      op: 'none',
      outcome: 'missing',
      reason: `enabled but not in the library (expected ${config.homes.asbHome}/${type}/${id}.md)`,
    });
  }

  const assumeInstalled = new Set(config.apps.assumeInstalled);
  for (const app of config.apps.enabled) {
    const target = table.find((row) => row.id === app)?.[type];
    if (!target || (capture.installed[app] !== true && !assumeInstalled.has(app))) continue;
    const selected = input.selection(app, type);
    const protectedIds = new Set(selected.filter((id) => !byId.has(id) || failedIds.has(id)));
    const filenames = new Map<string, string[]>();
    for (const id of selected) {
      if (!byId.has(id)) continue;
      const filename = target.filename(id);
      filenames.set(filename, [...(filenames.get(filename) ?? []), id]);
    }
    const collisions = new Set<string>();
    for (const [filename, ids] of filenames) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        collisions.add(id);
        protectedIds.add(id);
        actions.push({
          app,
          type,
          id,
          path: path.join(target.dir(config.homes), filename),
          op: 'none',
          outcome: 'conflict',
          detail: 'filename-collision',
          reason: `${ids.map((value) => `"${value}"`).join(' and ')} both map to ${filename}; rename one component`,
        });
      }
    }

    const configCandidates: ConfigCandidate[] = [];
    for (const id of selected) {
      const component = byId.get(id);
      if (!component) continue;
      const filename = target.filename(id);
      const targetPath = path.join(target.dir(config.homes), filename);
      let desired: string | null;
      try {
        desired = target.render(component);
      } catch (error) {
        protectedIds.add(id);
        actions.push({
          app,
          type,
          id,
          path: targetPath,
          op: 'none',
          outcome: 'failed',
          detail: 'render-error',
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (desired === null) {
        actions.push({
          app,
          type,
          id,
          path: targetPath,
          op: 'none',
          outcome: 'skipped',
          detail: 'no-codex-role',
          reason: 'selected agent has no non-empty extras.codex role',
        });
        continue;
      }
      if (collisions.has(id)) continue;
      const current = capture.targets[targetPath] ?? { exists: false, content: null };
      const base = { app, type, id, path: targetPath };
      let roleReady = false;
      if (current.escapes === true) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'blocked',
          detail: 'path-escape',
          reason: `parent directory of ${targetPath} resolves outside the app root; not touching it`,
        });
        protectedIds.add(id);
        continue;
      }
      if (!current.exists) {
        roleReady = true;
        actions.push({
          ...base,
          op: 'write',
          outcome: 'written',
          detail: 'created',
          content: desired,
          root: target.root(config.homes),
          expectedHash: null,
        });
      } else if (current.content === null) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'blocked',
          detail: 'foreign',
          reason: 'target exists but cannot be read; not touching it',
        });
        protectedIds.add(id);
        continue;
      } else if (current.content === desired) {
        roleReady = true;
        actions.push({ ...base, op: 'none', outcome: 'unchanged' });
      } else if (input.project && input.project.collision !== 'takeover') {
        // A project tree is shared with the repository, so an occupied target
        // that is not the render stays the repository's until takeover.
        actions.push({
          ...base,
          op: 'none',
          outcome: 'conflict',
          detail: 'foreign',
          reason: 'project target holds content that is not the current render; preserved',
        });
      } else {
        // The app table declares this directory and the library owns this
        // filename, so a selected component writes its render in one pass.
        // Editing a distributed copy is not supported; edit the library entry.
        roleReady = true;
        actions.push({
          ...base,
          op: 'write',
          outcome: 'written',
          detail: input.project ? 'takeover' : 'updated',
          content: desired,
          root: target.root(config.homes),
          expectedHash: hashContent(current.content),
        });
      }
      if (roleReady) configCandidates.push({ component, filename, rolePath: targetPath });
    }

    // Deselected. A file that is byte-for-byte the render is provably asb's
    // and comes out on that proof alone. A selected component is rewritten
    // whenever it drifts, so a distributed copy only fails that test once the
    // user has edited it, and their edit is reported rather than deleted.
    // Exclusive project mode is the one place that still clears the directory,
    // because the user asked for exactly that.
    const selectedSet = new Set(selected);
    const configDeselected: ConfigCandidate[] = [];
    for (const component of byId.values()) {
      if (selectedSet.has(component.id) || protectedIds.has(component.id)) continue;
      const targetPath = path.join(target.dir(config.homes), target.filename(component.id));
      configDeselected.push({
        component,
        filename: target.filename(component.id),
        rolePath: targetPath,
      });
      const current = capture.targets[targetPath];
      if (!current?.exists) continue;
      const base = { app, type, id: component.id, path: targetPath };
      if (current.content === null) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason:
            'target matches a library component by name but cannot be read; delete it yourself',
        });
        continue;
      }
      let rendered: string | null = null;
      try {
        rendered = target.render(component);
      } catch {
        rendered = null;
      }
      const proven = rendered !== null && current.content === rendered;
      const exclusive = input.project?.mode === 'exclusive';
      if (!proven && !exclusive) {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason: 'edited since asb last wrote it; delete it yourself or re-enable it',
        });
        continue;
      }
      actions.push({
        ...base,
        op: 'remove',
        outcome: 'removed',
        ...(proven ? {} : { detail: 'exclusive-cleanup' }),
        root: target.root(config.homes),
        expectedHash: hashContent(current.content),
      });
    }
    actions.push(...planEntryConfig(input, app, target, configCandidates, configDeselected));
  }
  return actions;
}

export function planCommands(input: PlanInput): Action[] {
  return planEntries(input, 'commands');
}

export function planAgents(input: PlanInput): Action[] {
  return planEntries(input, 'agents');
}

/** Retire recognized OpenCode singular-layout entries after replacements land. */
export function planLegacyOpencode(input: PlanInput): Action[] {
  const { capture, inventory, table } = input;
  const actions: Action[] = [];
  const opencode = table.find((row) => row.id === 'opencode');
  const components = new Map(
    inventory.components.map((component) => [`${component.type}\0${component.id}`, component])
  );
  for (const scan of capture.legacy) {
    if (scan.error) {
      actions.push({
        app: 'opencode',
        type: scan.type,
        id: null,
        path: scan.path,
        op: 'none',
        outcome: 'failed',
        detail: 'scan-error',
        reason: `cannot scan legacy ${scan.type === 'commands' ? 'command' : scan.type === 'agents' ? 'agent' : 'skill'} directory: ${scan.error}`,
      });
      continue;
    }
    const selected = new Set(input.selection('opencode', scan.type));
    for (const entry of scan.entries) {
      const replacement = selected.has(entry.id);
      const base = { app: 'opencode', type: entry.type, id: entry.id, path: entry.path };
      const component = components.get(`${entry.type}\0${entry.id}`);
      const leaveUnproven = (): void => {
        actions.push({
          ...base,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason:
            'filename matches a library component but the file is not what the library renders; delete it yourself or enable it to have it written',
        });
      };
      if (entry.bundle) {
        const captured = capture.bundles[entry.path];
        if (!captured?.exists || captured.files === null || captured.fingerprint === null) {
          leaveUnproven();
          continue;
        }
        const desired = component?.files;
        const liveByRel = new Map(captured.files.map((file) => [file.rel, file]));
        if (
          !desired ||
          desired.length !== captured.files.length ||
          !desired.every((file) => {
            const live = liveByRel.get(file.rel);
            return (
              live !== undefined &&
              live.hash === hashContent(file.bytes) &&
              targetModeMatchesSourceExecutableBits(file.mode, live.mode)
            );
          })
        ) {
          leaveUnproven();
          continue;
        }
        actions.push({
          ...base,
          op: 'remove',
          outcome: 'removed',
          detail: replacement ? 'legacy-duplicate' : 'legacy-orphan',
          root: entry.root,
          expectedHash: captured.fingerprint,
          bundle: { files: [], stale: captured.files.map((file) => file.rel) },
          ...(replacement ? { requiresPaths: [entry.currentPath] } : {}),
        });
      } else {
        const captured = capture.targets[entry.path];
        if (!captured?.exists || captured.content === null) {
          leaveUnproven();
          continue;
        }
        const target = entry.type === 'commands' ? opencode?.commands : opencode?.agents;
        let desired: string | null = null;
        try {
          if (component && target) desired = target.render(component);
        } catch {
          // A component that cannot render cannot prove ownership of user bytes.
        }
        if (desired === null || hashContent(captured.content) !== hashContent(desired)) {
          leaveUnproven();
          continue;
        }
        actions.push({
          ...base,
          op: 'remove',
          outcome: 'removed',
          detail: replacement ? 'legacy-duplicate' : 'legacy-orphan',
          root: entry.root,
          expectedHash: hashContent(captured.content),
          ...(replacement ? { requiresPaths: [entry.currentPath] } : {}),
        });
      }
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Hooks: a JSON slice inside a config the app and the user also write
// ---------------------------------------------------------------------------

const HOOK_DIR_PLACEHOLDERS = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
  '${HOOK_DIR}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
  '${CLAUDE_PLUGIN_ROOT}/hooks',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
  '${CLAUDE_PLUGIN_ROOT}\\hooks',
  '$env:CLAUDE_PLUGIN_ROOT\\hooks',
];

/**
 * Render one library entry into the groups an app config carries: the bundle
 * placeholders resolve to the distributed directory, commands become
 * `$HOME`-portable, and `_asb*` metadata is stripped: an app config holds no
 * ASB marker of any kind, so ownership is read from the render instead.
 */
export function renderHookGroups(
  hooks: HookEventMap,
  bundleDir: string | undefined
): Record<string, unknown[]> {
  const rendered: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    rendered[event] = groups.map((group) => {
      const clean: Record<string, unknown> = { ...group };
      for (const key of Object.keys(clean)) {
        if (key.startsWith('_asb')) delete clean[key];
      }
      clean.hooks = group.hooks.map((handler) => {
        const rewritten: Record<string, unknown> = { ...handler };
        const commands = {
          command: handler.command,
          commandWindows: handler.commandWindows ?? handler.command_windows,
        };
        delete rewritten.command_windows;
        for (const key of Object.keys(rewritten)) {
          if (key.startsWith('_asb')) delete rewritten[key];
        }
        for (const field of ['command', 'commandWindows'] as const) {
          const original = commands[field];
          if (typeof original !== 'string') continue;
          const resolved = bundleDir
            ? HOOK_DIR_PLACEHOLDERS.reduce(
                (command, placeholder) => command.replaceAll(placeholder, bundleDir),
                original
              )
            : original;
          rewritten[field] = preferHomeVar(stripLegacyMarkerLines(resolved));
        }
        return rewritten;
      });
      return clean;
    });
  }
  return rendered;
}

/** A group's matcher, for naming one in a report line. */
function matcherOf(group: unknown): unknown {
  return isPlainObject(group) ? group.matcher : undefined;
}

/**
 * Groups an event map holds for one event. Event names come from the app's
 * vocabulary, so `__proto__` is a name a user can write and `JSON.parse` hands
 * it back as an own key: a plain lookup would return the prototype instead.
 */
function groupsFor(byEvent: Record<string, unknown[]>, event: string): unknown[] {
  const groups = byEvent[event];
  return Array.isArray(groups) ? groups : [];
}

/** The shape asb can merge into, or the reason it cannot. */
function invalidHooksShape(config: Record<string, unknown>): string | null {
  const hooks = config.hooks;
  if (hooks === undefined) return null;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return '"hooks" must be an object';
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return `"hooks.${event}" must be an array`;
  }
  return null;
}

/**
 * Hooks planner. The slice is a set of matcher groups inside a config file the
 * app and the user also own, so a group is asb's only while it is what the
 * library renders, or while its commands run a file under the app's managed
 * hook directory named after a hook the library defines. Predecessor markers
 * and v0.4.28 managed paths say asb without saying which hook, which is enough
 * to take a group out and never enough to hand one back.
 *
 * Codex receives the selected ASB groups as a canonical prefix, followed by
 * foreign groups in their existing relative order. Machines that share trust
 * state therefore assign the same positional keys to their common hooks while
 * keeping machine-local hooks at the tail. Other targets rewrite recognized
 * groups in place. Shape validation runs before any write, so an unusable
 * config never gets a partial distribution.
 */
export function planHooks(input: PlanInput): Action[] {
  const { config, inventory, capture, table } = input;
  const actions: Action[] = [];

  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'hooks')
      .map((component) => [component.id, component])
  );
  const failedIds = new Set(
    inventory.failed.filter((failure) => failure.type === 'hooks').map((failure) => failure.id)
  );
  const assumeInstalled = new Set(config.apps.assumeInstalled);

  const rows: { app: string; row: HooksTargetRow; selected: string[] }[] = [];
  const missingUnion = new Set<string>();
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId)?.hooks;
    if (!row) continue;
    if (capture.installed[appId] !== true && !assumeInstalled.has(appId)) continue;
    const selected = input.selection(appId, 'hooks');
    for (const id of selected) {
      if (!byId.has(id) && !failedIds.has(id)) missingUnion.add(id);
    }
    rows.push({ app: appId, row, selected });
  }

  for (const id of missingUnion) {
    actions.push({
      app: null,
      type: 'hooks',
      id,
      path: null,
      op: 'none',
      outcome: 'missing',
      reason: `enabled but not in the library (expected ${config.homes.asbHome}/hooks/${id}.json or ${config.homes.asbHome}/hooks/${id}/hook.json)`,
    });
  }

  for (const { app, row, selected } of rows) {
    const configPath = row.path(config.homes);
    const root = row.root(config.homes);
    const captured = capture.hooks[app];
    if (!captured) continue;
    const base = { app, type: 'hooks', id: null, path: configPath };

    if (captured.escapes === true) {
      actions.push({
        ...base,
        op: 'none',
        outcome: 'blocked',
        detail: 'path-escape',
        reason: `parent directory of ${configPath} resolves outside the app root; not touching it`,
      });
      continue;
    }
    if (captured.error !== undefined || captured.config === null) {
      actions.push({
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'parse-error',
        reason: `cannot read ${path.basename(configPath)}, hooks not merged: ${captured.error ?? 'config root must be a JSON object'}`,
      });
      continue;
    }
    const invalid = invalidHooksShape(captured.config);
    if (invalid !== null) {
      actions.push({
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'invalid-shape',
        reason: `${path.basename(configPath)} has invalid shape: ${invalid}; resolve it by hand, then re-run asb sync`,
      });
      continue;
    }

    const existingHooks = (captured.config.hooks ?? {}) as Record<string, unknown[]>;
    const managedParent = row.bundleDir(config.homes);
    const legacyParent = path.join(path.dirname(managedParent), 'asb');
    const ownership = {
      legacyAsbRoots: [legacyParent, preferHomeVar(legacyParent)],
      managedRoots: [managedParent, preferHomeVar(managedParent)],
      knownManagedIds: new Set(
        inventory.components
          .filter((component) => component.type === 'hooks')
          .map((component) => component.id)
      ),
    };
    const hadLegacyManagedKey = Object.hasOwn(captured.config, '_asb_managed_hooks');

    // Every hook the library still defines, rendered for this app whether it
    // is selected or not: a group equal to one of these is asb's even when
    // its command names no managed path, which is how a hook with no bundle
    // is recognized at all.
    const renders = new Map<string, Record<string, unknown[]>>();
    for (const component of byId.values()) {
      if (!component.hooks) continue;
      const source = row.filter ? row.filter(component.hooks) : component.hooks;
      if (Object.keys(source).length === 0) continue;
      const bundlePath = component.files
        ? path.join(row.bundleDir(config.homes), component.id)
        : undefined;
      renders.set(component.id, renderHookGroups(source, bundlePath));
    }
    const renderOwnerOf = (group: unknown, event: string): string | null => {
      for (const [id, byEvent] of renders) {
        if (groupsFor(byEvent, event).some((candidate) => isDeepStrictEqual(candidate, group))) {
          return id;
        }
      }
      return null;
    };
    // A group asb cannot prove is kin to a library hook when it shares that
    // hook's event and a concrete (non-empty string) matcher. Missing and empty
    // matchers are the default shape for many hooks, so matching on them alone
    // flags foreign installers that share only an event. Kinship still reads
    // every library hook, not only the selected ones, so deselecting a hook
    // does not silence the report on a predecessor that kept its matcher.
    // Ceiling: an unbundled no-matcher inline hook that drifts leaves a silent
    // residual (still not deleted); managed-path hooks are unaffected.
    const kinIdOf = (group: unknown, event: string): string | null => {
      const matcher = matcherOf(group);
      if (typeof matcher !== 'string' || matcher.length === 0) return null;
      for (const [id, byEvent] of renders) {
        if (
          groupsFor(byEvent, event).some((candidate) => {
            const other = matcherOf(candidate);
            return typeof other === 'string' && other.length > 0 && other === matcher;
          })
        ) {
          return id;
        }
      }
      return null;
    };

    // A selected id the library cannot resolve — absent file, parse failure —
    // reports its cause at library level, and its groups and bundle stay put
    // until the library is whole again.
    const unresolved = selected.filter((id) => byId.get(id)?.hooks === undefined);
    const deferCodexReconciliation = app === 'codex' && unresolved.length > 0;

    // Bundle files land before the config that points at them.
    const writes: Action[] = [];
    const desired: Record<string, unknown[]> = Object.create(null);
    const desiredById = new Map<string, Record<string, unknown[]>>();
    const owned: string[] = [];
    let distributed = 0;
    for (const id of selected) {
      const component = byId.get(id);
      if (!component?.hooks) continue;
      const source = row.filter ? row.filter(component.hooks) : component.hooks;
      if (Object.keys(source).length === 0) {
        actions.push({
          app,
          type: 'hooks',
          id,
          path: configPath,
          op: 'none',
          outcome: 'skipped',
          detail: 'unsupported',
          reason: `${app} supports none of this hook's events or handlers`,
        });
        continue;
      }
      distributed++;

      const bundlePath = component.files ? path.join(row.bundleDir(config.homes), id) : undefined;
      const rendered = renders.get(id) ?? renderHookGroups(source, bundlePath);
      desiredById.set(id, rendered);
      for (const [event, groups] of Object.entries(rendered)) {
        if (!desired[event]) desired[event] = [];
        desired[event].push(...groups);
      }
      if (!bundlePath) continue;

      owned.push(id);
      const files = component.files ?? [];
      const live = capture.bundles[bundlePath] ?? { exists: false, files: null, fingerprint: null };
      const desiredRels = new Set(files.map((file) => file.rel));
      const byRel =
        live.files !== null ? new Map(live.files.map((file) => [file.rel, file])) : null;
      const clean =
        byRel !== null &&
        live.files?.length === files.length &&
        files.every((file) => {
          const target = byRel.get(file.rel);
          return (
            target !== undefined &&
            target.hash === hashContent(file.bytes) &&
            targetModeMatchesSourceExecutableBits(file.mode, target.mode)
          );
        });
      const projectCollision = input.project && live.exists && !clean;
      if (projectCollision && input.project?.collision !== 'takeover') {
        writes.push({
          app,
          type: 'hooks',
          id,
          path: bundlePath,
          op: 'none',
          outcome: 'conflict',
          detail: 'foreign',
          reason: 'project hook bundle is occupied and the hook state does not own it; preserved',
        });
        continue;
      }
      writes.push(
        clean
          ? { app, type: 'hooks', id, path: bundlePath, op: 'none', outcome: 'unchanged' }
          : {
              app,
              type: 'hooks',
              id,
              path: bundlePath,
              op: 'write',
              outcome: 'written',
              detail: live.exists ? 'updated' : 'created',
              bundle: {
                files,
                // A distributed bundle mirrors its library directory, so files
                // the render does not name are cleared. That is what keeps the
                // tree provably asb's for a later deselection.
                stale: (live.files ?? [])
                  .map((file) => file.rel)
                  .filter((rel) => !desiredRels.has(rel)),
              },
              root,
              expectedHash: live.fingerprint,
            }
      );
    }

    // Deselected bundle directories, on the same proof as a skill bundle: a
    // tree that is byte-for-byte the render is asb's and comes out, and an id
    // the library no longer defines has nothing to compare against, so it
    // stays. A selected id the library cannot resolve keeps its tree too.
    const removals: Action[] = [];
    for (const component of byId.values()) {
      const id = component.id;
      if (deferCodexReconciliation) continue;
      if (owned.includes(id) || !component.files || unresolved.includes(id)) continue;
      const bundlePath = path.join(row.bundleDir(config.homes), id);
      const live = capture.bundles[bundlePath];
      if (!live?.exists) continue;
      if (live.files === null || live.fingerprint === null) {
        removals.push({
          app,
          type: 'hooks',
          id,
          path: bundlePath,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason:
            'distributed hook bundle now contains symlinks or special files asb cannot prove ownership of; delete it yourself',
        });
        continue;
      }
      const liveByRel = new Map(live.files.map((file) => [file.rel, file]));
      const proven =
        live.files.length === component.files.length &&
        component.files.every((file) => {
          const target = liveByRel.get(file.rel);
          return (
            target !== undefined &&
            target.hash === hashContent(file.bytes) &&
            targetModeMatchesSourceExecutableBits(file.mode, target.mode)
          );
        });
      if (!proven && input.project) {
        removals.push({
          app,
          type: 'hooks',
          id,
          path: bundlePath,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason: 'project hook bundle is not the current render; preserved',
        });
        continue;
      }
      removals.push({
        app,
        type: 'hooks',
        id,
        path: bundlePath,
        op: 'remove',
        outcome: 'removed',
        ...(proven ? {} : { detail: 'stale-copy' }),
        bundle: { files: [], stale: live.files.map((file) => file.rel) },
        root,
        expectedHash: live.fingerprint,
      });
    }

    // The merge rewrites each recognized group where it already sits. Codex
    // then canonicalizes the selected ASB groups into a shared prefix: its
    // trust keys are positional, and machines may have different local hooks.
    // Foreign groups retain their relative order at the tail. Other targets
    // keep the in-place order. An unresolved Codex selection holds membership
    // and order until every configured prefix group can render.
    const merged: Record<string, unknown[]> = Object.create(null);
    let reviewRequired = false;
    let removedGroups = 0;
    const unproven: { event: string; matcher: string; id: string }[] = [];
    const protectedIds = new Set(unresolved);
    for (const event of new Set([...Object.keys(existingHooks), ...Object.keys(desired)])) {
      const queue = new Map<string, unknown[]>();
      for (const [id, byEvent] of desiredById) {
        const groups = groupsFor(byEvent, event);
        if (groups.length > 0) queue.set(id, [...groups]);
      }
      const out: unknown[] = [];
      for (const group of existingHooks[event] ?? []) {
        const owner = hookGroupOwner(group, ownership);
        const id = owner?.id ?? renderOwnerOf(group, event);
        if (owner === null && id === null) {
          out.push(group);
          const kinId = kinIdOf(group, event);
          const matcher = matcherOf(group);
          if (kinId !== null && typeof matcher === 'string') {
            unproven.push({ event, matcher, id: kinId });
          }
          continue;
        }
        if (id !== null && protectedIds.has(id)) {
          out.push(group);
          continue;
        }
        // Reaching here with no id means a predecessor's marker proved the
        // group asb's without saying which hook wrote it. When exactly one
        // hook still has a group waiting for this event, that is the hook,
        // and rewriting it where it sits leaves every group below at the
        // index Codex recorded its trust against.
        const waiting = [...queue.values()].filter((groups) => groups.length > 0);
        const pending = id !== null ? queue.get(id) : waiting.length === 1 ? waiting[0] : undefined;
        if (pending && pending.length > 0) {
          const next = pending.shift();
          out.push(next);
          if (!isDeepStrictEqual(next, group)) reviewRequired = true;
          continue;
        }
        if (deferCodexReconciliation) {
          out.push(group);
          continue;
        }
        removedGroups++;
      }
      if (!deferCodexReconciliation) {
        for (const groups of queue.values()) {
          out.push(...groups);
          if (groups.length > 0) reviewRequired = true;
        }
      }
      let ordered = out;
      if (app === 'codex' && !deferCodexReconciliation) {
        const residual = [...out];
        const prefix: unknown[] = [];
        for (const group of desired[event] ?? []) {
          const index = residual.findIndex((candidate) => isDeepStrictEqual(candidate, group));
          if (index >= 0) prefix.push(...residual.splice(index, 1));
        }
        ordered = [...prefix, ...residual];
        if (!isDeepStrictEqual(ordered, out)) reviewRequired = true;
        const existing = existingHooks[event] ?? [];
        if (
          ordered.some(
            (group, index) =>
              !isDeepStrictEqual(group, existing[index]) &&
              existing.some((candidate) => isDeepStrictEqual(candidate, group))
          )
        ) {
          reviewRequired = true;
        }
      }
      if (ordered.length > 0) merged[event] = ordered;
    }
    const removed = removedGroups > 0;

    // Naming a group costs the file nothing, so the report comes before the
    // decision to leave the file alone: a predecessor group is reported once
    // per run whether or not this run has anything to write.
    for (const { event, matcher, id: kinId } of unproven) {
      actions.push({
        app,
        type: 'hooks',
        id: null,
        path: configPath,
        op: 'none',
        outcome: 'left-behind',
        detail: 'unproven',
        reason: `a ${event} group matching ${matcher} in ${configPath} is not one asb can prove it wrote — likely an older render of ${kinId}; delete it yourself`,
      });
    }

    // Nothing selected and nothing of asb's in the config: the run has no
    // business rewriting a file it does not own.
    if (distributed === 0 && !removed && !hadLegacyManagedKey) continue;
    const next = { ...captured.config };
    delete next._asb_managed_hooks;
    if (Object.keys(merged).length === 0) delete next.hooks;
    else next.hooks = merged;
    const configEdits: KeysEdit[] = [];
    if (hadLegacyManagedKey) configEdits.push({ keyPath: ['_asb_managed_hooks'], remove: true });
    if (Object.keys(merged).length === 0) {
      if (Object.hasOwn(captured.config, 'hooks')) {
        configEdits.push({ keyPath: ['hooks'], remove: true });
      }
    } else {
      configEdits.push({ keyPath: ['hooks'], value: merged });
    }

    const currentHash = captured.content !== null ? hashContent(captured.content) : null;
    const baseContent = captured.content ?? '';
    let content: string;
    try {
      content =
        configEdits.length > 0 ? applyKeysEdits(baseContent, 'json', configEdits) : baseContent;
    } catch (error) {
      // An uneditable host (duplicate keys, malformed structure) is contained:
      // nothing lands, nothing is removed, no ownership is published for it.
      actions.push({
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'parse-error',
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // A file that exists only to carry hooks goes away with them; one asb
    // shares with the app (settings.json) never does.
    const emptied = distributed === 0 && Object.keys(merged).length === 0;
    let configAction: Action;
    if (row.deleteWhenEmpty && emptied && Object.keys(next).length === 0) {
      configAction = captured.exists
        ? {
            ...base,
            op: 'remove',
            outcome: 'removed',
            detail: 'cleared',
            // A symlinked config keeps its link and receives the empty
            // document instead, or the managed groups stay behind in the
            // dotfiles store with nothing pointing at them.
            content: `${JSON.stringify(next, null, 2)}\n`,
            root,
            expectedHash: currentHash,
          }
        : { ...base, op: 'none', outcome: 'unchanged' };
    } else if (captured.content === content) {
      configAction = { ...base, op: 'none', outcome: 'unchanged' };
    } else {
      configAction = {
        ...base,
        op: 'write',
        outcome: 'written',
        detail: emptied ? 'cleared' : 'merged',
        // A trust review is attached only where the hooks that need it are
        // known to be in place; that lives with the push below.
        content,
        root,
        expectedHash: currentHash,
        keyEdits: { format: 'json', edits: configEdits, baseContent },
      };
    }

    // Bundles land first, then the removals they authorize, and only then the
    // config that points at both: a config naming payload this run failed to
    // write is a broken hook.
    const gate = owned.length > 0 ? { requires: [...owned] } : {};
    const gatedRemovals = removals.map((removal) => ({ ...removal, ...gate }));
    // The trust notice follows the hooks that need reviewing, not the write
    // that happened to carry them: none are in place, there is nothing to
    // review; bundles that fail to land leave the config pointing at payload
    // this run never distributed, so the run's skip is named over the notice.
    if (configAction.op === 'write' && configAction.outcome === 'written') {
      // A review is only ever owed for hooks this run put into the config: a
      // write that only removes (the survivors were already in place) asks for
      // none, and a bundle that failed to land leaves the config pointing at
      // payload the run never distributed, so the run's skip is named instead.
      const failed = writes.filter((w) => w.outcome === 'conflict').length;
      let reviewReason: string | undefined;
      if (!reviewRequired) {
        reviewReason = undefined;
      } else if (failed > 0) {
        reviewReason = `${failed} hook bundle(s) could not land; the config still points at them: fix and run asb sync again`;
      } else {
        reviewReason = row.reviewNotice;
      }
      configAction =
        reviewReason === undefined ? configAction : { ...configAction, reason: reviewReason };
    }
    actions.push(...writes, ...gatedRemovals, { ...configAction, ...gate });
  }

  return actions.map((action) => {
    if (
      (action.op === 'write' || action.op === 'remove') &&
      action.path !== null &&
      capture.bundles[action.path]?.escapes === true
    ) {
      return {
        app: action.app,
        type: action.type,
        id: action.id,
        path: action.path,
        op: 'none' as const,
        outcome: 'blocked' as const,
        detail: 'path-escape',
        reason: `parent directory of ${action.path} resolves outside the app root; not touching it`,
      };
    }
    return action;
  });
}

// ---------------------------------------------------------------------------
// MCP: named slices inside a structured document the user also owns
// ---------------------------------------------------------------------------

interface McpSlice {
  /** Library component id: the key as authored. */
  id: string;
  /** Key path the value occupies on disk, sanitized per the app's grammar. */
  keyPath: string[];
  outcome: Outcome;
  detail?: string;
  reason?: string;
  /** Rendered value, for explain. */
  desired: unknown;
  current: unknown;
  /** The value on disk is the render, which is the whole proof of ownership. */
  proven?: boolean;
  /** Present when this slice contributes to the host's grouped write. */
  edit?: KeysEdit;
}

interface McpHostPlan {
  slices: McpSlice[];
  /** Set when nothing about this host can be planned. */
  failure?: { outcome: Outcome; detail: string; reason: string };
}

/**
 * Whether a key holds an edited copy of what the library renders, rather than
 * a different server that happens to share its name: the same invocation with
 * different options. Enough to say the server is still there, never enough to
 * remove it — that takes the render itself.
 */
function editedRender(current: unknown, desired: unknown, fields: readonly string[]): boolean {
  if (!isPlainObject(current) || !isPlainObject(desired)) return false;
  const identifying = fields.filter((field) => desired[field] !== undefined);
  return (
    identifying.length > 0 &&
    identifying.every((field) => isDeepStrictEqual(current[field], desired[field]))
  );
}

/** What a host holds where asb expects a table, for a reason line. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * One app's MCP host, slice by slice. A key is asb's while it holds what the
 * library renders for that server, so a selected server is written whenever it
 * differs and a deselected one comes out only on that proof. The name of the
 * key is not evidence: `memory` or `fetch` is what anyone would call a server
 * they wrote themselves, so a key holding something else is left alone.
 */
function planMcpHost(
  app: string,
  row: McpTargetRow,
  captured: CapturedMcpHost,
  selected: readonly string[],
  byId: ReadonlyMap<string, Component>,
  wanted: ReadonlySet<string>,
  project?: ProjectPlanPolicy
): McpHostPlan {
  const slices: McpSlice[] = [];
  const diskIdFor = (id: string): string => (row.sanitize ? sanitizeMcpName(id) : id);
  const identityField = row.keyField ?? 'name';
  const keyPathFor = (id: string): string[] => {
    const diskId = diskIdFor(id);
    return row.structure === 'keyed-array'
      ? [keyedArraySegment(row.rootKey, identityField, diskId)]
      : [row.rootKey, diskId];
  };

  // Two ids that sanitize to one key would take turns owning it and silently
  // erase each other; 0.4 threw, and the run reports it as this app's failure.
  const claimed = new Map<string, string>();
  for (const id of selected) {
    if (!byId.has(id)) continue;
    const key = diskIdFor(id);
    const first = claimed.get(key);
    if (first !== undefined && first !== id) {
      return {
        slices,
        failure: {
          outcome: 'failed',
          detail: 'render-error',
          reason: `MCP name collision: "${first}" and "${id}" both become "${key}" for ${app}; rename one of them`,
        },
      };
    }
    claimed.set(key, id);
  }

  // The server map itself. A value that is not a table reads through as an
  // absent server key, so every slice would take the create branch and hand
  // the writer a parent it cannot index; the host fails on its own instead.
  const container = valueAtKeyPath(captured.root, [row.rootKey]);
  const keyedProblem =
    row.structure === 'keyed-array' && captured.root !== null
      ? keyedArrayProblem(captured.root, row.rootKey, identityField)
      : null;
  if (
    keyedProblem !== null ||
    (row.structure !== 'keyed-array' && container !== undefined && !isPlainObject(container))
  ) {
    return {
      slices,
      failure: {
        outcome: 'failed',
        detail: 'parse-error',
        reason: `cannot use ${path.basename(captured.path)}, MCP servers not merged: ${
          keyedProblem ?? `${row.rootKey} is ${describeValue(container)}, not a table of servers`
        }`,
      },
    };
  }

  // Why a TOML key path cannot be spliced, or null when it can be. The writer
  // addresses one table by its byte span, so a descendant header
  // ([mcp_servers.x.env]) is outside the span even though TOML merges it into
  // the value: replacing the parent would orphan it beside the keys asb
  // writes, and removing the parent would leave the server declared.
  const unspliceable = (keyPath: readonly string[]): string | null => {
    if (row.format !== 'toml') return null;
    const name = tomlHeaderName(keyPath);
    const nested = captured.tables.find(
      (parts) =>
        parts.length > keyPath.length && keyPath.every((segment, i) => parts[i] === segment)
    );
    if (nested !== undefined)
      return `[${tomlHeaderName(nested)}] nests under ${name} in ${captured.path}`;
    const exact = captured.tables.some(
      (parts) =>
        parts.length === keyPath.length && keyPath.every((segment, i) => parts[i] === segment)
    );
    if (exact) return null;
    return `${name} is not written as a table in ${captured.path}`;
  };
  const selectedIds = new Set(selected);
  const desiredServerKeys = new Set<string>();
  for (const id of selected) {
    const component = byId.get(id);
    if (!component?.server) continue;
    const keyPath = keyPathFor(id);
    const dialectValue = row.dialect(component.server);
    if (dialectValue === null) {
      slices.push({
        id,
        keyPath,
        outcome: 'skipped',
        detail: 'unsupported',
        reason: `${app} does not support this server's transport`,
        desired: null,
        current: valueAtKeyPath(captured.root, keyPath),
      });
      continue;
    }
    desiredServerKeys.add(diskIdFor(id));
    const value =
      row.structure === 'keyed-array'
        ? { ...dialectValue, [identityField]: diskIdFor(id) }
        : dialectValue;

    const current = valueAtKeyPath(captured.root, keyPath);
    const base = { id, keyPath, desired: value, current };
    const edit: KeysEdit = row.render
      ? { keyPath, value, text: row.render(keyPath, value) }
      : { keyPath, value };
    if (current === undefined) {
      if (!captured.exists && !row.create) {
        slices.push({
          ...base,
          outcome: 'skipped',
          detail: 'host-file-absent',
          reason: `${captured.path} does not exist and this app's host is never created by asb`,
        });
        continue;
      }
      slices.push({
        ...base,
        outcome: 'written',
        detail: captured.exists ? 'updated' : 'created',
        edit,
      });
      continue;
    }

    if (sliceHash(current) === sliceHash(value)) {
      slices.push({ ...base, outcome: 'unchanged', proven: true });
      continue;
    }

    const unaddressable = unspliceable(keyPath);
    if (unaddressable !== null) {
      slices.push({
        ...base,
        outcome: 'blocked',
        detail: 'foreign',
        reason: `${unaddressable}; asb edits whole tables only — move it or remove it by hand`,
      });
      continue;
    }

    // Selecting a server asks for the library's definition at that key, so the
    // render lands in one pass however the key got there. A project run
    // without takeover keeps the repository's own value instead.
    slices.push(
      project && project.collision !== 'takeover'
        ? {
            ...base,
            outcome: 'conflict',
            detail: 'foreign',
            reason: `${diskIdFor(id)} in ${captured.path} is not the current render; preserved`,
          }
        : {
            ...base,
            outcome: 'written',
            detail: project ? 'takeover' : 'updated',
            edit,
          }
    );
  }

  // Library servers nothing selects here any more. A key holding the render is
  // provably asb's and comes out on that proof; anything else stays. A value
  // that still runs the same server with different options is that server,
  // edited, so it is named once — a key that merely shares the name is a
  // stranger and is not spoken of at all.
  for (const component of byId.values()) {
    if (selectedIds.has(component.id) || !component.server) continue;
    if (wanted.has(`${captured.path}::${diskIdFor(component.id)}`)) continue;
    const dialectValue = row.dialect(component.server);
    if (dialectValue === null) continue;
    const keyPath = keyPathFor(component.id);
    const current = valueAtKeyPath(captured.root, keyPath);
    if (current === undefined) continue;
    const value =
      row.structure === 'keyed-array'
        ? { ...dialectValue, [identityField]: diskIdFor(component.id) }
        : dialectValue;
    const base = { id: component.id, keyPath, desired: null, current };
    const proven = sliceHash(current) === sliceHash(value);
    const unaddressable = unspliceable(keyPath);
    if (proven && unaddressable === null) {
      slices.push({
        ...base,
        proven: true,
        outcome: 'removed',
        edit: { keyPath, remove: true },
      });
      continue;
    }
    if (!proven && !editedRender(current, value, ['command', 'args', 'url'])) continue;
    slices.push({
      ...base,
      outcome: 'left-behind',
      detail: 'modified',
      reason: unaddressable
        ? `${unaddressable}; delete it yourself`
        : `${diskIdFor(component.id)} in ${captured.path} is no longer the library's definition; delete it yourself or re-enable the server`,
    });
  }

  if (project?.mode === 'exclusive') {
    const presentServerKeys =
      row.structure === 'keyed-array'
        ? Array.isArray(container)
          ? container.flatMap((value) =>
              isPlainObject(value) && typeof value[identityField] === 'string'
                ? [value[identityField] as string]
                : []
            )
          : []
        : isPlainObject(container)
          ? Object.keys(container)
          : [];
    for (const serverKey of presentServerKeys) {
      if (desiredServerKeys.has(serverKey)) continue;
      const keyPath =
        row.structure === 'keyed-array'
          ? [keyedArraySegment(row.rootKey, identityField, serverKey)]
          : [row.rootKey, serverKey];
      const current = valueAtKeyPath(captured.root, keyPath);
      const problem = unspliceable(keyPath);
      slices.push(
        problem
          ? {
              id: serverKey,
              keyPath,
              outcome: 'left-behind',
              detail: 'modified',
              reason: `${problem}; delete it yourself`,
              desired: null,
              current,
            }
          : {
              id: serverKey,
              keyPath,
              outcome: 'removed',
              desired: null,
              current,
              edit: { keyPath, remove: true },
            }
      );
    }
  }

  return { slices };
}

/**
 * MCP planner. A server is a key inside a document the app and the user also
 * write, so the unit of ownership is the key path, not the file: every edit to
 * one host in one run becomes a single read-modify-write, and everything
 * outside the owned key paths round-trips byte for byte.
 *
 * Zero selected servers plan no MCP file anywhere — an empty desired set never
 * creates a host, which is where 0.4 wrote an empty server map instead.
 */
export function planMcp(input: PlanInput): Action[] {
  const { config, inventory, capture, table } = input;
  const actions: Action[] = [];

  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'mcp')
      .map((component) => [component.id, component])
  );
  const failedIds = new Set(
    inventory.failed.filter((failure) => failure.type === 'mcp').map((failure) => failure.id)
  );
  const assumeInstalled = new Set(config.apps.assumeInstalled);

  const rows: { app: string; row: McpTargetRow; selected: string[] }[] = [];
  const missingUnion = new Set<string>();
  const enabledApps = new Set(config.apps.enabled);
  // A project run visits every app that has a host in the tree, so the keys it
  // wrote for an app the user has since dropped come out of that app's file.
  const appIds = config.project
    ? new Set([
        ...config.apps.enabled,
        ...table.filter((candidate) => candidate.mcp).map((candidate) => candidate.id),
      ])
    : enabledApps;
  for (const appId of appIds) {
    const row = table.find((candidate) => candidate.id === appId)?.mcp;
    if (!row) continue;
    const enabled = enabledApps.has(appId);
    if (enabled && capture.installed[appId] !== true && !assumeInstalled.has(appId)) continue;
    if (!enabled && capture.mcp[appId]?.exists !== true) continue;
    const selected = enabled ? input.selection(appId, 'mcp') : [];
    for (const id of selected) {
      if (!byId.has(id) && !failedIds.has(id)) missingUnion.add(id);
    }
    // Nothing to write and no library server that could be sitting at one of
    // these keys: a document asb has no business in is not read for problems
    // either.
    if (
      selected.length === 0 &&
      byId.size === 0 &&
      !(input.project?.mode === 'exclusive' && capture.mcp[appId]?.exists)
    )
      continue;
    rows.push({ app: appId, row, selected });
  }

  // Two apps can share one host — trae and trae-cn in a project tree — so a
  // key another app still wants is never cleaned up behind its back.
  const wanted = new Set(
    rows.flatMap(({ app, row, selected }) => {
      const captured = capture.mcp[app];
      if (!captured) return [];
      return selected.flatMap((id) => {
        const component = byId.get(id);
        if (!component?.server || row.dialect(component.server) === null) return [];
        return [`${captured.path}::${row.sanitize ? sanitizeMcpName(id) : id}`];
      });
    })
  );

  for (const id of missingUnion) {
    actions.push({
      app: null,
      type: 'mcp',
      id,
      path: null,
      op: 'none',
      outcome: 'missing',
      reason: `enabled but not defined (expected a "${id}" entry in ${config.homes.asbHome}/mcp.json or a plugin's servers)`,
    });
  }

  for (const { app, row, selected } of rows) {
    const captured = capture.mcp[app];
    if (!captured) continue;
    const base = { app, type: 'mcp', id: null, path: captured.path };

    if (captured.escapes === true) {
      actions.push({
        ...base,
        op: 'none',
        outcome: 'blocked',
        detail: 'path-escape',
        reason: `parent directory of ${captured.path} resolves outside the app root; not touching it`,
      });
      continue;
    }
    if (captured.root === null) {
      actions.push({
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'parse-error',
        reason: `cannot read ${path.basename(captured.path)}, MCP servers not merged: ${captured.error ?? 'document root must be an object'}`,
      });
      continue;
    }

    const { slices, failure } = planMcpHost(
      app,
      row,
      captured,
      selected,
      byId,
      wanted,
      input.project
    );
    if (failure) {
      actions.push({ ...base, op: 'none', ...failure });
      continue;
    }

    const edits: KeysEdit[] = [];
    const wrote: string[] = [];
    const retired: string[] = [];
    for (const slice of slices) {
      if (!slice.edit) {
        // A slice with no edit changes nothing in the host document.
        if (slice.outcome === 'unchanged') {
          actions.push({
            app,
            type: 'mcp',
            id: slice.id,
            path: captured.path,
            op: 'none',
            outcome: 'unchanged',
          });
          continue;
        }
        const action: Action = {
          app,
          type: 'mcp',
          id: slice.id,
          path: captured.path,
          op: 'none',
          outcome: slice.outcome,
        };
        if (slice.detail !== undefined) action.detail = slice.detail;
        if (slice.reason !== undefined) action.reason = slice.reason;
        actions.push(action);
        continue;
      }
      edits.push(slice.edit);
      if (slice.outcome === 'removed') retired.push(slice.id);
      else wrote.push(slice.id);
    }

    if (edits.length === 0) continue;

    let content: string;
    try {
      content = applyKeysEdits(captured.content ?? '', row.format, edits);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      actions.push({
        ...base,
        op: 'none',
        outcome: reason.includes('unmanaged YAML') ? 'conflict' : 'failed',
        detail: 'parse-error',
        reason,
      });
      continue;
    }
    const summary = [
      wrote.length > 0 ? `wrote ${wrote.join(', ')}` : '',
      retired.length > 0 ? `retired ${retired.join(', ')}` : '',
    ]
      .filter((part) => part.length > 0)
      .join('; ');

    if (content === captured.content) {
      actions.push({ ...base, op: 'none', outcome: 'unchanged' });
      continue;
    }
    actions.push({
      ...base,
      op: 'write',
      outcome: 'written',
      detail: captured.exists ? 'merged' : 'created',
      reason: summary,
      content,
      root: row.root(config.homes),
      expectedHash: captured.content !== null ? hashContent(captured.content) : null,
      keyEdits: { format: row.format, edits, baseContent: captured.content ?? '' },
    });
  }

  return actions;
}

/**
 * Add-only Codex trust for a project whose MCP destination is active. The row
 * writes outside the repository, so only a run that named the project asks for
 * it: syncing inside a cloned repository leaves the machine's Codex trust
 * exactly as it found it, and says so where the write would have been.
 */
export function planCodexProjectTrust(input: PlanInput, mcpActions: readonly Action[]): Action[] {
  if (!input.project) return [];
  const planned = mcpActions.some(
    (action) =>
      action.app === 'codex' &&
      action.type === 'mcp' &&
      ((action.op === 'write' && action.reason?.includes('wrote ') === true) ||
        (action.id !== null && action.outcome === 'unchanged'))
  );
  if (!planned) return [];

  const captured = input.capture.projectTrust;
  if (!captured) return [];
  const base = {
    app: 'codex',
    type: 'mcp',
    id: null,
    path: captured.path,
  } as const;
  if (!input.project.explicit) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'skipped',
        detail: 'ambient-project',
        reason: `${input.project.root} was detected in the working directory rather than named, so Codex project trust is not written; re-run with -P ${input.project.root} to trust it`,
      },
    ];
  }
  if (captured.escapes === true) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'blocked',
        detail: 'path-escape',
        reason: `parent directory of ${captured.path} resolves outside the Codex root; not touching it`,
      },
    ];
  }
  if (captured.root === null) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'parse-error',
        reason: `cannot read ${path.basename(captured.path)}, project trust not merged: ${captured.error ?? 'document root must be an object'}`,
      },
    ];
  }

  const projects = valueAtKeyPath(captured.root, ['projects']);
  const existing = valueAtKeyPath(captured.root, ['projects', input.project.root]);
  if (existing !== undefined) {
    if (isPlainObject(existing) && existing.trust_level === 'trusted') {
      return [{ ...base, op: 'none', outcome: 'unchanged' }];
    }
    return [
      {
        ...base,
        op: 'none',
        outcome: 'conflict',
        detail: 'foreign',
        reason: `Codex project trust is untrusted or malformed for ${input.project.root}; preserving it`,
      },
    ];
  }
  if (projects !== undefined && !isPlainObject(projects)) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'conflict',
        detail: 'foreign',
        reason: 'Codex projects trust table is malformed; preserving it',
      },
    ];
  }

  const edit: KeysEdit = {
    keyPath: ['projects', input.project.root, 'trust_level'],
    value: 'trusted',
    scalar: true,
  };
  try {
    const content = applyKeysEdits(captured.content ?? '', 'toml', [edit]);
    return [
      {
        ...base,
        op: 'write',
        outcome: 'written',
        projectAction: true,
        detail: captured.exists ? 'merged' : 'created',
        content,
        root: path.dirname(captured.path),
        expectedHash: captured.content === null ? null : hashContent(captured.content),
        keyEdits: { format: 'toml', edits: [edit], baseContent: captured.content ?? '' },
      },
    ];
  } catch (error) {
    return [
      {
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'parse-error',
        reason: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

/** Merge cells editing the same structured host after CLI action filters. */
export function groupKeyActions(actions: readonly Action[]): Action[] {
  const grouped: Action[] = [];
  const byPath = new Map<string, number>();
  const cancel = (
    action: Action,
    outcome: 'conflict' | 'failed',
    detail: string,
    reason: string
  ): Action => ({
    ...action,
    op: 'none',
    outcome,
    detail,
    reason,
    keyEdits: undefined,
  });
  const pathsOverlap = (left: readonly string[], right: readonly string[]): boolean => {
    const length = Math.min(left.length, right.length);
    return left.slice(0, length).every((part, index) => part === right[index]);
  };
  for (const action of actions) {
    if (action.op !== 'write' || !action.path || !action.keyEdits) {
      grouped.push(action);
      continue;
    }
    const index = byPath.get(action.path);
    if (index === undefined) {
      byPath.set(action.path, grouped.length);
      grouped.push({ ...action });
      continue;
    }
    const first = grouped[index];
    if (
      !first.keyEdits ||
      first.keyEdits.format !== action.keyEdits.format ||
      first.keyEdits.baseContent !== action.keyEdits.baseContent ||
      first.root !== action.root ||
      first.expectedHash !== action.expectedHash
    ) {
      const reason = 'structured cells captured incompatible views of one host';
      grouped[index] = cancel(first, 'failed', 'capture-error', reason);
      grouped.push(cancel(action, 'failed', 'capture-error', reason));
      continue;
    }
    const overlap = first.keyEdits.edits
      .flatMap((left) => action.keyEdits?.edits.map((right) => ({ left, right })) ?? [])
      .find(
        ({ left, right }) =>
          pathsOverlap(left.keyPath, right.keyPath) && !isDeepStrictEqual(left, right)
      );
    if (overlap) {
      const reason = `structured cells edit the same key path (${overlap.left.keyPath.join('.')})`;
      grouped[index] = cancel(first, 'conflict', 'shared-key', reason);
      grouped.push(cancel(action, 'conflict', 'shared-key', reason));
      continue;
    }
    const edits = [
      ...first.keyEdits.edits,
      ...action.keyEdits.edits.filter(
        (candidate) =>
          !first.keyEdits?.edits.some((existing) => isDeepStrictEqual(existing, candidate))
      ),
    ];
    let content: string;
    try {
      content = applyKeysEdits(first.keyEdits.baseContent, first.keyEdits.format, edits);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      grouped[index] = {
        ...first,
        op: 'none',
        outcome: reason.includes('unmanaged YAML') ? 'conflict' : 'failed',
        detail: 'parse-error',
        reason,
        keyEdits: undefined,
      };
      continue;
    }
    grouped[index] = {
      ...first,
      type: first.type === action.type ? first.type : null,
      id: null,
      reason: [first.reason, action.reason].filter(Boolean).join('; ') || undefined,
      content,
      requiresPaths: [
        ...new Set([...(first.requiresPaths ?? []), ...(action.requiresPaths ?? [])]),
      ],
      keyEdits: { ...first.keyEdits, edits },
    };
  }
  return grouped;
}

export function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'))
  );
}

/** `collision=error` suppresses every project mutation after the full plan is known. */
export function preflightProjectActions(
  actions: readonly Action[],
  project: ProjectPlanPolicy
): Action[] {
  if (project.collision !== 'error') return [...actions];
  const belongs = (action: Action): boolean =>
    action.projectAction === true ||
    (action.path !== null && pathInside(project.root, action.path));
  const collision = actions.find(
    (action) =>
      belongs(action) &&
      (action.outcome === 'conflict' ||
        (action.outcome === 'blocked' && action.detail === 'foreign'))
  );
  if (!collision) return [...actions];
  const reason = `project collision preflight failed at ${collision.path ?? collision.id ?? 'unknown target'}; no project write was applied`;
  return actions.map((action) => {
    if (!belongs(action) || action.op === 'none') return action;
    return {
      ...action,
      op: 'none',
      outcome: 'skipped',
      detail: 'project-preflight',
      reason,
      content: undefined,
      bundle: undefined,
      root: undefined,
      expectedHash: undefined,
      keyEdits: undefined,
      native: undefined,
    };
  });
}

/**
 * MCP view over the same planner. A server is identified by its key, so a
 * target matches a library id, an app id, or a host path, and each matched
 * slice reports the value asb would write beside the one on disk.
 */
export function explainMcp(input: PlanInput, target: string): ExplainSlice[] {
  const { config, inventory, capture, table } = input;
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'mcp')
      .map((component) => [component.id, component])
  );
  const assumeInstalled = new Set(config.apps.assumeInstalled);

  const slices: ExplainSlice[] = [];
  for (const action of planMcp(input)) {
    if (action.app === null && (action.id === target || action.path === target)) {
      slices.push(librarySlice(action));
    }
  }

  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId)?.mcp;
    const captured = capture.mcp[appId];
    if (!row || !captured) continue;
    if (capture.installed[appId] !== true && !assumeInstalled.has(appId)) continue;
    const { slices: hostSlices } = planMcpHost(
      appId,
      row,
      captured,
      input.selection(appId, 'mcp'),
      byId,
      new Set<string>(),
      input.project
    );
    for (const slice of hostSlices) {
      const pathMatch = captured.path === target || captured.path.endsWith(`${path.sep}${target}`);
      if (slice.id !== target && appId !== target && !pathMatch) continue;
      const component = byId.get(slice.id);
      const explained: ExplainSlice = {
        app: appId,
        path: captured.path,
        outcome: slice.outcome,
        provenance: slice.proven ? 'identity' : null,
        currentHash: slice.current === undefined ? null : sliceHash(slice.current),
        desiredHash: slice.desired === null ? null : sliceHash(slice.desired),
        desired:
          slice.desired === null
            ? null
            : `${JSON.stringify(
                maskMcpCredentialMaps(slice.desired, new Set(row.credentialKeys), row.envKeyName),
                null,
                2
              )}\n`,
        components: component ? [{ id: component.id, path: component.path }] : [],
        sources: component ? componentSources([component]) : [],
      };
      if (slice.detail !== undefined) explained.detail = slice.detail;
      if (slice.reason !== undefined) explained.reason = slice.reason;
      slices.push(explained);
    }
  }
  return slices;
}

/**
 * A credential child is a name→value record, or — after a kv-array env
 * dialect — an array of member records. Without a known env-name field every
 * member field is masked; over-masking never leaks.
 */
function maskCredentialChild(child: unknown, envKeyName: string | undefined): unknown {
  if (isPlainObject(child)) {
    return Object.fromEntries(Object.keys(child).map((name) => [name, '***']));
  }
  if (Array.isArray(child)) {
    return child.map((member) =>
      isPlainObject(member)
        ? Object.fromEntries(
            Object.entries(member).map(([field, fieldValue]) => [
              field,
              envKeyName !== undefined && field === envKeyName ? fieldValue : '***',
            ])
          )
        : '***'
    );
  }
  return child;
}

function maskMcpCredentialMaps(
  value: unknown,
  credentialKeys: ReadonlySet<string>,
  envKeyName?: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((member) => maskMcpCredentialMaps(member, credentialKeys, envKeyName));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      credentialKeys.has(key)
        ? maskCredentialChild(child, envKeyName)
        : maskMcpCredentialMaps(child, credentialKeys, envKeyName),
    ])
  );
}

// ---------------------------------------------------------------------------
// Source-level rows
// ---------------------------------------------------------------------------

export interface SourcePlanInput {
  config: ResolvedConfig;
  catalog: SourceCatalog;
  /** What the readiness phase did, or would do on a preview. */
  readiness: readonly ReadinessRow[];
  /** Refresh outcomes, empty when no refresh was requested or on a preview. */
  updates: readonly UpdateRow[];
  /** Sources a preview would refresh; empty on a real run. */
  pendingRefresh: readonly string[];
  /** External marketplace entries the sources phase fetched, or would. */
  entries: readonly EntryRow[];
  dryRun: boolean;
}

function sourceRow(
  id: string,
  targetPath: string | null,
  outcome: Outcome,
  detail: string | undefined,
  reason: string
): Action {
  const action: Action = {
    app: null,
    // Source-level rows carry no component type, so no `--type` filter can
    // hide a source that failed.
    type: null,
    id,
    path: targetPath,
    op: 'none',
    outcome,
    reason,
  };
  if (detail !== undefined) action.detail = detail;
  return action;
}

/**
 * Everything the sources phase has to say: what it materialized or would
 * materialize, what it could not read, and what a selection points at that is
 * not there. These rows are reports, never work — readiness runs before the
 * planner, so nothing here is left for the executor to do.
 */
export function planSources(input: SourcePlanInput): Action[] {
  const { config, catalog, readiness, updates, pendingRefresh, entries, dryRun } = input;
  const actions: Action[] = [];

  // A namespace resolution refused has no location to be ready at, and the
  // resolution row names what the user wrote rather than a path derived from
  // it, so that row is the one worth printing.
  const unresolved = new Set(catalog.unresolved.map((failure) => failure.namespace));
  for (const row of readiness) {
    if (row.status === 'error') {
      if (unresolved.has(row.namespace)) continue;
      actions.push(
        sourceRow(row.namespace, row.path, 'failed', 'source-error', row.error ?? 'unknown error')
      );
      continue;
    }
    if (!row.action) continue;
    const migrating = row.action === 'migrate';
    actions.push(
      dryRun
        ? sourceRow(
            row.namespace,
            row.path,
            'pending',
            'clone',
            migrating
              ? `would migrate the existing checkout into ${row.path}`
              : `would clone into ${row.path}`
          )
        : sourceRow(
            row.namespace,
            row.path,
            'written',
            undefined,
            migrating ? `migrated into ${row.path}` : `cloned into ${row.path}`
          )
    );
  }

  for (const namespace of pendingRefresh) {
    actions.push(sourceRow(namespace, null, 'pending', 'refresh', 'would refresh from its remote'));
  }

  // A refresh that changed nothing is silent, like a source that was already
  // ready; only what failed is worth a row.
  for (const row of updates) {
    if (row.status !== 'error') continue;
    if (unresolved.has(row.namespace)) continue;
    const where = row.phase === 'readiness' ? 'before it could refresh: ' : '';
    actions.push(
      sourceRow(
        row.namespace,
        null,
        'failed',
        'source-error',
        `${where}${row.error ?? 'unknown error'}`
      )
    );
  }

  // A source asb cannot read is reported rather than skipped: its plugins are
  // absent from the scan, and silence there would look like a source that
  // contributes nothing.
  for (const failure of catalog.failed) {
    actions.push(
      sourceRow(failure.namespace, failure.path, 'failed', 'source-error', failure.error)
    );
  }

  // An external entry the run reached says so in its own row: fetched, or a
  // preview of the fetch, or the reason the fetch did not happen.
  for (const entry of entries) {
    if (entry.status === 'pending') {
      actions.push(
        sourceRow(entry.id, entry.url, 'pending', 'clone', `would fetch from ${entry.url}`)
      );
    } else if (entry.status === 'fetched') {
      actions.push(sourceRow(entry.id, entry.url, 'written', undefined, `fetched ${entry.url}`));
    } else {
      actions.push(
        sourceRow(
          entry.id,
          entry.url,
          'missing',
          undefined,
          `enabled but its content could not be fetched from ${entry.url}: ${entry.error ?? 'unknown error'}`
        )
      );
    }
  }

  // An enabled plugin whose content is not on disk names where asb looked, so
  // the fix is visible without a second command. It never authorizes removal:
  // absent content is not deselection.
  const enabledPlugins = new Set(
    config.apps.enabled.flatMap((appId) => effectivePlugins(config, appId))
  );
  const reported = new Set(entries.map((entry) => entry.id));
  for (const absent of catalog.absent) {
    if (reported.has(absent.id) || !enabledPlugins.has(absent.id)) continue;
    const declared = absent.url ? ` (declared as ${absent.url})` : '';
    actions.push(
      sourceRow(
        absent.id,
        absent.path,
        'missing',
        undefined,
        `enabled but its source content is not there${declared}; expected ${absent.path}`
      )
    );
  }

  return actions;
}

/**
 * How a slice proves it is asb's when someone asks. `identity` is the target
 * holding what the library renders; `marker` is a region asb delimits inside a
 * file it shares; `native-manager` is work the app's own plugin manager owns.
 * A hook group's managed path proves the group rather than the file it sits
 * in, and explain speaks in whole slices, so it has no spelling here.
 */
export type Ownership = 'identity' | 'marker' | 'native-manager';

export interface ExplainSlice {
  /** Owning app, or null for library-level rows (missing, parse failures). */
  app: string | null;
  path: string | null;
  outcome: Outcome;
  detail?: string;
  reason?: string;
  /** What proves the slice is asb's right now; null when nothing does. */
  provenance: Ownership | null;
  currentHash: string | null;
  desiredHash: string | null;
  /** Rendered desired bytes; null when nothing is selected or the aggregate is blocked. */
  desired: string | null;
  /** Library components composing the slice. */
  components: { id: string; path: string }[];
  /** Explicit source attribution for those components. */
  sources?: { id: string; source: string; path: string }[];
}

function componentSources(components: readonly Component[]): NonNullable<ExplainSlice['sources']> {
  return components.map((component) => ({
    id: component.id,
    source: component.source,
    path: component.path,
  }));
}

/** Library-level planner rows (app null) carried into an explain view. */
function librarySlice(action: Action): ExplainSlice {
  const slice: ExplainSlice = {
    app: null,
    path: action.path,
    outcome: action.outcome,
    provenance: null,
    currentHash: null,
    desiredHash: null,
    desired: null,
    components: [],
  };
  if (action.detail !== undefined) slice.detail = action.detail;
  if (action.reason !== undefined) slice.reason = action.reason;
  return slice;
}

/** Source rows for one target: a namespace, a plugin id, or a source path. */
export function explainSources(
  input: SourcePlanInput,
  target: string,
  inventory: LibraryInventory
): ExplainSlice[] {
  const rows = [
    ...planSources(input),
    ...planCatalogStatus(input.config, input.catalog, inventory),
  ];
  const plugin = input.catalog.plugins.find(
    (candidate) => candidate.id === target || candidate.name === target
  );
  return rows
    .filter(
      (action) =>
        action.id === target ||
        action.path === target ||
        (plugin !== undefined && action.id === plugin.id)
    )
    .map(librarySlice);
}

function explainEntries(input: PlanInput, target: string, type: EntryType): ExplainSlice[] {
  const { config, inventory, capture, table } = input;
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === type)
      .map((component) => [component.id, component])
  );
  const slices: ExplainSlice[] = [];

  for (const action of planEntries(input, type)) {
    if (action.app === null) {
      if (action.id === target || action.path === target) slices.push(librarySlice(action));
      continue;
    }
    const pathMatch =
      action.path !== null &&
      (action.path === target || action.path.endsWith(`${path.sep}${target}`));
    if (action.id !== target && action.app !== target && !pathMatch) continue;

    const component = action.id === null ? undefined : byId.get(action.id);
    const row = table.find((candidate) => candidate.id === action.app)?.[type];
    let currentHash: string | null = null;
    let desiredHash: string | null = null;
    let desired: string | null = null;

    if (component && row && action.path !== null) {
      const ownPath = path.join(row.dir(config.homes), row.filename(component.id));
      if (action.path === ownPath) {
        const current = capture.targets[action.path]?.content;
        currentHash = current === null || current === undefined ? null : hashContent(current);
        try {
          desired = row.render(component);
        } catch {
          desired = null;
        }
        desiredHash = desired === null ? null : hashContent(desired);
      } else if (type === 'agents' && row.config?.path(config.homes) === action.path) {
        const candidate = row.config.component(component, row.filename(component.id));
        const current = valueAtKeyPath(capture.mcp[action.app]?.root ?? null, candidate.keyPath);
        currentHash = current === undefined ? null : sliceHash(current);
        desiredHash = sliceHash(candidate.value);
        desired = candidate.text;
      }
    } else if (action.path !== null) {
      const current = capture.targets[action.path]?.content;
      currentHash = current === null || current === undefined ? null : hashContent(current);
      desired = action.content ?? null;
      desiredHash = desired === null ? null : hashContent(desired);
    }

    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      // The target holding what the library renders is the whole proof.
      provenance: currentHash !== null && currentHash === desiredHash ? 'identity' : null,
      currentHash,
      desiredHash,
      desired,
      components: component ? [{ id: component.id, path: component.path }] : [],
      sources: component ? componentSources([component]) : [],
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    if (action.reason !== undefined) slice.reason = action.reason;
    slices.push(slice);
  }
  return slices;
}

export function explainCommands(input: PlanInput, target: string): ExplainSlice[] {
  return explainEntries(input, target, 'commands');
}

export function explainAgents(input: PlanInput, target: string): ExplainSlice[] {
  return explainEntries(input, target, 'agents');
}

export function explainNative(input: NativePlanInput, target: string): ExplainSlice[] {
  const slices: ExplainSlice[] = [];
  for (const action of planNative(input)) {
    const pathMatch =
      action.path !== null &&
      (action.path === target || action.path.endsWith(`${path.sep}${target}`));
    if (action.id !== target && action.app !== target && !pathMatch) continue;
    const plugin = input.catalog.plugins.find(
      (candidate) =>
        candidate.id === action.id ||
        candidate.native?.install?.ref === action.id ||
        action.id?.endsWith(`@${candidate.id}`)
    );
    const sourcePath = plugin?.root ?? plugin?.native?.manifestPath;
    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      provenance: 'native-manager',
      currentHash: null,
      desiredHash: null,
      desired: null,
      components: [],
      sources:
        plugin && sourcePath ? [{ id: plugin.id, source: plugin.source, path: sourcePath }] : [],
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    if (action.reason !== undefined) slice.reason = action.reason;
    slices.push(slice);
  }
  return slices;
}

/**
 * Skills view over the same planner: match a skill id, app id, or bundle path
 * and join each matched slice with the captured tree fingerprint. Own-dir
 * slices have no single rendered body, so `desired` stays null and the source
 * bundle appears under `components`.
 */
export function explainSkills(input: PlanInput, target: string): ExplainSlice[] {
  const { inventory, capture } = input;
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'skills')
      .map((component) => [component.id, component])
  );
  const slices: ExplainSlice[] = [];
  for (const action of planSkills(input)) {
    if (action.app === null) {
      // Library-level rows (missing, parse failures) explain by id or path;
      // without them a missing skill would explain to silence.
      if (action.id === target || action.path === target) {
        slices.push(librarySlice(action));
      }
      continue;
    }
    if (action.id === null || action.path === null) continue;
    const pathMatch = action.path === target || action.path.endsWith(`${path.sep}${target}`);
    if (action.id !== target && action.app !== target && !pathMatch) continue;

    const component = byId.get(action.id);

    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      // A tree the planner found equal to the render is asb's; one it is
      // about to overwrite or leave behind is not.
      provenance:
        action.outcome === 'unchanged' ||
        (action.outcome === 'removed' && action.detail !== 'stale-copy')
          ? 'identity'
          : null,
      currentHash: capture.bundles[action.path]?.fingerprint ?? null,
      desiredHash: null,
      desired: null,
      components: component ? [{ id: component.id, path: component.path }] : [],
      sources: component ? componentSources([component]) : [],
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    slices.push(slice);
  }
  return slices;
}

/**
 * Hooks view over the same planner. A hook bundle is asb's while it holds what
 * the library renders, and a group is asb's while it equals a rendered group
 * or names a managed path. A definition entry owns no directory, so its slice
 * is the app config it merged into.
 */
export function explainHooks(input: PlanInput, target: string): ExplainSlice[] {
  const { inventory, capture } = input;
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'hooks')
      .map((component) => [component.id, component])
  );

  const slices: ExplainSlice[] = [];
  for (const action of planHooks(input)) {
    if (action.app === null) {
      if (action.id === target || action.path === target) {
        slices.push(librarySlice(action));
      }
      continue;
    }
    if (action.path === null) continue;
    // A definition entry owns no directory of its own, so a library id the
    // app actually carries also matches that app's config slice.
    const carried = byId.has(target) && input.selection(action.app, 'hooks').includes(target);
    const idMatch = action.id === target || (action.id === null && carried);
    const pathMatch = action.path === target || action.path.endsWith(`${path.sep}${target}`);
    if (!idMatch && action.app !== target && !pathMatch) continue;

    const captured = capture.hooks[action.app];
    const component = byId.get(action.id ?? target);
    // A bundle the planner found equal to the render is asb's; one it is about
    // to overwrite is not yet, and the app config is shared with whatever the
    // user wrote there no matter which groups inside it derive.
    const proven =
      action.id !== null &&
      (action.outcome === 'unchanged' ||
        (action.outcome === 'removed' && action.detail !== 'stale-copy'));

    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      provenance: proven ? 'identity' : null,
      currentHash:
        action.id === null
          ? captured?.content != null
            ? hashContent(captured.content)
            : null
          : (capture.bundles[action.path]?.fingerprint ?? null),
      desiredHash: null,
      desired: null,
      components: component ? [{ id: component.id, path: component.path }] : [],
      sources: component ? componentSources([component]) : [],
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    if (action.reason !== undefined) slice.reason = action.reason;
    slices.push(slice);
  }
  return slices;
}

/**
 * One-target view over the same planner: match a component id, app id, or
 * target path (exact or basename) and join each matched slice with the bytes
 * on disk and the freshly rendered desired content.
 */
export function explainRules(input: PlanInput, target: string): ExplainSlice[] {
  const { capture, table } = input;
  const resolveFor = rulesResolver(input);

  const slices: ExplainSlice[] = [];
  for (const action of planRules(input)) {
    if (action.app === null) {
      if (action.id === target || action.path === target) {
        slices.push(librarySlice(action));
      }
      continue;
    }
    const { present, missing, content } = resolveFor(action.app);
    const pathMatch =
      action.path !== null && (action.path === target || action.path.endsWith(`/${target}`));
    const componentMatch = present.some((component) => component.id === target);
    if (action.app !== target && !pathMatch && !componentMatch) continue;

    const row = table.find((candidate) => candidate.id === action.app);
    const captured = action.path !== null ? capture.targets[action.path] : undefined;
    // A write action already carries the exact bytes the target would hold,
    // markers and untouched neighbours included, which the bare render does
    // not. `unchanged` means the target is already those bytes.
    const desired =
      action.content ??
      (action.outcome === 'unchanged'
        ? (captured?.content ?? null)
        : action.path !== null && row?.rules && missing.length === 0 && content.length > 0
          ? row.rules.render(content, action.path)
          : null);
    const current = captured?.content != null ? hashContent(captured.content) : null;
    const desiredHash = desired !== null ? hashContent(desired) : null;
    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      // A shared host is asb's only between its markers; a dedicated file is
      // asb's while it holds the render.
      provenance:
        row?.rules && !row.rules.dedicated
          ? captured?.content != null && projectRegion(captured.content) !== null
            ? 'marker'
            : null
          : current !== null && current === desiredHash
            ? 'identity'
            : null,
      currentHash: current,
      desiredHash,
      desired,
      components: present.map((component) => ({ id: component.id, path: component.path })),
      sources: componentSources(present),
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    slices.push(slice);
  }
  return slices;
}
