import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AGENTS_SKILLS_UNION,
  type AppRow,
  type HooksTargetRow,
  type McpTargetRow,
} from './apps.js';
import {
  effectiveIncludeDelimiters,
  effectivePlugins,
  effectiveSelection,
  isPlainObject,
  type ResolvedConfig,
} from './config.js';
import { preferHomeVar, sanitizeMcpName } from './dialects.js';
import { type Ledger, type LedgerEntry, ledgerKey, type Provenance } from './ledger.js';
import type { Component, HookEventMap, LibraryInventory } from './library.js';
import type { NativeWork } from './native.js';
import { type HookTarget, type PeerState, peerStateHasContent } from './peer.js';
import type { Outcome } from './report.js';
import {
  applyKeysEdits,
  type BundleFile,
  composeRules,
  hashContent,
  type KeysEdit,
  sliceHash,
  type TargetFile,
  targetModeMatchesSourceExecutableBits,
  valueAtKeyPath,
} from './shapes.js';
import type { EntryRow, ReadinessRow, SourceCatalog, UpdateRow } from './sources.js';

/**
 * The pure planner: selection × inventory × table × ledger × captured fs
 * state → actions. Nothing here touches the filesystem; the capture is taken
 * once and shared by preview and apply, so they cannot diverge structurally.
 *
 * Ownership proofs for the rules cell, in order and nothing else: (1) ledger
 * entry whose hash matches the captured slice; (3) byte-identity with the
 * current render; (5) convention — a table-declared managed location, update
 * authority only, never deletion. Marker proof (2) belongs to region shapes
 * and peer-record proof (4) to hook state and project manifests; neither has
 * a rules own-file carrier. Removal is authorized only by deselection.
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
  /** Peer ownership record: the shared file merged with any device copies. */
  state: PeerState;
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
  /** TOML table headers the byte-splice writer can address, dotted. */
  tables: string[];
  /** Parent chain of the host path resolves outside the app root. */
  escapes?: boolean;
}

export interface SyncCapture {
  /** Detection probe results per app id. */
  installed: Record<string, boolean>;
  /** Current bytes per absolute target path (null when unreadable). */
  targets: Record<string, CapturedTarget>;
  /** Live bundle state per absolute bundle directory. */
  bundles: Record<string, CapturedBundle>;
  /** Non-dot child directory names per managed skills parent. */
  bundleDirs: Record<string, string[]>;
  /** Hook config and peer ownership state per app id. */
  hooks: Record<string, CapturedHookApp>;
  /** MCP host document per app id. */
  mcp: Record<string, CapturedMcpHost>;
}

export type LedgerMutation = { op: 'put'; entry: LedgerEntry } | { op: 'delete'; key: string };

export interface Action {
  app: string | null;
  type: string | null;
  id: string | null;
  path: string | null;
  op: 'write' | 'remove' | 'adopt' | 'none';
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
   * run. A config may not point at payload the run failed to distribute, and
   * the record that authorizes deleting it may not claim it either.
   */
  requires?: string[];
  /**
   * Own-dir payload: files to reconcile and the recorded rels no longer
   * desired. Present ⇒ the executor treats path as a bundle directory. For
   * `put` mutations the executor stamps the measured post-write fingerprint
   * into the ledger entry hash.
   */
  bundle?: { files: BundleFile[]; stale: string[] };
  /** Containment root for write/remove actions. */
  root?: string;
  /**
   * Hash the target must still carry at apply time (null = must be absent);
   * the executor re-reads and refuses on drift since planning.
   */
  expectedHash?: string | null;
  /**
   * Ledger mutation carried by this action. A grouped write over several
   * owned slices of one host carries one mutation per slice: they land
   * together or not at all, because one write is what put them there.
   */
  ledger?: LedgerMutation | LedgerMutation[];
  /**
   * Peer ownership record to publish once the action's own write succeeds.
   * Hook groups live in a file every peer reads, so their ownership travels
   * with this record instead of a ledger entry.
   */
  peer?: { asbHome: string; target: HookTarget; state: PeerState };
  /**
   * Native-manager work: the app's own plugin manager owns the result, so
   * there is no path, hash, or ledger entry — the commands are the apply.
   */
  native?: NativeWork;
}

export interface PlanInput {
  config: ResolvedConfig;
  inventory: LibraryInventory;
  ledger: Ledger;
  capture: SyncCapture;
  table: readonly AppRow[];
  now: string;
}

interface ResolvedRuleSet {
  present: Component[];
  missing: string[];
  content: string;
}

/**
 * Per-app rules resolution: the app's effective selection (global overlaid by
 * its override) composed with its effective delimiter setting. Apps sharing
 * one effective set share one composition.
 */
