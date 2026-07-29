import type { ExplainSlice } from './plan.js';

/**
 * Outcome vocabulary and report assembly. The closed per-entry vocabulary is
 * identical in human and JSON output; exit codes derive from it and nothing
 * else. Reason strings pass through the credential redactor before they can
 * reach any output.
 */

export type Outcome =
  | 'written'
  | 'unchanged'
  | 'adopted'
  | 'removed'
  | 'skipped'
  | 'missing'
  | 'blocked'
  | 'left-behind'
  | 'conflict'
  | 'pending'
  | 'failed';

export interface ReportEntry {
  app: string | null;
  type: string | null;
  id: string | null;
  path: string | null;
  outcome: Outcome;
  detail?: string;
  reason?: string;
}

export interface ReportScope {
  profile: string | null;
  project: string | null;
  dryRun: boolean;
}

export interface Report {
  version: 1;
  scope: ReportScope;
  entries: ReportEntry[];
  summary: Partial<Record<Outcome, number>>;
  exitCode: 0 | 1 | 2;
  /** Recorded fact from the most recent completed real run. */
  lastRun?: { at: string; summary: string };
}

/** Outcomes that mean the slice did not reach its declared state. */
export const FAILING_OUTCOMES: ReadonlySet<Outcome> = new Set([
  'failed',
  'blocked',
  'left-behind',
  'conflict',
  'missing',
]);

/**
 * Strip credentials from URL-shaped text. A secret travels in three spellings:
 * `//user:token@host`, a bare `//token@host`, and a query or fragment
 * parameter — the last is what `credentialFreeGitUrl` drops wholesale, and
 * nothing downstream of a location needs it to stay readable.
 */
export function redactCredentials(text: string): string {
  return (
    text
      .replace(/(\/\/[^/@\s:]+):([^@\s/]+)@/g, '$1:***@')
      // Any remaining lone userinfo is a bare token (ghp_..., oauth token URLs).
      .replace(/(\/\/)([^@\s/:]+)@/g, '$1***@')
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s'"]*?)[?#][^\s'"]*/gi, '$1')
  );
}

const QUICK_START = [
  'Quick start:',
  '  asb add <git-url|path>   add a plugin source',
  '  asb enable               pick what to activate',
  '  asb sync                 reconcile every installed app',
].join('\n');

/**
 * Human rendering: one line per non-clean entry grouped by app, `unchanged`
 * as a count, a final tally. An empty plan says there is nothing to do and
 * points at the quick start — never a bare success checkmark.
 */
export function renderReport(report: Report): string {
  if (report.entries.length === 0) {
    return `Nothing to do — the library is empty or nothing is selected.\n\n${QUICK_START}\n`;
  }

  const lines: string[] = [];
  const prefix = report.scope.dryRun ? '[dry-run] ' : '';
  const unchangedCount = report.summary.unchanged ?? 0;

  const byApp = new Map<string, ReportEntry[]>();
  for (const entry of report.entries) {
    if (entry.outcome === 'unchanged') continue;
    const key = entry.app ?? 'library';
    const bucket = byApp.get(key);
    if (bucket) bucket.push(entry);
    else byApp.set(key, [entry]);
  }

  for (const [app, entries] of byApp) {
    lines.push(`${app}:`);
    for (const entry of entries) {
      const label = entry.detail ? `${entry.outcome} (${entry.detail})` : entry.outcome;
      const subject = entry.id ?? entry.path ?? entry.type ?? '';
      const reason = entry.reason ? ` — ${entry.reason}` : '';
      lines.push(`  ${prefix}${label}: ${subject}${reason}`);
    }
  }

  if (unchangedCount > 0) lines.push(`unchanged: ${unchangedCount}`);

  const tally = Object.entries(report.summary)
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(', ');
  lines.push(tally);
  if (report.lastRun) lines.push(`last run: ${report.lastRun.at} — ${report.lastRun.summary}`);

  return `${lines.join('\n')}\n`;
}

export function renderExplain(slices: readonly ExplainSlice[], target: string): string {
  if (slices.length === 0) {
    return `Nothing matches "${target}" — \`asb status\` shows every component, app, and target.\n`;
  }

  const lines: string[] = [];
  for (const slice of slices) {
    lines.push(`${slice.app ?? 'library'}: ${slice.path ?? '(no target file)'}`);
    lines.push(`  outcome: ${slice.detail ? `${slice.outcome} (${slice.detail})` : slice.outcome}`);
    if (slice.reason) lines.push(`  reason: ${slice.reason}`);
    // A peer-record proof names the slice, not its bytes, so there is no
    // recorded hash to print beside it.
    lines.push(
      `  owner: ${
        slice.provenance
          ? slice.recordedHash
            ? `${slice.provenance} (recorded ${slice.recordedHash.slice(0, 12)})`
            : slice.provenance
          : 'no ownership record'
      }`
    );
    lines.push(`  current: ${slice.currentHash?.slice(0, 12) ?? 'absent'}`);
    lines.push(`  desired: ${slice.desiredHash?.slice(0, 12) ?? 'empty'}`);
    if (slice.components.length > 0) {
      lines.push('  components:');
      for (const component of slice.components) {
        lines.push(`    ${component.id}  ${component.path}`);
      }
    }
    for (const source of slice.sources ?? []) {
      lines.push(`  source: ${source.id} <- ${source.source} (${source.path})`);
    }
  }

  const withContent = slices.find((slice) => slice.desired !== null);
  if (withContent?.desired) {
    lines.push('', `--- desired content (${withContent.app}) ---`, withContent.desired.trimEnd());
  }

  return `${lines.join('\n')}\n`;
}

export function buildReport(
  scope: ReportScope,
  entries: readonly ReportEntry[],
  /** A pre-write abort: the run stopped before distribution and exits 2. */
  opts: { aborted?: boolean } = {}
): Report {
  const summary: Partial<Record<Outcome, number>> = {};
  let failing = false;

  // A failed source carries its configured location, and a configured
  // location can carry a token, so `path` passes the redactor beside `reason`.
  const redacted = entries.map((entry) => {
    summary[entry.outcome] = (summary[entry.outcome] ?? 0) + 1;
    if (FAILING_OUTCOMES.has(entry.outcome)) failing = true;
    const clean = { ...entry };
    if (entry.reason) clean.reason = redactCredentials(entry.reason);
    if (entry.path) clean.path = redactCredentials(entry.path);
    return clean;
  });

  return {
    version: 1,
    scope,
    entries: redacted,
    summary,
    exitCode: opts.aborted ? 2 : failing ? 1 : 0,
  };
}
