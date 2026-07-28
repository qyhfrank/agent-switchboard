import fs from 'node:fs';
import { APP_ROWS } from './apps.js';
import { loadConfig } from './config.js';
import { acquireRunLock, type Ledger, ledgerKey, loadLedger, saveLedger } from './ledger.js';
import { scanLibrary } from './library.js';
import { type Action, planRules, type SyncCapture } from './plan.js';
import { buildReport, type Report, type ReportEntry } from './report.js';
import { isContainedIn, removeFileResolved, resolveWritePath, writeFileAtomic } from './shapes.js';

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
  env?: NodeJS.ProcessEnv;
}

function captureFor(config: ReturnType<typeof loadConfig>): SyncCapture {
  const capture: SyncCapture = { installed: {}, targets: {} };
  for (const appId of config.apps.enabled) {
    const row = APP_ROWS.find((candidate) => candidate.id === appId);
    if (!row) continue;
    capture.installed[appId] = fs.existsSync(row.detectDir(config.homes));
    if (!row.rules) continue;
    const targetPath = row.rules.path(config.homes);
    try {
      capture.targets[targetPath] = {
        exists: true,
        content: fs.readFileSync(targetPath, 'utf-8'),
      };
    } catch {
      capture.targets[targetPath] = { exists: fs.existsSync(targetPath), content: null };
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

function executeAction(action: Action, ledger: Ledger): ReportEntry {
  if (action.op === 'write' || action.op === 'remove') {
    if (action.root && action.path) {
      const resolvedRoot = resolveWritePath(action.root);
      const resolvedTarget = resolveWritePath(action.path);
      if (!isContainedIn(resolvedRoot, resolvedTarget)) {
        return {
          app: action.app,
          type: action.type,
          id: action.id,
          path: action.path,
          outcome: 'blocked',
          detail: 'path-escape',
          reason: `resolved path ${resolvedTarget} escapes ${resolvedRoot}; not touching it`,
        };
      }
    }
    try {
      if (action.op === 'write') {
        writeFileAtomic(action.path as string, action.content ?? '');
      } else {
        removeFileResolved(action.path as string);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        app: action.app,
        type: action.type,
        id: action.id,
        path: action.path,
        outcome: 'failed',
        detail: 'write-error',
        reason: message,
      };
    }
  }

  applyLedgerMutation(ledger, action);
  return toEntry(action);
}

export async function runSync(opts: SyncOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun === true;

  const config = loadConfig({ profile: opts.profile, project: opts.project, env });
  const ledger = loadLedger(config.homes.stateHome);
  const inventory = scanLibrary({ env });
  const capture = captureFor(config);

  let actions = planRules({
    config,
    inventory,
    ledger,
    capture,
    table: APP_ROWS,
    now: new Date().toISOString(),
  });

  // Filters select which actions execute, never which inputs the planner saw.
  if (opts.apps && opts.apps.length > 0) {
    const wanted = new Set(opts.apps);
    actions = actions.filter((action) => action.app === null || wanted.has(action.app));
  }
  if (opts.types && opts.types.length > 0) {
    const wanted = new Set(opts.types);
    actions = actions.filter((action) => action.type === null || wanted.has(action.type));
  }

  const scope = {
    profile: config.profile,
    project: config.project,
    dryRun,
  };

  if (dryRun) {
    return buildReport(scope, actions.map(toEntry));
  }

  const lock = acquireRunLock(config.homes.stateHome);
  let ledgerDirty = false;
  const entries: ReportEntry[] = [];
  try {
    for (const action of actions) {
      const hadMutation = action.ledger !== undefined;
      const entry = executeAction(action, ledger);
      if (hadMutation && entry.outcome === action.outcome) ledgerDirty = true;
      entries.push(entry);
    }
  } finally {
    if (ledgerDirty) {
      try {
        saveLedger(config.homes.stateHome, ledger);
      } catch {
        // Failing to persist the ledger must not mask the run's own outcome;
        // the next run re-proves ownership from disk state.
      }
    }
    lock.release();
  }

  return buildReport(scope, entries);
}