function rulesResolver(
  config: ResolvedConfig,
  inventory: LibraryInventory
): (appId: string) => ResolvedRuleSet {
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'rules')
      .map((component) => [component.id, component])
  );
  const cache = new Map<string, ResolvedRuleSet>();
  return (appId) => {
    const ids = effectiveSelection(config, appId, 'rules');
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

export function planRules(input: PlanInput): Action[] {
  const { config, inventory, ledger, capture, table, now } = input;
  const actions: Action[] = [];

  // Library-level failures always surface, selected or not (containment: the
  // failed entry errors, everything else proceeds).
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

  // An id two sources both claim resolves to the first reading; the losing
  // source is named so the collision is visible rather than inferred from
  // content nobody asked for.
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

  const resolveFor = rulesResolver(config, inventory);

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

  const ledgerByKey = new Map(ledger.entries.map((entry) => [ledgerKey(entry), entry]));
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

    const targetPath = row.rules.path(config.homes);
    const root = row.rules.root(config.homes);
    const current = capture.targets[targetPath] ?? { exists: false, content: null };
    const recorded = ledgerByKey.get(
      ledgerKey({ app: appId, type: 'rules', id: null, path: targetPath })
    );

    const { present, missing, content } = resolveFor(appId);

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

    const desired = content.length > 0 ? row.rules.render(content) : '';
    const desiredHash = hashContent(desired);
    const currentHash = current.content !== null ? hashContent(current.content) : null;

    const putEntry = (provenance: LedgerEntry['provenance']): Action['ledger'] => ({
      op: 'put',
      entry: {
        app: appId,
        type: 'rules',
        id: null,
        path: targetPath,
        shape: 'own-file',
        hash: desiredHash,
        provenance,
        updatedAt: now,
      },
    });

    // Removal is authorized only by true deselection. A selected set that
    // happens to compose to empty bytes (delimiters off, empty rule bodies)
    // falls through and writes the empty composition instead.
    if (present.length === 0) {
      if (!current.exists) {
        if (recorded) {
          actions.push({
            app: appId,
            type: 'rules',
            id: null,
            path: targetPath,
            op: 'none',
            outcome: 'removed',
            detail: 'already-absent',
            ledger: { op: 'delete', key: ledgerKey(recorded) },
          });
        }
        continue;
      }
      if (recorded) {
        if (currentHash === recorded.hash && recorded.provenance === 'convention') {
          // Adopted by convention and never rewritten by asb: the bytes are
          // the user's, so deselection relinquishes the claim without
          // deleting (design: convention never grants deletion).
          actions.push({
            app: appId,
            type: 'rules',
            id: null,
            path: targetPath,
            op: 'none',
            outcome: 'left-behind',
            detail: 'unproven',
            reason:
              'adopted by convention and never rewritten by asb; preserved — delete it yourself',
            ledger: { op: 'delete', key: ledgerKey(recorded) },
          });
        } else if (currentHash === recorded.hash) {
          actions.push({
            app: appId,
            type: 'rules',
            id: null,
            path: targetPath,
            op: 'remove',
            outcome: 'removed',
            root,
            expectedHash: currentHash,
            ledger: { op: 'delete', key: ledgerKey(recorded) },
          });
        } else {
          actions.push({
            app: appId,
            type: 'rules',
            id: null,
            path: targetPath,
            op: 'none',
            outcome: 'left-behind',
            detail: 'modified',
            reason: `edited since asb last wrote it (recorded ${recorded.hash.slice(0, 12)}, current ${currentHash?.slice(0, 12) ?? 'unreadable'}); delete it yourself or re-enable rules`,
            ledger: { op: 'delete', key: ledgerKey(recorded) },
          });
        }
        continue;
      }
      // No record. Dedicated asb-named files surface as unproven leftovers;
      // shared hosts with nothing selected are foreign and stay silent.
      if (row.rules.dedicated) {
        actions.push({
          app: appId,
          type: 'rules',
          id: null,
          path: targetPath,
          op: 'none',
          outcome: 'left-behind',
          detail: 'unproven',
          reason:
            'asb-named file with no ownership record; delete it yourself or `asb import` it into the library',
        });
      }
      continue;
    }

    if (!current.exists) {
      actions.push({
        app: appId,
        type: 'rules',
        id: null,
        path: targetPath,
        op: 'write',
        outcome: 'written',
        detail: 'created',
        content: desired,
        root,
        expectedHash: null,
        ledger: putEntry('written'),
      });
      continue;
    }

    if (current.content === desired) {
      if (recorded && recorded.hash === desiredHash) {
        actions.push({
          app: appId,
          type: 'rules',
          id: null,
          path: targetPath,
          op: 'none',
          outcome: 'unchanged',
        });
      } else {
        actions.push({
          app: appId,
          type: 'rules',
          id: null,
          path: targetPath,
          op: 'adopt',
          outcome: 'adopted',
          detail: 'identity',
          ledger: putEntry('identity'),
        });
      }
      continue;
    }

    if (recorded) {
      if (currentHash === recorded.hash) {
        actions.push({
          app: appId,
          type: 'rules',
          id: null,
          path: targetPath,
          op: 'write',
          outcome: 'written',
          detail: 'updated',
          content: desired,
          root,
          expectedHash: currentHash,
          ledger: putEntry('written'),
        });
      } else {
        actions.push({
          app: appId,
          type: 'rules',
          id: null,
          path: targetPath,
          op: 'none',
          outcome: 'conflict',
          reason: `modified since asb last wrote it (recorded ${recorded.hash.slice(0, 12)}, current ${currentHash?.slice(0, 12) ?? 'unreadable'}); resolve by hand, or disable rules for this app`,
        });
      }
      continue;
    }

    // Unrecorded, occupied, different bytes: the table-declared managed
    // location grants convention adoption for update only. Nothing is
    // written this run — the entry records the user's current bytes, the
    // next sync performs the update (and flips the entry to `written`), and
    // a deselect before that first rewrite preserves the file.
    if (currentHash === null) {
      actions.push({
        app: appId,
        type: 'rules',
        id: null,
        path: targetPath,
        op: 'none',
        outcome: 'blocked',
        detail: 'foreign',
        reason: 'occupied but unreadable; asb cannot prove what it would be overwriting',
      });
      continue;
    }
    actions.push({
      app: appId,
      type: 'rules',
      id: null,
      path: targetPath,
      op: 'adopt',
      outcome: 'adopted',
      detail: 'convention',
      reason: 'existing file adopted for update; the next sync writes the composed rules',
      ledger: {
        op: 'put',
        entry: {
          app: appId,
          type: 'rules',
          id: null,
          path: targetPath,
          shape: 'own-file',
          hash: currentHash,
          provenance: 'convention',
          updatedAt: now,
        },
      },
    });
  }

  // Escaping targets are decided here, from the capture, so dry-run and the
  // real run report the identical blocked entry; the executor re-checks live.
  return actions.map((action) => {
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
  });
}

