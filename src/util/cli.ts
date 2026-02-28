import os from 'node:os';
import chalk from 'chalk';

const HOME = os.homedir();

export function shortenPath(p: string): string {
  if (p.startsWith(HOME)) {
    return '~' + p.slice(HOME.length);
  }
  return p;
}

export type Cell = { plain: string; formatted: string };

export function printTable(header: string[], rows: Cell[][]): void {
  const widths = header.map((col, i) =>
    Math.max(col.length, ...rows.map((r) => r[i].plain.length))
  );
  const formatRow = (cells: Cell[]) =>
    cells
      .map(
        (cell, i) => `${cell.formatted}${' '.repeat(Math.max(0, widths[i] - cell.plain.length))}`
      )
      .join('  ');
  console.log(formatRow(header.map((h) => ({ plain: h, formatted: chalk.bold(h) }))));
  rows.forEach((r) => {
    console.log(formatRow(r));
  });
}

export type DistributionStatus = 'written' | 'skipped' | 'error' | 'deleted';

export interface DistributionResultLike {
  status: DistributionStatus;
  reason?: string;
  error?: string;
}

export function printDistributionResults<T extends DistributionResultLike>({
  title,
  results,
  getTargetLabel,
  getPath,
  emptyMessage,
}: {
  title: string;
  results: T[];
  getTargetLabel: (result: T) => string;
  getPath: (result: T) => string;
  emptyMessage?: string;
}): void {
  console.log(chalk.blue(`${title}:`));
  if (results.length === 0) {
    if (emptyMessage) {
      console.log(`  ${chalk.gray(emptyMessage)}`);
    }
    return;
  }

  let written = 0;
  let skipped = 0;
  let deleted = 0;
  let errors = 0;

  for (const result of results) {
    switch (result.status) {
      case 'written':
        written++;
        break;
      case 'skipped':
        skipped++;
        break;
      case 'deleted':
        deleted++;
        break;
      case 'error':
        errors++;
        break;
    }
  }

  for (const result of results) {
    if (result.status === 'skipped') continue;

    const pathLabel = chalk.dim(shortenPath(getPath(result)));
    const targetLabel = chalk.cyan(getTargetLabel(result));

    if (result.status === 'written') {
      const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
      console.log(`  ${chalk.green('✓')} ${targetLabel} ${pathLabel}${reason}`);
    } else if (result.status === 'deleted') {
      const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
      console.log(`  ${chalk.yellow('−')} ${targetLabel} ${pathLabel}${reason}`);
    } else {
      const errorLabel = result.error ? ` ${chalk.red(result.error)}` : '';
      console.log(`  ${chalk.red('✗')} ${targetLabel} ${pathLabel}${errorLabel}`);
    }
  }

  if (skipped > 0) {
    console.log(`  ${chalk.gray(`${skipped} up-to-date`)}`);
  }
}

export function printActiveSelection(label: string, ids: string[]): void {
  console.log(chalk.green(`✓ Updated active ${label}:`));
  if (ids.length === 0) {
    console.log(`  ${chalk.gray('none')}`);
    return;
  }
  for (const id of ids) {
    console.log(`  ${chalk.cyan(id)}`);
  }
}

export function formatSyncTimestamp(value: string | undefined): string {
  if (!value) return 'no sync recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function printAgentSyncStatus(options: {
  agentSync: Record<string, { updatedAt?: string } | undefined>;
  agents?: readonly string[];
  title?: string;
  emptyMessage?: string;
}): void {
  const title = options.title ?? 'Agent sync status';
  const emptyMessage = options.emptyMessage ?? 'no sync recorded';
  const agents = options.agents ?? Object.keys(options.agentSync);
  console.log(chalk.blue(`${title}:`));
  if (agents.length === 0) {
    console.log(`  ${chalk.gray(emptyMessage)}`);
    return;
  }
  for (const agent of agents) {
    const sync = options.agentSync[agent];
    const formatted = formatSyncTimestamp(sync?.updatedAt);
    const display = sync?.updatedAt ? formatted : chalk.gray(formatted);
    console.log(`  ${chalk.cyan(agent)} ${chalk.gray('-')} ${display}`);
  }
}
