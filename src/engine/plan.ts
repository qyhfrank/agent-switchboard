import type { AppRow } from './apps.js';
import type { ResolvedConfig } from './config.js';
import { type Ledger, type LedgerEntry, ledgerKey, type Provenance } from './ledger.js';
import type { Component, LibraryInventory } from './library.js';
import type { Outcome } from './report.js';
import { composeRules, hashContent } from './shapes.js';

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

export interface SyncCapture {
  /** Detection probe results per app id. */
  installed: Record<string, boolean>;
  /** Current bytes per absolute target path (null when unreadable). */
  targets: Record<string, CapturedTarget>;
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

function selectedRules(config: ResolvedConfig, inventory: LibraryInventory) {
  const byId = new Map(
    inventory.components
      .filter((component) => component.type === 'rules')
      .map((component) => [component.id, component])
  );
  const present: Component[] = [];
  const missing: string[] = [];
  for (const id of config.selection.rules) {
    const component = byId.get(id);
    if (component) present.push(component);
    else missing.push(id);
  }
  return { present, missing };
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

  const { present, missing } = selectedRules(config, inventory);
  for (const id of missing) {
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

  const composed = composeRules(present, {
    includeDelimiters: config.rules.includeDelimiters,
  });

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

    // A missing member blocks the whole aggregate slice: rendering without it
    // would silently drop content the user selected.
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

    const desired = composed.content.length > 0 ? row.rules.render(composed.content) : '';
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
  const { present, missing } = selectedRules(config, inventory);
  const composed = composeRules(present, {
    includeDelimiters: config.rules.includeDelimiters,
  });
  const components = present.map((component) => ({ id: component.id, path: component.path }));
  const componentMatch = present.some((component) => component.id === target);
  const ledgerByKey = new Map(ledger.entries.map((entry) => [ledgerKey(entry), entry]));

  const slices: ExplainSlice[] = [];
  for (const action of planRules(input)) {
    if (action.app === null) continue;
    const pathMatch =
      action.path !== null && (action.path === target || action.path.endsWith(`/${target}`));
    if (action.app !== target && !pathMatch && !componentMatch) continue;

    const row = table.find((candidate) => candidate.id === action.app);
    const desired =
      action.path !== null && row?.rules && missing.length === 0 && composed.content.length > 0
        ? row.rules.render(composed.content)
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
      components,
    };
    if (action.detail !== undefined) slice.detail = action.detail;
    slices.push(slice);
  }
  return slices;
}
