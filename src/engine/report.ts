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
}

const FAILING_OUTCOMES: ReadonlySet<Outcome> = new Set([
  'failed',
  'blocked',
  'left-behind',
  'conflict',
  'missing',
]);

/** Strip credentials from URL-shaped text (https://user:token@host, token@host). */
export function redactCredentials(text: string): string {
  return text
    .replace(/(\/\/[^/@\s:]+):([^@\s/]+)@/g, '$1:***@')
    .replace(/(\/\/)(gh[pousr]_[A-Za-z0-9]+|x-access-token:[^@\s/]+)@/g, '$1***@');
}

export function buildReport(scope: ReportScope, entries: readonly ReportEntry[]): Report {
  const summary: Partial<Record<Outcome, number>> = {};
  let failing = false;

  const redacted = entries.map((entry) => {
    summary[entry.outcome] = (summary[entry.outcome] ?? 0) + 1;
    if (FAILING_OUTCOMES.has(entry.outcome)) failing = true;
    return entry.reason ? { ...entry, reason: redactCredentials(entry.reason) } : entry;
  });

  return {
    version: 1,
    scope,
    entries: redacted,
    summary,
    exitCode: failing ? 1 : 0,
  };
}