interface SkillRowPlan {
  app: string;
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
 * Proofs for own-dir slices: (1) ledger entry whose tree fingerprint matches
 * the captured directory, with the recorded per-file list bounding deletion
 * authority; (3) byte-identity of the whole tree with the current desired
 * bundle; (5) convention — a name-matched child of a table-declared managed
 * parent grants update authority over desired rels only, never deletion of
 * anything else. Removal only by deselection, only with proof (1).
 */
export function planSkills(input: PlanInput): Action[] {
  const { config, inventory, ledger, capture, table, now } = input;
  const actions: Action[] = [];

  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'skills')
      .map((component) => [component.id, component])
  );
  const failedIds = new Set(
    inventory.failed.filter((failure) => failure.type === 'skills').map((failure) => failure.id)
  );
  const ledgerByKey = new Map(ledger.entries.map((entry) => [ledgerKey(entry), entry]));
  const assumeInstalled = new Set(config.apps.assumeInstalled);
  const detected = (appId: string): boolean =>
    capture.installed[appId] === true || assumeInstalled.has(appId);

  // One library-level row per id any enabled app selects but the library
  // lacks; skills aggregate nothing, so a missing id blocks no other slice.
  const missingUnion = new Set<string>();

  const rows: SkillRowPlan[] = [];
  const useAgentsDir = config.distribution.useAgentsDir;
  const trio = new Set(AGENTS_SKILLS_UNION.members);

  const trioEffective = new Map<string, Set<string>>();
  const memberDirs = new Map<string, string>();

  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId);
    if (!row?.skills || !detected(appId)) continue;
    const effective = effectiveSelection(config, appId, 'skills');
    for (const id of effective) {
      if (!byId.has(id) && !failedIds.has(id)) missingUnion.add(id);
    }
    if (trio.has(appId)) {
      trioEffective.set(appId, new Set(effective));
      memberDirs.set(appId, row.skills.dir(config.homes));
    }
    rows.push({
      app: appId,
      dir: row.skills.dir(config.homes),
      root: row.skills.root(config.homes),
      reserved: row.skills.reserved,
      // In agents mode the trio's own rows deselect everything: their copies
      // are stale by design and leave through the proof-gated removal path.
      selected: useAgentsDir && trio.has(appId) ? [] : effective,
    });
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

  const activeMembers = AGENTS_SKILLS_UNION.members.filter(
    (member) => config.apps.enabled.includes(member) && detected(member)
  );
  const unionSelected =
    useAgentsDir && activeMembers.length > 0
      ? [
          ...new Set(
            activeMembers.flatMap((member) => effectiveSelection(config, member, 'skills'))
          ),
        ]
      : [];
  const unionDir = AGENTS_SKILLS_UNION.dir(config.homes);
  const unionRowActive =
    AGENTS_SKILLS_UNION.participates(config.apps.enabled) &&
    (ledger.entries.some((entry) => entry.app === 'agents' && entry.type === 'skills') ||
      unionSelected.length > 0);
  if (unionRowActive) {
    rows.push({
      app: 'agents',
      dir: unionDir,
      root: AGENTS_SKILLS_UNION.root(config.homes),
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

  for (const row of rows) {
    const present = capture.bundleDirs[row.dir] ?? [];
    const recordedIds = ledger.entries
      .filter(
        (entry) =>
          entry.app === row.app &&
          entry.type === 'skills' &&
          entry.id !== null &&
          entry.shape === 'own-dir' &&
          path.dirname(entry.path) === row.dir
      )
      .map((entry) => entry.id as string);
    const candidates = [
      ...new Set([...row.selected, ...recordedIds, ...present.filter((name) => byId.has(name))]),
    ].filter((id) => !row.reserved.includes(id) && !id.startsWith('.'));

    for (const id of candidates) {
      const bundlePath = path.join(row.dir, id);
      const captured: CapturedBundle = capture.bundles[bundlePath] ?? {
        exists: false,
        files: null,
        fingerprint: null,
      };
      const recorded = ledgerByKey.get(
        ledgerKey({ app: row.app, type: 'skills', id, path: bundlePath })
      );
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
        for (const rel of recorded?.files ?? []) {
          if (!desiredByRel.has(rel) && capturedByRel.has(rel)) return false;
        }
        return true;
      };
      const identicalToDesired = (): boolean => {
        if (capturedByRel === null || captured.files === null) return false;
        if (captured.files.length !== desired.length) return false;
        return sliceClean();
      };

      const putEntry = (provenance: Provenance, hash: string): Action['ledger'] => ({
        op: 'put',
        entry: {
          app: row.app,
          type: 'skills',
          id,
          path: bundlePath,
          shape: 'own-dir',
          hash,
          files: desired.map((file) => file.rel),
          provenance,
          updatedAt: now,
        },
      });
      const base = { app: row.app, type: 'skills', id, path: bundlePath };

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
            ledger: putEntry('written', ''),
          });
        } else if (recorded) {
          actions.push({
            ...base,
            op: 'none',
            outcome: 'removed',
            detail: 'already-absent',
            ledger: { op: 'delete', key: ledgerKey(recorded) },
          });
        }
        continue;
      }

      if (recorded && captured.fingerprint !== null && captured.fingerprint === recorded.hash) {
        if (isSelected) {
          if (sliceClean()) {
            actions.push({ ...base, op: 'none', outcome: 'unchanged' });
          } else {
            actions.push({
              ...base,
              op: 'write',
              outcome: 'written',
              detail: 'updated',
              bundle: {
                files: desired,
                stale: (recorded.files ?? []).filter((rel) => !desiredByRel.has(rel)),
              },
              root: row.root,
              expectedHash: recorded.hash,
              ledger: putEntry('written', ''),
            });
          }
        } else {
          // Deselected here, but still wanted at the counterpart location of
          // an agents-dir toggle: defer until that copy is proven on disk.
          const waitingOn: string[] = [];
          if (useAgentsDir && trio.has(row.app) && trioEffective.get(row.app)?.has(id)) {
            const unionPath = path.join(unionDir, id);
            if (!bundleCleanAt(unionPath, component)) waitingOn.push(unionPath);
          }
          if (row.app === 'agents') {
            for (const [member, dir] of memberDirs) {
              if (!trioEffective.get(member)?.has(id)) continue;
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
          } else if (recorded.provenance === 'convention' && !identicalToDesired()) {
            // Adopted by convention and never rewritten: the tree is the
            // user's; deselection relinquishes the claim without deleting.
            actions.push({
              ...base,
              op: 'none',
              outcome: 'left-behind',
              detail: 'unproven',
              reason:
                'adopted by convention and never rewritten by asb; preserved — delete it yourself',
              ledger: { op: 'delete', key: ledgerKey(recorded) },
            });
          } else {
            actions.push({
              ...base,
              op: 'remove',
              outcome: 'removed',
              bundle: {
                files: [],
                // A convention entry records no files; it reaches removal
                // only through identicalToDesired (proof 3), so the desired
                // rels are exactly the live tree.
                stale:
                  recorded.provenance === 'convention'
                    ? desired.map((file) => file.rel)
                    : (recorded.files ?? []),
              },
              root: row.root,
              expectedHash: recorded.hash,
              ledger: { op: 'delete', key: ledgerKey(recorded) },
            });
          }
        }
        continue;
      }

      if (recorded) {
        // Recorded but the live tree no longer matches: user-modified — with
        // one exception. When every desired file is still byte-identical and
        // no stale recorded file lingers, the divergence is permission bits
        // or added foreign files: the bytes prove the content ours (proof 3),
        // so the run repairs modes and re-records rather than conflicting
        // (0.4's exec-bit repair behavior). Byte edits stay conflicts, and
        // removal authority still demands the exact recorded tree.
        const bytesClean = (): boolean => {
          if (capturedByRel === null) return false;
          for (const file of desired) {
            const liveFile = capturedByRel.get(file.rel);
            if (!liveFile || liveFile.hash !== hashContent(file.bytes)) return false;
          }
          for (const rel of recorded.files ?? []) {
            if (!desiredByRel.has(rel) && capturedByRel.has(rel)) return false;
          }
          return true;
        };
        if (isSelected) {
          if (captured.fingerprint !== null && bytesClean()) {
            actions.push({
              ...base,
              op: 'write',
              outcome: 'written',
              detail: 'updated',
              bundle: { files: desired, stale: [] },
              root: row.root,
              expectedHash: captured.fingerprint,
              ledger: putEntry('written', ''),
            });
            continue;
          }
          actions.push({
            ...base,
            op: 'none',
            outcome: 'conflict',
            reason: `modified since asb last wrote it (recorded ${recorded.hash.slice(0, 17)}, current ${captured.fingerprint?.slice(0, 17) ?? 'unprovable'}); resolve by hand, or disable this skill`,
          });
        } else {
          actions.push({
            ...base,
            op: 'none',
            outcome: 'left-behind',
            detail: 'modified',
            reason: `edited since asb last wrote it (recorded ${recorded.hash.slice(0, 17)}, current ${captured.fingerprint?.slice(0, 17) ?? 'unprovable'}); delete it yourself or re-enable the skill`,
            ledger: { op: 'delete', key: ledgerKey(recorded) },
          });
        }
        continue;
      }

      if (isSelected) {
        if (identicalToDesired() && captured.fingerprint !== null) {
          actions.push({
            ...base,
            op: 'adopt',
            outcome: 'adopted',
            detail: 'identity',
            ledger: putEntry('identity', captured.fingerprint),
          });
        } else if (captured.files === null || captured.fingerprint === null) {
          actions.push({
            ...base,
            op: 'none',
            outcome: 'left-behind',
            detail: 'unproven',
            reason:
              'directory matches this skill by name but contains symlinks or special files asb cannot prove ownership of; move it away or delete it yourself',
          });
        } else {
          // Convention: name-matched child of the managed parent adopts for
          // update only — nothing is written this run. The entry records the
          // user's current tree with an empty file list (so the first update
          // deletes nothing), the next sync writes the desired files, and a
          // deselect before that first rewrite preserves the tree.
          actions.push({
            ...base,
            op: 'adopt',
            outcome: 'adopted',
            detail: 'convention',
            reason: 'existing directory adopted for update; the next sync writes the skill files',
            ledger: {
              op: 'put',
              entry: {
                app: row.app,
                type: 'skills',
                id,
                path: bundlePath,
                shape: 'own-dir',
                hash: captured.fingerprint,
                files: [],
                provenance: 'convention',
                updatedAt: now,
              },
            },
          });
        }
        continue;
      }

      // Deselected, present, never recorded, name matches a library skill:
      // visible but untouchable without proof.
      actions.push({
        ...base,
        op: 'none',
        outcome: 'left-behind',
        detail: 'unproven',
        reason:
          'directory matches a library skill by name but has no ownership record; delete it yourself or enable the skill to adopt it',
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
 * `$HOME`-portable, and `_asb*` metadata is stripped — an app config holds no
 * ASB marker of any kind, which is why ownership needs the peer record.
 */
function renderHookGroups(
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
          rewritten[field] = preferHomeVar(resolved);
        }
        return rewritten;
      });
      return clean;
    });
  }
  return rendered;
}

