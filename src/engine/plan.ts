import path from 'node:path';
import { AGENTS_SKILLS_UNION, type AppRow } from './apps.js';
import { effectiveIncludeDelimiters, effectiveSelection, type ResolvedConfig } from './config.js';
import { type Ledger, type LedgerEntry, ledgerKey, type Provenance } from './ledger.js';
import type { Component, LibraryInventory } from './library.js';
import type { Outcome } from './report.js';
import {
  type BundleFile,
  composeRules,
  hashContent,
  type TargetFile,
  targetModeMatchesSourceExecutableBits,
} from './shapes.js';

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

export interface SyncCapture {
  /** Detection probe results per app id. */
  installed: Record<string, boolean>;
  /** Current bytes per absolute target path (null when unreadable). */
  targets: Record<string, CapturedTarget>;
  /** Live bundle state per absolute bundle directory. */
  bundles: Record<string, CapturedBundle>;
  /** Non-dot child directory names per managed skills parent. */
  bundleDirs: Record<string, string[]>;
}

export interface Action {
  app: string | null;
  type: string | null;
  id: string | null;
  path: string | null;
  op: 'write' | 'remove' | 'adopt' | 'none';
  outcome: Outcome;
  detail?: string;
  reason?: string;
  /** Desired bytes for `write`. */
  content?: string;
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
  /** Ledger mutation carried by this action. */
  ledger?: { op: 'put'; entry: LedgerEntry } | { op: 'delete'; key: string };
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

    const { missing, content } = resolveFor(appId);

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

    if (desired.length === 0) {
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
        if (currentHash === recorded.hash) {
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
    // location grants convention adoption for update (0.4 overwrote these
    // files; updating is behavior parity). Deletion authority never follows
    // from convention — but this write makes the bytes ours by fact.
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

  for (const appId of config.apps.enabled) {
    const row = table.find((candidate) => candidate.id === appId);
    if (!row?.skills || !detected(appId)) continue;
    const effective = effectiveSelection(config, appId, 'skills');
    for (const id of effective) {
      if (!byId.has(id) && !failedIds.has(id)) missingUnion.add(id);
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
  const unionRecordedOrPresent =
    ledger.entries.some((entry) => entry.app === 'agents' && entry.type === 'skills') ||
    unionSelected.length > 0;
  if (unionRecordedOrPresent) {
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
          actions.push({
            ...base,
            op: 'remove',
            outcome: 'removed',
            bundle: { files: [], stale: recorded.files ?? [] },
            root: row.root,
            expectedHash: recorded.hash,
            ledger: { op: 'delete', key: ledgerKey(recorded) },
          });
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
        } else if (captured.files === null) {
          actions.push({
            ...base,
            op: 'none',
            outcome: 'left-behind',
            detail: 'unproven',
            reason:
              'directory matches this skill by name but contains symlinks or special files asb cannot prove ownership of; move it away or delete it yourself',
          });
        } else {
          // Convention: name-matched child of the managed parent, update
          // authority over desired rels only; foreign files stay.
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

export interface ExplainSlice {
  app: string;
  path: string | null;
  outcome: Outcome;
  detail?: string;
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
    if (action.app === null) continue;
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
