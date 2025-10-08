import chalk from 'chalk';

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