/**
 * Count-bounded removal of recorded groups: each recorded instance takes out
 * the first deep-equal group and no more, so a user's own duplicate of a
 * managed group and a hand-edited copy both survive. Emptied events go.
 */
function spliceRecordedGroups(
  existing: Record<string, unknown[]>,
  recorded: Record<string, unknown[]>
): { hooks: Record<string, unknown[]>; removed: boolean; taken: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  const taken: Record<string, unknown[]> = {};
  let removed = false;
  for (const [event, groups] of Object.entries(existing)) {
    const remaining = [...groups];
    for (const group of recorded[event] ?? []) {
      const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, group));
      if (index >= 0) {
        taken[event] = [...(taken[event] ?? []), remaining[index]];
        remaining.splice(index, 1);
        removed = true;
      }
    }
    if (remaining.length > 0) hooks[event] = remaining;
  }
  return { hooks, removed, taken };
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
 * Hooks planner. The slice is a set of matcher groups inside a config file
 * the app and the user also own, so nothing is positional: the peer record
 * says exactly which groups asb appended, and only those come back out.
 *
 * Proofs for this slice: (4) the peer record — the sole authority for
 * splicing groups and for deleting a distributed bundle directory. Proof (1)
 * has no carrier here (the ledger records no hook groups), (2) no marker may
 * enter an app config, and (3) byte-identity would claim a group the user
 * wrote by hand. Shape validation runs before any write, so a config asb
 * cannot merge into never gets a partial distribution.
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
    const selected = effectiveSelection(config, appId, 'hooks');
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

    const state = captured.state;
    const {
      hooks: remainder,
      removed,
      taken,
    } = spliceRecordedGroups(
      (captured.config.hooks ?? {}) as Record<string, unknown[]>,
      state.events
    );

    // A selected id the library cannot resolve — absent file, parse failure —
    // reports at library level and nothing more: removal is authorized by
    // deselection alone, so a half-arrived library sync cannot cascade into
    // one (design: a component still enabled whose source files are absent is
    // `missing` and never triggers removal).
    const unresolved = selected.filter((id) => byId.get(id)?.hooks === undefined);

    // Bundle files land before the config that points at them.
    const writes: Action[] = [];
    const desired: Record<string, unknown[]> = {};
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
      for (const [event, groups] of Object.entries(renderHookGroups(source, bundlePath))) {
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
                // Deleting needs proof asb put the directory there, and the
                // loaded record is the only carrier. A name-colliding
                // directory asb has never distributed is adopted for update
                // only: its other files stay, the id enters the record with
                // this write, and later syncs reconcile the tree normally.
                stale: state.bundles.includes(id)
                  ? (live.files ?? [])
                      .map((file) => file.rel)
                      .filter((rel) => !desiredRels.has(rel))
                  : [],
              },
              root,
              expectedHash: live.fingerprint,
            }
      );
    }

    // Recorded groups no resolvable entry re-renders belong to the unresolved
    // ones: they go straight back into the config and stay in the record.
    // Sourced from what the splice actually took out of THIS config, never
    // from state.events directly — device-copy merges over-count there.
    if (unresolved.length > 0) {
      let stranded = 0;
      for (const [event, groups] of Object.entries(spliceRecordedGroups(taken, desired).hooks)) {
        desired[event] = [...(desired[event] ?? []), ...groups];
        stranded += groups.length;
      }
      if (stranded > 0) {
        actions.push({
          app,
          type: 'hooks',
          id: null,
          path: configPath,
          op: 'none',
          outcome: 'skipped',
          detail: 'not-selected',
          reason: `${stranded} recorded group(s) kept until the library resolves ${unresolved.join(', ')}; fix or deselect, then run asb sync again`,
        });
      }
    }

    // Nothing selected, nothing of ours in the config, no record: the run has
    // no business rewriting a config or a state file it does not own.
    if (distributed === 0 && !removed && !peerStateHasContent(state)) continue;

    // Deselected bundle directories: the peer record is the only thing that
    // says asb put them there, so it is the only thing that may remove them.
    const removals: Action[] = [];
    const retained: string[] = [];
    for (const id of state.bundles) {
      if (owned.includes(id)) continue;
      const bundlePath = path.join(row.bundleDir(config.homes), id);
      const live = capture.bundles[bundlePath];
      if (!live?.exists) continue;
      // With an unresolved selection this run cannot tell a deselected bundle
      // from one whose library entry merely went missing, so it removes
      // neither and reclaims both once the library is whole again. The
      // deferral is named: silence would freeze removals with no diagnosis.
      if (unresolved.length > 0) {
        retained.push(id);
        actions.push({
          app,
          type: 'hooks',
          id,
          path: bundlePath,
          op: 'none',
          outcome: 'skipped',
          detail: 'not-selected',
          reason: `kept until the library resolves ${unresolved.join(', ')}; fix or deselect, then run asb sync again`,
        });
        continue;
      }
      if (live.files === null || live.fingerprint === null) {
        retained.push(id);
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
      removals.push({
        app,
        type: 'hooks',
        id,
        path: bundlePath,
        op: 'remove',
        outcome: 'removed',
        bundle: { files: [], stale: live.files.map((file) => file.rel) },
        root,
        expectedHash: live.fingerprint,
      });
    }

    const merged: Record<string, unknown[]> = {};
    for (const [event, groups] of Object.entries(remainder)) merged[event] = [...groups];
    for (const [event, groups] of Object.entries(desired)) {
      if (!merged[event]) merged[event] = [];
      merged[event].push(...groups);
    }
    const next = { ...captured.config };
    if (Object.keys(merged).length === 0) delete next.hooks;
    else next.hooks = merged;

    const peer: Action['peer'] = {
      asbHome: config.homes.asbHome,
      target: row.stateTarget,
      state: { version: 1, events: desired, bundles: [...owned, ...retained], legacyBundles: [] },
    };
    const currentHash = captured.content !== null ? hashContent(captured.content) : null;
    const content = `${JSON.stringify(next, null, 2)}\n`;

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
            // dotfiles store with no record on any machine to reclaim them.
            content,
            root,
            expectedHash: currentHash,
            peer,
          }
        : { ...base, op: 'none', outcome: 'unchanged', peer };
    } else if (captured.content === content) {
      configAction = { ...base, op: 'none', outcome: 'unchanged', peer };
    } else {
      configAction = {
        ...base,
        op: 'write',
        outcome: 'written',
        detail: emptied ? 'cleared' : 'merged',
        content,
        root,
        expectedHash: currentHash,
        peer,
      };
    }

    // Bundles land first, then the removals they authorize, and only then the
    // config and the record that point at both: a config naming payload this
    // run failed to write is a broken hook, and a record claiming it hands
    // every peer authority to delete a directory asb never wrote. The record
    // is published last so a removal that could not delete can put its id
    // back before it goes out.
    const gate = owned.length > 0 ? { requires: [...owned] } : {};
    actions.push(...writes, ...removals.map((removal) => ({ ...removal, ...gate })), {
      ...configAction,
      ...gate,
    });
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
  recorded: LedgerEntry | null;
  /** Present when this slice contributes to the host's grouped write. */
  edit?: KeysEdit;
  ledger?: LedgerMutation;
}

