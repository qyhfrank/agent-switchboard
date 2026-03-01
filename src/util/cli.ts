import os from 'node:os';
import chalk from 'chalk';

const HOME = os.homedir();

export function shortenPath(p: string): string {
  if (p.startsWith(HOME)) {
    return `~${p.slice(HOME.length)}`;
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

export interface DistributionCounts {
  written: number;
  skipped: number;
  deleted: number;
  errors: number;
  skippedByTarget: Map<string, number>;
}

export function countDistributionResults<T extends DistributionResultLike>(
  results: T[],
  getTargetLabel: (result: T) => string
): DistributionCounts {
  let written = 0;
  let skipped = 0;
  let deleted = 0;
  let errors = 0;
  const skippedByTarget = new Map<string, number>();

  for (const result of results) {
    const target = getTargetLabel(result);
    switch (result.status) {
      case 'written':
        written++;
        break;
      case 'skipped':
        skipped++;
        skippedByTarget.set(target, (skippedByTarget.get(target) ?? 0) + 1);
        break;
      case 'deleted':
        deleted++;
        break;
      case 'error':
        errors++;
        break;
    }
  }
  return { written, skipped, deleted, errors, skippedByTarget };
}

export function formatDistributionSummary(counts: DistributionCounts): string {
  const { written, skipped, deleted, errors, skippedByTarget } = counts;
  const parts: string[] = [];
  if (written > 0) parts.push(`${chalk.green(String(written))} written`);
  if (deleted > 0) parts.push(`${chalk.yellow(String(deleted))} deleted`);
  if (errors > 0) parts.push(`${chalk.red(String(errors))} error`);
  if (skipped > 0) {
    const entries = [...skippedByTarget.entries()].sort(([a], [b]) => a.localeCompare(b));
    const uniqueCounts = new Set(skippedByTarget.values());
    const showBreakdown = entries.length > 0 && uniqueCounts.size > 1;
    if (showBreakdown) {
      const breakdown = entries.map(([target, count]) => `${target}:${count}`).join(', ');
      parts.push(`${chalk.gray(String(skipped))} up-to-date${chalk.gray(` (${breakdown})`)}`);
    } else {
      parts.push(`${chalk.gray(String(skipped))} up-to-date`);
    }
  }
  return parts.join(chalk.gray(', '));
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

  const counts = countDistributionResults(results, getTargetLabel);

  for (const result of results) {
    if (result.status === 'skipped') continue;
    printResultLine(result, getTargetLabel, getPath, 2);
  }

  const summary = formatDistributionSummary(counts);
  if (summary) {
    console.log(`  ${chalk.gray('Summary:')} ${summary}`);
  }
}

function printResultLine<T extends DistributionResultLike>(
  result: T,
  getTargetLabel: (r: T) => string,
  getPath: (r: T) => string,
  indent: number
): void {
  const pad = ' '.repeat(indent);
  const pathLabel = chalk.dim(shortenPath(getPath(result)));
  const targetLabel = chalk.cyan(getTargetLabel(result));

  if (result.status === 'written') {
    const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
    console.log(`${pad}${chalk.green('✓')} ${targetLabel} ${pathLabel}${reason}`);
  } else if (result.status === 'deleted') {
    const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
    console.log(`${pad}${chalk.yellow('−')} ${targetLabel} ${pathLabel}${reason}`);
  } else if (result.status === 'error') {
    const errorLabel = result.error ? ` ${chalk.red(result.error)}` : '';
    console.log(`${pad}${chalk.red('✗')} ${targetLabel} ${pathLabel}${errorLabel}`);
  }
}

export interface CompactDistributionSection<T extends DistributionResultLike> {
  label: string;
  results: T[];
  getTargetLabel: (result: T) => string;
  getPath: (result: T) => string;
  emptyMessage?: string;
}

export function printCompactDistributions(
  sections: CompactDistributionSection<DistributionResultLike>[]
): { hasErrors: boolean } {
  console.log(chalk.blue('Distribution:'));
  const maxLabelLen = Math.max(...sections.map((s) => s.label.length));
  let hasErrors = false;

  for (const section of sections) {
    const label = section.label.padEnd(maxLabelLen);

    if (section.results.length === 0) {
      console.log(`  ${chalk.gray(`${label}:`)} ${chalk.gray(section.emptyMessage || 'none')}`);
      continue;
    }

    const counts = countDistributionResults(section.results, section.getTargetLabel);
    if (counts.errors > 0) hasErrors = true;
    const summary = formatDistributionSummary(counts);
    const hasChanges = counts.written > 0 || counts.deleted > 0 || counts.errors > 0;

    if (!hasChanges) {
      console.log(`  ${chalk.gray(`${label}:`)} ${summary}`);
    } else {
      console.log(`  ${label}: ${summary}`);
      for (const result of section.results) {
        if (result.status === 'skipped') continue;
        printResultLine(result, section.getTargetLabel, section.getPath, 4);
      }
    }
  }

  return { hasErrors };
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
