import fs from 'node:fs';
import { Command } from 'commander';
import { APP_ROWS } from './apps.js';
import { loadConfig } from './config.js';
import { acquireRunLock, type Ledger, ledgerKey, loadLedger, saveLedger } from './ledger.js';
import { scanLibrary } from './library.js';
import {
  type Action,
  type ExplainSlice,
  explainRules,
  planRules,
  type SyncCapture,
} from './plan.js';
import {
  buildReport,
  type Report,
  type ReportEntry,
  renderExplain,
  renderReport,
} from './report.js';
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

export async function runExplain(target: string, opts: SyncOptions = {}): Promise<ExplainSlice[]> {
  const env = opts.env ?? process.env;
  const config = loadConfig({ profile: opts.profile, project: opts.project, env });
  const ledger = loadLedger(config.homes.stateHome);
  const inventory = scanLibrary({ env });
  const capture = captureFor(config);

  let slices = explainRules(
    { config, inventory, ledger, capture, table: APP_ROWS, now: new Date().toISOString() },
    target
  );
  if (opts.apps && opts.apps.length > 0) {
    const wanted = new Set(opts.apps);
    slices = slices.filter((slice) => wanted.has(slice.app));
  }
  return slices;
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
  | { command: 'explain'; target: string; options: CliOptions };

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

    const report = await runSync({
      ...invocation.options,
      dryRun: invocation.command === 'status' ? true : invocation.options.dryRun,
    });
    process.stdout.write(
      invocation.options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report)
    );
    return report.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    const exitCode = (error as { exitCode?: number }).exitCode;
    return exitCode === 2 ? 2 : 1;
  }
}