interface McpHostPlan {
  slices: McpSlice[];
  /** Set when nothing about this host can be planned. */
  failure?: { outcome: Outcome; detail: string; reason: string };
}

/** What a host holds where asb expects a table, for a reason line. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * One app's MCP host, slice by slice. Proofs available here: (1) the ledger
 * entry whose hash matches the value now at that key path, and (3)
 * byte-identity with the value asb would write. Convention grants nothing —
 * a key inside a document asb does not own is the user's server until one of
 * those two proofs holds, so an unrecorded occupied key blocks rather than
 * being overwritten the way 0.4 did.
 */
function planMcpHost(
  app: string,
  row: McpTargetRow,
  captured: CapturedMcpHost,
  selected: readonly string[],
  byId: ReadonlyMap<string, Component>,
  ledger: Ledger,
  now: string
): McpHostPlan {
  const slices: McpSlice[] = [];
  const keyPathFor = (id: string): string[] => [
    row.rootKey,
    row.sanitize ? sanitizeMcpName(id) : id,
  ];

  // Two ids that sanitize to one key would take turns owning it and silently
  // erase each other; 0.4 threw, and the run reports it as this app's failure.
  const claimed = new Map<string, string>();
  for (const id of selected) {
    if (!byId.has(id)) continue;
    const key = keyPathFor(id)[1];
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
  if (container !== undefined && !isPlainObject(container)) {
    return {
      slices,
      failure: {
        outcome: 'failed',
        detail: 'parse-error',
        reason: `cannot use ${path.basename(captured.path)}, MCP servers not merged: ${row.rootKey} is ${describeValue(container)}, not a table of servers`,
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
    const name = keyPath.join('.');
    const nested = captured.tables.find((table) => table.startsWith(`${name}.`));
    if (nested !== undefined) return `[${nested}] nests under ${name} in ${captured.path}`;
    if (captured.tables.includes(name)) return null;
    return `${name} is not written as a table in ${captured.path}`;
  };
  const recordFor = (id: string, keyPath: string[]): LedgerEntry => ({
    app,
    type: 'mcp',
    id,
    path: captured.path,
    shape: 'keys',
    hash: '',
    keys: keyPath,
    provenance: 'written',
    updatedAt: now,
  });

  const desiredIds = new Set<string>();
  for (const id of selected) {
    const component = byId.get(id);
    if (!component?.server) continue;
    const keyPath = keyPathFor(id);
    const recorded =
      ledger.entries.find(
        (entry) => ledgerKey(entry) === ledgerKey({ app, type: 'mcp', id, path: captured.path })
      ) ?? null;
    const value = row.dialect(component.server);
    if (value === null) {
      slices.push({
        id,
        keyPath,
        outcome: 'skipped',
        detail: 'unsupported',
        reason: `${app} does not support this server's transport`,
        desired: null,
        current: valueAtKeyPath(captured.root, keyPath),
        recorded,
      });
      continue;
    }
    desiredIds.add(id);

    const current = valueAtKeyPath(captured.root, keyPath);
    const base = { id, keyPath, desired: value, current, recorded };
    const edit: KeysEdit = row.render
      ? { keyPath, value, text: row.render(keyPath, value) }
      : { keyPath, value };
    const put = (provenance: Provenance): LedgerMutation => ({
      op: 'put',
      entry: { ...recordFor(id, keyPath), hash: sliceHash(value), provenance },
    });

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
        ledger: put('written'),
      });
      continue;
    }

    const unaddressable = unspliceable(keyPath);
    if (unaddressable !== null) {
      slices.push({
        ...base,
        outcome: recorded ? 'conflict' : 'blocked',
        detail: recorded ? undefined : 'foreign',
        reason: `${unaddressable}; asb edits whole tables only — move it or remove it by hand`,
      });
      continue;
    }

    const currentHash = sliceHash(current);
    if (recorded) {
      if (currentHash !== recorded.hash) {
        slices.push({
          ...base,
          outcome: 'conflict',
          reason: `modified since asb last wrote it (recorded ${recorded.hash.slice(0, 12)}, current ${currentHash.slice(0, 12)}); resolve by hand, or disable this server for ${app}`,
        });
        continue;
      }
      if (currentHash === sliceHash(value)) {
        slices.push({ ...base, outcome: 'unchanged' });
        continue;
      }
      slices.push({ ...base, outcome: 'written', detail: 'updated', edit, ledger: put('written') });
      continue;
    }

    if (currentHash === sliceHash(value)) {
      slices.push({ ...base, outcome: 'adopted', detail: 'identity', ledger: put('identity') });
      continue;
    }
    slices.push({
      ...base,
      outcome: 'blocked',
      detail: 'foreign',
      reason: `${keyPath[1]} is already in ${captured.path} and asb never wrote it; rename yours, or delete that entry to let asb own the key`,
    });
  }

  // Recorded keys nothing selects any more. Removal needs the recorded hash
  // to still match: an edited value is the user's now, so the claim goes and
  // the value stays.
  for (const recorded of ledger.entries) {
    if (recorded.app !== app || recorded.type !== 'mcp' || recorded.path !== captured.path)
      continue;
    const id = recorded.id;
    if (id === null || desiredIds.has(id)) continue;
    const keyPath = recorded.keys ?? keyPathFor(id);
    const current = valueAtKeyPath(captured.root, keyPath);
    const base = { id, keyPath: [...keyPath], desired: null, current, recorded };
    const drop: LedgerMutation = { op: 'delete', key: ledgerKey(recorded) };
    if (current === undefined) {
      slices.push({ ...base, outcome: 'removed', detail: 'already-absent', ledger: drop });
      continue;
    }
    const unaddressable = unspliceable(keyPath);
    if (unaddressable !== null) {
      slices.push({
        ...base,
        outcome: 'left-behind',
        detail: 'modified',
        reason: `${unaddressable}; delete it yourself`,
        ledger: drop,
      });
      continue;
    }
    if (sliceHash(current) !== recorded.hash) {
      slices.push({
        ...base,
        outcome: 'left-behind',
        detail: 'modified',
        reason: `edited since asb last wrote it (recorded ${recorded.hash.slice(0, 12)}, current ${sliceHash(current).slice(0, 12)}); delete it yourself or re-enable the server`,
        ledger: drop,
      });
      continue;
    }
    slices.push({
      ...base,
      outcome: 'removed',
      edit: { keyPath: [...keyPath], remove: true },
      ledger: drop,
    });
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
  const { config, inventory, ledger, capture, table, now } = input;
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
  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId)?.mcp;
    if (!row) continue;
    if (capture.installed[appId] !== true && !assumeInstalled.has(appId)) continue;
    const selected = effectiveSelection(config, appId, 'mcp');
    for (const id of selected) {
      if (!byId.has(id) && !failedIds.has(id)) missingUnion.add(id);
    }
    // Nothing to write, nothing claimed there and nothing to adopt: a
    // document asb has no business in is not read for problems either.
    const claimedHere = ledger.entries.some(
      (entry) =>
        entry.app === appId && entry.type === 'mcp' && entry.path === capture.mcp[appId]?.path
    );
    if (selected.length === 0 && !claimedHere && byId.size === 0) continue;
    rows.push({ app: appId, row, selected });
  }

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

    const { slices, failure } = planMcpHost(app, row, captured, selected, byId, ledger, now);
    if (failure) {
      actions.push({ ...base, op: 'none', ...failure });
      continue;
    }

    const edits: KeysEdit[] = [];
    const mutations: LedgerMutation[] = [];
    const wrote: string[] = [];
    const retired: string[] = [];
    for (const slice of slices) {
      if (!slice.edit) {
        // Adoptions and relinquished claims are their own rows: each carries
        // the record it changes, and none of them touch the host.
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
          op: slice.outcome === 'adopted' ? 'adopt' : 'none',
          outcome: slice.outcome,
        };
        if (slice.detail !== undefined) action.detail = slice.detail;
        if (slice.reason !== undefined) action.reason = slice.reason;
        if (slice.ledger) action.ledger = slice.ledger;
        actions.push(action);
        continue;
      }
      edits.push(slice.edit);
      if (slice.ledger) mutations.push(slice.ledger);
      if (slice.outcome === 'removed') retired.push(slice.id);
      else wrote.push(slice.id);
    }

    if (edits.length === 0) continue;

    const content = applyKeysEdits(captured.content ?? '', row.format, edits);
    const summary = [
      wrote.length > 0 ? `wrote ${wrote.join(', ')}` : '',
      retired.length > 0 ? `retired ${retired.join(', ')}` : '',
    ]
      .filter((part) => part.length > 0)
      .join('; ');

    if (content === captured.content) {
      actions.push({ ...base, op: 'none', outcome: 'unchanged', ledger: mutations });
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
      ledger: mutations,
    });
  }

  return actions;
}

