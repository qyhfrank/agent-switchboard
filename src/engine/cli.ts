import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { AGENTS_SKILLS_UNION, APP_ROWS } from './apps.js';
import { effectiveSelection, loadConfig } from './config.js';
import {
  acquireRunLock,
  type Ledger,
  ledgerKey,
  ledgerPath,
  loadLedger,
  type RunLock,
  saveLedger,
} from './ledger.js';
import { scanLibrary } from './library.js';
import {
  type Action,
  type ExplainSlice,
  explainRules,
  explainSkills,
  planRules,
  planSkills,
  type SyncCapture,
} from './plan.js';
import {
  buildReport,
  type Report,
  type ReportEntry,
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

function captureFor(config: ReturnType<typeof loadConfig>, ledger: Ledger): SyncCapture {
  const capture: SyncCapture = { installed: {}, targets: {}, bundles: {}, bundleDirs: {} };
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
  if (AGENTS_SKILLS_UNION.members.some((member) => config.apps.enabled.includes(member))) {
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
          removeBundleSlice(action.path, action.bundle.stale);
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
        removeManagedFile(action.path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure('failed', 'write-error', message);
    }
  }

  applyLedgerMutation(ledger, action);
  return toEntry(action);
}

export async function runSync(opts: SyncOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun === true;

  const config = loadConfig({ profile: opts.profile, project: opts.project, env });

  // A real run takes the lock before ledger and capture: the whole
  // capture → plan → apply sequence executes against serialized state, so a
  // plan built from another run's pre-apply snapshot can never fire.
  const lock: RunLock | null = dryRun ? null : acquireRunLock(config.homes.stateHome);
  try {
    const ledger = loadLedger(config.homes.stateHome);
    const inventory = scanLibrary({ env });
    const capture = captureFor(config, ledger);

    const planInput = {
      config,
      inventory,
      ledger,
      capture,
      table: APP_ROWS,
      now: new Date().toISOString(),
    };
    let actions = [...planRules(planInput), ...planSkills(planInput)];

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

    let ledgerDirty = false;
    const entries: ReportEntry[] = [];
    for (const action of actions) {
      const hadMutation = action.ledger !== undefined;
      const entry = executeAction(action, ledger);
      if (hadMutation && entry.outcome === action.outcome) ledgerDirty = true;
      entries.push(entry);
    }

    if (ledgerDirty) {
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
    }

    return buildReport(scope, entries);
  } finally {
    lock?.release();
  }
}

export async function runExplain(target: string, opts: SyncOptions = {}): Promise<ExplainSlice[]> {
  const env = opts.env ?? process.env;
  const config = loadConfig({ profile: opts.profile, project: opts.project, env });
  const ledger = loadLedger(config.homes.stateHome);
  const inventory = scanLibrary({ env });
  const capture = captureFor(config, ledger);

  const planInput = {
    config,
    inventory,
    ledger,
    capture,
    table: APP_ROWS,
    now: new Date().toISOString(),
  };
  let slices = [...explainRules(planInput, target), ...explainSkills(planInput, target)];
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