/**
 * MCP view over the same planner. A server is identified by its key, so a
 * target matches a library id, an app id, or a host path, and each matched
 * slice reports the value asb would write beside the one on disk.
 */
export function explainMcp(input: PlanInput, target: string): ExplainSlice[] {
  const { config, inventory, ledger, capture, table, now } = input;
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
      effectiveSelection(config, appId, 'mcp'),
      byId,
      ledger,
      now
    );
    for (const slice of hostSlices) {
      const pathMatch = captured.path === target || captured.path.endsWith(`${path.sep}${target}`);
      if (slice.id !== target && appId !== target && !pathMatch) continue;
      const component = byId.get(slice.id);
      const explained: ExplainSlice = {
        app: appId,
        path: captured.path,
        outcome: slice.outcome,
        provenance: slice.recorded?.provenance ?? null,
        recordedHash: slice.recorded?.hash ?? null,
        currentHash: slice.current === undefined ? null : sliceHash(slice.current),
        desiredHash: slice.desired === null ? null : sliceHash(slice.desired),
        desired: slice.desired === null ? null : `${JSON.stringify(slice.desired, null, 2)}\n`,
        components: component ? [{ id: component.id, path: component.path }] : [],
      };
      if (slice.detail !== undefined) explained.detail = slice.detail;
      if (slice.reason !== undefined) explained.reason = slice.reason;
      slices.push(explained);
    }
  }
  return slices;
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

export interface ExplainSlice {
  /** Owning app, or null for library-level rows (missing, parse failures). */
  app: string | null;
  path: string | null;
  outcome: Outcome;
  detail?: string;
  reason?: string;
  /** Recorded ownership proof, or null when no ledger record exists. */
  provenance: Provenance | null;
  recordedHash: string | null;
  currentHash: string | null;
  desiredHash: string | null;
  /** Rendered desired bytes; null when nothing is selected or the aggregate is blocked. */
  desired: string | null;
  /** Library components composing the slice. */
  components: { id: string; path: string }[];
}

/** Library-level planner rows (app null) carried into an explain view. */
function librarySlice(action: Action): ExplainSlice {
  const slice: ExplainSlice = {
    app: null,
    path: action.path,
    outcome: action.outcome,
    provenance: null,
    recordedHash: null,
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
export function explainSources(input: SourcePlanInput, target: string): ExplainSlice[] {
  return planSources(input)
    .filter((action) => action.id === target || action.path === target)
    .map(librarySlice);
}

/**
 * Skills view over the same planner: match a skill id, app id, or bundle
 * path and join each matched slice with its ledger record and captured tree
 * fingerprints. Own-dir slices have no single rendered body, so `desired`
 * stays null and the source bundle appears under `components`.
 */
export function explainSkills(input: PlanInput, target: string): ExplainSlice[] {
  const { inventory, ledger, capture } = input;
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'skills')
      .map((component) => [component.id, component])
  );
  const ledgerByKey = new Map(ledger.entries.map((entry) => [ledgerKey(entry), entry]));

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

    const recorded =
      ledgerByKey.get(
        ledgerKey({ app: action.app, type: 'skills', id: action.id, path: action.path })
      ) ?? null;
    const component = byId.get(action.id);

    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      provenance: recorded?.provenance ?? null,
      recordedHash: recorded?.hash ?? null,
      currentHash: capture.bundles[action.path]?.fingerprint ?? null,
      desiredHash: null,
      desired: null,
      components: component ? [{ id: component.id, path: component.path }] : [],
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    slices.push(slice);
  }
  return slices;
}

/**
 * Hooks view over the same planner. Hook groups carry no ledger entry, so the
 * owner is the peer record: a bundle it lists, or an app config it holds
 * groups for, is owned by proof (4) and nothing else. A definition entry owns
 * no directory, so its slice is the app config it merged into.
 */
export function explainHooks(input: PlanInput, target: string): ExplainSlice[] {
  const { config, inventory, capture } = input;
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
    const carried =
      byId.has(target) && effectiveSelection(config, action.app, 'hooks').includes(target);
    const idMatch = action.id === target || (action.id === null && carried);
    const pathMatch = action.path === target || action.path.endsWith(`${path.sep}${target}`);
    if (!idMatch && action.app !== target && !pathMatch) continue;

    const captured = capture.hooks[action.app];
    const component = byId.get(action.id ?? target);
    const claimed =
      action.id === null
        ? Object.keys(captured?.state.events ?? {}).length > 0
        : (captured?.state.bundles.includes(action.id) ?? false);

    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      provenance: claimed ? 'peer-record' : null,
      recordedHash: null,
      currentHash:
        action.id === null
          ? captured?.content != null
            ? hashContent(captured.content)
            : null
          : (capture.bundles[action.path]?.fingerprint ?? null),
      desiredHash: null,
      desired: null,
      components: component ? [{ id: component.id, path: component.path }] : [],
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    if (action.reason !== undefined) slice.reason = action.reason;
    slices.push(slice);
  }
  return slices;
}

/**
 * One-target view over the same planner: match a component id, app id, or
 * target path (exact or basename) and join each matched slice with its
 * ledger record, captured bytes, and freshly rendered desired content.
 */
export function explainRules(input: PlanInput, target: string): ExplainSlice[] {
  const { config, inventory, ledger, capture, table } = input;
  const resolveFor = rulesResolver(config, inventory);
  const ledgerByKey = new Map(ledger.entries.map((entry) => [ledgerKey(entry), entry]));

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
    const desired =
      action.path !== null && row?.rules && missing.length === 0 && content.length > 0
        ? row.rules.render(content)
        : null;
    const recorded =
      action.path !== null
        ? (ledgerByKey.get(
            ledgerKey({ app: action.app, type: 'rules', id: null, path: action.path })
          ) ?? null)
        : null;
    const current = action.path !== null ? capture.targets[action.path] : undefined;

    const slice: ExplainSlice = {
      app: action.app,
      path: action.path,
      outcome: action.outcome,
      provenance: recorded?.provenance ?? null,
      recordedHash: recorded?.hash ?? null,
      currentHash: current?.content != null ? hashContent(current.content) : null,
      desiredHash: desired !== null ? hashContent(desired) : null,
      desired,
      components: present.map((component) => ({ id: component.id, path: component.path })),
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    slices.push(slice);
  }
  return slices;
}
