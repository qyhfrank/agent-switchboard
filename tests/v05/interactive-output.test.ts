import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ExplainSlice } from '../../src/engine/plan.js';
import {
  buildReport,
  type ReportEntry,
  type ReportScope,
  renderCompactStatus,
  renderExplain,
  renderReport,
} from '../../src/engine/report.js';

// Every expected string here is the ratified sample from
// `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md`: the fenced
// mockups are the spec, the fixtures are the shapes the engine really emits
// (`sourceRow` for a missing source, `toEntry` for a dry-run preview).

type Command = 'sync' | 'status' | 'add' | 'remove' | 'summary';
interface RenderOpts {
  layout: 'interactive' | 'plain';
  color: boolean;
  command?: Command;
}

const ui = (command: Command, color = false): RenderOpts => ({
  layout: 'interactive',
  color,
  command,
});
const uiBare = (color = false): RenderOpts => ({ layout: 'interactive', color });

// Built from a code point so the linter's control-character rule stays out of it.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (text: string): string => text.replace(ANSI, '');
const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

const HOME = os.homedir();
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const RL_HARNESS = path.join(HOME, 'Documents', 'Projects', 'rl-harness');
const REMOVED_IDS = ['feishu-cli:feishu-cli-docs', 'lark-cli:lark-doc', 'lark-cli:lark-shared'];
const REMOVED_LINE = REMOVED_IDS.join(' · ');
const APPS = ['claude-code', 'cursor', 'agents'];

const PROFILE_SCOPE: ReportScope = { profile: 'aws', project: null, dryRun: false };
const PREVIEW_SCOPE: ReportScope = { profile: 'aws', project: null, dryRun: true };

const UPDATED_CLAUDE: ReportEntry = {
  app: 'claude-code',
  type: 'rules',
  id: null,
  path: CLAUDE_MD,
  outcome: 'written',
  detail: 'updated',
  scope: 'user',
};

/** The shape `sourceRow` emits for an enabled source whose content is absent. */
const MISSING_SOURCE: ReportEntry = {
  app: null,
  type: null,
  id: 'rl-harness',
  path: RL_HARNESS,
  outcome: 'missing',
  reason: `enabled but its source content is not there; expected ${RL_HARNESS}`,
  scope: 'user',
};

const removedRows = (app: string): ReportEntry[] =>
  REMOVED_IDS.map((id) => ({
    app,
    type: 'plugins',
    id,
    path: path.join(HOME, '.claude', 'plugins', id),
    outcome: 'removed' as const,
    scope: 'user' as const,
  }));

const unchangedRows = (count: number, apps: readonly string[]): ReportEntry[] =>
  Array.from({ length: count }, (_unused, index) => ({
    app: apps[index % apps.length] as string,
    type: 'rules',
    id: `component-${index}`,
    path: path.join(HOME, '.asb', 'rules', `component-${index}.md`),
    outcome: 'unchanged' as const,
    scope: 'user' as const,
  }));

const BUSY_SYNC = buildReport(PROFILE_SCOPE, [
  UPDATED_CLAUDE,
  ...removedRows('claude-code'),
  ...removedRows('cursor'),
  ...removedRows('agents'),
  MISSING_SOURCE,
  ...unchangedRows(110, APPS),
]);

const CLEAN = buildReport(PROFILE_SCOPE, unchangedRows(120, [...APPS, 'codex', 'gemini']));

const PREVIEW = (() => {
  const report = buildReport(PREVIEW_SCOPE, [
    UPDATED_CLAUDE,
    MISSING_SOURCE,
    ...unchangedRows(110, APPS),
  ]);
  report.lastRun = { at: '2026-08-03T17:50:41.912Z', summary: '1 written' };
  return report;
})();

const EMPTY = buildReport(PROFILE_SCOPE, []);

test('a busy sync renders the app groups, the reason, the tally, and the verdict', () => {
  const expected = [
    'asb sync · profile aws',
    '',
    'claude-code',
    '  ✓ updated  ~/.claude/CLAUDE.md',
    `  − removed  ${REMOVED_LINE}`,
    'cursor',
    `  − removed  ${REMOVED_LINE}`,
    'agents',
    `  − removed  ${REMOVED_LINE}`,
    '',
    'needs attention',
    '  ✗ rl-harness  library source missing',
    '    enabled but its source content is not there; expected ~/Documents/Projects/rl-harness',
    '',
    '1 updated · 9 removed · 110 in sync',
    '✗ finished with 1 problem',
    '',
  ].join('\n');

  assert.equal(renderReport(BUSY_SYNC, ui('sync')), expected);
});

test('omitting the options keeps the 0.5.1 text byte for byte', () => {
  const expected = [
    'claude-code:',
    `  written (updated): ${CLAUDE_MD}`,
    `  removed: ${REMOVED_IDS.join(', ')}`,
    'cursor:',
    `  removed: ${REMOVED_IDS.join(', ')}`,
    'agents:',
    `  removed: ${REMOVED_IDS.join(', ')}`,
    'library:',
    `  missing: rl-harness — ${MISSING_SOURCE.reason}`,
    'unchanged: 110',
    '1 written, 9 removed, 1 missing, 110 unchanged',
    '',
  ].join('\n');

  assert.equal(renderReport(BUSY_SYNC), expected);
  assert.equal(renderReport(BUSY_SYNC, { layout: 'plain', color: false }), expected);
});

test('a run with nothing to do ends on one line', () => {
  assert.equal(
    renderReport(CLEAN, ui('sync')),
    '✓ asb sync · profile aws · 120 components in sync across 5 apps\n'
  );
  assert.equal(
    renderReport(CLEAN, ui('status')),
    '✓ asb status · profile aws · 120 components in sync across 5 apps\n'
  );

  const unscoped = buildReport(
    { profile: null, project: null, dryRun: false },
    unchangedRows(120, [...APPS, 'codex', 'gemini'])
  );
  assert.equal(
    renderReport(unscoped, ui('sync')),
    '✓ asb sync · 120 components in sync across 5 apps\n'
  );
});

test('status previews in future tense and points at the command that applies it', () => {
  const expected = [
    'asb status · profile aws · last sync 2026-08-03 17:50',
    '',
    'pending',
    '  → claude-code · CLAUDE.md will be updated',
    'needs attention',
    '  ✗ rl-harness · library source missing',
    '',
    '110 in sync · 1 pending · 1 problem',
    '→ asb sync applies 1 change',
    '',
  ].join('\n');

  assert.equal(renderReport(PREVIEW, ui('status')), expected);
});

test('last sync belongs to machine-global scope only', () => {
  const scoped = buildReport({ ...PREVIEW_SCOPE, project: '/w/app' }, PREVIEW.entries);
  scoped.lastRun = PREVIEW.lastRun;
  assert.ok(!renderReport(scoped, ui('status')).includes('last sync'));

  const noRun = buildReport(PREVIEW_SCOPE, PREVIEW.entries);
  assert.ok(!renderReport(noRun, ui('status')).includes('last sync'));
});

test('the dry-run banner belongs to sync alone and replaces the row prefix', () => {
  const banner = 'dry run · nothing will be written';
  const preview = renderReport(PREVIEW, ui('sync'));

  assert.ok(preview.startsWith(`${banner}\n`), preview.slice(0, 80));
  assert.ok(!preview.includes('[dry-run]'));

  const status = renderReport(PREVIEW, ui('status'));
  assert.ok(!status.includes(banner));
  assert.ok(!status.includes('[dry-run]'));
});

test('the summary stays one line with one next action', () => {
  assert.equal(renderCompactStatus(BUSY_SYNC, ui('summary')), '✗ 1 needs attention → asb status\n');
  assert.equal(renderCompactStatus(CLEAN, ui('summary')), '✓ 120 current\n');
});

const DESIRED_BODY = ['# base style', '', '  keep the indent', 'tabs\tkept', ''].join('\n');
const DELIMITER = '--- desired content (claude-code) ---';

const CARD: ExplainSlice = {
  app: 'claude-code',
  path: CLAUDE_MD,
  outcome: 'unchanged',
  provenance: 'identity',
  currentHash: '3f9c2a11d0e4b7c58e19',
  desiredHash: '3f9c2a11d0e4b7c58e19',
  desired: DESIRED_BODY,
  components: [
    { id: 'base-style', path: path.join(HOME, '.asb', 'rules', 'base-style.md') },
    { id: 'git-policy', path: path.join(HOME, '.asb', 'rules', 'git-policy.md') },
  ],
  sources: [
    {
      id: 'lark-cli:lark-doc',
      source: 'lark-cli',
      path: path.join(HOME, '.asb', 'plugins', 'lark-cli'),
    },
  ],
};

test('explain renders a key-value card above the untouched desired content', () => {
  const expected = [
    'claude-code · ~/.claude/CLAUDE.md',
    '  outcome   · unchanged',
    '  owner     identity',
    '  current   3f9c2a11d0e4',
    '  desired   3f9c2a11d0e4',
    '  components',
    '    base-style   ~/.asb/rules/base-style.md',
    '    git-policy   ~/.asb/rules/git-policy.md',
    '  source    lark-cli:lark-doc <- lark-cli (~/.asb/plugins/lark-cli)',
    '',
    DELIMITER,
    DESIRED_BODY.trimEnd(),
    '',
  ].join('\n');

  assert.equal(renderExplain([CARD], 'CLAUDE.md', uiBare()), expected);
});

test('explain keeps every field and never styles the desired content', () => {
  const slice: ExplainSlice = {
    ...CARD,
    outcome: 'blocked',
    detail: 'unproven-target',
    reason: 'the target exists and nothing proves it is asb writing it',
  };
  const text = renderExplain([slice], 'CLAUDE.md', uiBare());
  for (const token of [
    'blocked',
    'unproven-target',
    slice.reason as string,
    'identity',
    '3f9c2a11d0e4',
    'base-style',
    '~/.asb/rules/base-style.md',
    'lark-cli:lark-doc',
    '~/.asb/plugins/lark-cli',
  ]) {
    assert.ok(text.includes(token), token);
  }

  const colored = renderExplain([CARD], 'CLAUDE.md', uiBare(true));
  const tail = colored.slice(colored.indexOf(DELIMITER) + DELIMITER.length);
  assert.equal(tail.slice(tail.indexOf('\n') + 1), `${DESIRED_BODY.trimEnd()}\n`);
});

test('an empty library gets three starting commands, not an error', () => {
  const expected = [
    'asb · nothing selected yet',
    '',
    '  asb add <git-url|path>   add a source',
    '  asb enable               pick components',
    '  asb sync                 write app configs',
    '',
  ].join('\n');

  assert.equal(renderReport(EMPTY, ui('sync')), expected);

  const colored = renderReport(EMPTY, ui('sync', true));
  assert.equal(strip(colored), expected);
  assert.equal((colored.match(new RegExp(`${ESC}\\[36m`, 'g')) ?? []).length, 3);
});

const PARITY: { name: string; render: (color: boolean) => string }[] = [
  { name: 'busy sync', render: (color) => renderReport(BUSY_SYNC, ui('sync', color)) },
  { name: 'clean run', render: (color) => renderReport(CLEAN, ui('sync', color)) },
  { name: 'status preview', render: (color) => renderReport(PREVIEW, ui('status', color)) },
  { name: 'dry-run sync', render: (color) => renderReport(PREVIEW, ui('sync', color)) },
  { name: 'empty library', render: (color) => renderReport(EMPTY, ui('sync', color)) },
  {
    name: 'summary failing',
    render: (color) => renderCompactStatus(BUSY_SYNC, ui('summary', color)),
  },
  { name: 'summary clean', render: (color) => renderCompactStatus(CLEAN, ui('summary', color)) },
  { name: 'explain card', render: (color) => renderExplain([CARD], 'CLAUDE.md', uiBare(color)) },
];

test('color adds nothing but color', () => {
  for (const { name, render } of PARITY) {
    const plain = render(false);
    const colored = render(true);
    assert.notEqual(colored, plain, `${name} never emitted an escape`);
    assert.equal(strip(colored), plain, name);
  }
});

const LEFT_BEHIND: ReportEntry = {
  app: 'cursor',
  type: 'rules',
  id: 'legacy-rule',
  path: path.join(HOME, '.cursor', 'rules', 'legacy-rule.mdc'),
  outcome: 'left-behind',
  reason: 'nothing proves asb wrote it, so it stays where it is',
  scope: 'user',
};

const failingRow = (outcome: 'blocked' | 'conflict'): ReportEntry => ({
  app: 'codex',
  type: 'rules',
  id: 'base-style',
  path: path.join(HOME, '.codex', 'AGENTS.md'),
  outcome,
  reason: 'the target holds content asb did not write',
  scope: 'user',
});

test('glyphs carry severity on their own and the verdict follows the exit code', () => {
  const warned = renderReport(
    buildReport(PROFILE_SCOPE, [LEFT_BEHIND, ...unchangedRows(4, APPS)]),
    ui('sync')
  );
  assert.ok(warned.includes('⚠'), warned);
  assert.ok(!warned.includes('✗'), warned);
  assert.ok(warned.includes('needs attention'), warned);
  assert.equal(lastLine(warned), '✓ finished with 1 warning');

  for (const outcome of ['blocked', 'conflict'] as const) {
    const report = buildReport(PROFILE_SCOPE, [failingRow(outcome), ...unchangedRows(4, APPS)]);
    const text = renderReport(report, ui('sync'));
    assert.equal(report.exitCode, 1, outcome);
    assert.ok(text.includes('✗'), outcome);
    assert.ok(!text.includes('⚠'), outcome);
    assert.ok(text.includes('needs attention'), outcome);
    assert.equal(lastLine(text), '✗ finished with 1 problem', outcome);
  }

  const aborted = buildReport(PROFILE_SCOPE, [failingRow('blocked')], { aborted: true });
  assert.equal(lastLine(renderReport(aborted, ui('sync'))), '✗ aborted before writing');
});

test('the summary line carries the severity of the worst thing in it', () => {
  const warned = buildReport(PROFILE_SCOPE, [LEFT_BEHIND, ...unchangedRows(4, APPS)]);
  assert.equal(warned.exitCode, 0);
  assert.equal(renderCompactStatus(warned, ui('summary')), '⚠ 1 needs attention → asb status\n');

  const colored = renderCompactStatus(warned, ui('summary', true));
  assert.ok(colored.includes(`${ESC}[33m`), colored);
  assert.ok(!colored.includes(`${ESC}[31m`), colored);
});

/** What `planCatalogStatus` emits: catalog rows belong to no app. */
const CATALOG_ROWS: ReportEntry[] = [
  {
    app: null,
    type: 'plugins',
    id: 'lark-cli',
    path: null,
    outcome: 'unchanged',
    scope: 'user',
  },
  {
    app: null,
    type: 'plugins',
    id: 'feishu-cli',
    path: null,
    outcome: 'skipped',
    detail: 'unselected',
    scope: 'user',
  },
  {
    app: null,
    type: 'plugins',
    id: 'rl-harness',
    path: null,
    outcome: 'skipped',
    detail: 'unselected',
    scope: 'user',
  },
];

test('a quiet report that is not app components in sync keeps its counts', () => {
  const catalog = buildReport(PROFILE_SCOPE, CATALOG_ROWS);
  const quiet = (command: 'sync' | 'status'): string =>
    [`asb ${command} · profile aws`, '', '1 in sync · 2 skipped', '✓ finished', ''].join('\n');

  assert.equal(renderReport(catalog, ui('status')), quiet('status'));
  assert.equal(renderReport(catalog, ui('sync')), quiet('sync'));

  // An app probe that was skipped is not an app anything is in sync across.
  const probed = buildReport(PROFILE_SCOPE, [
    ...unchangedRows(4, APPS),
    {
      app: 'codex',
      type: null,
      id: null,
      path: null,
      outcome: 'skipped',
      detail: 'app-not-installed',
      scope: 'user',
    },
  ]);
  assert.equal(
    renderReport(probed, ui('status')),
    ['asb status · profile aws', '', '4 in sync · 1 skipped', '✓ finished', ''].join('\n')
  );
});

test('a status with nothing pending leaves its own count to the verdict line', () => {
  const failed = buildReport(PROFILE_SCOPE, [failingRow('blocked'), ...unchangedRows(4, APPS)]);
  assert.equal(
    renderReport(failed, ui('status')),
    [
      'asb status · profile aws',
      '',
      'needs attention',
      '  ✗ base-style · codex rules blocked',
      '',
      '4 in sync',
      '✗ finished with 1 problem',
      '',
    ].join('\n')
  );

  const warned = buildReport(PROFILE_SCOPE, [LEFT_BEHIND, ...unchangedRows(4, APPS)]);
  assert.equal(
    renderReport(warned, ui('status')),
    [
      'asb status · profile aws',
      '',
      'needs attention',
      '  ⚠ legacy-rule · cursor rules left-behind',
      '',
      '4 in sync',
      '✓ finished with 1 warning',
      '',
    ].join('\n')
  );
});

test('a clean status still says when it last synced', () => {
  const clean = buildReport(PROFILE_SCOPE, unchangedRows(110, APPS));
  clean.lastRun = { at: '2026-08-03T17:50:41.912Z', summary: '1 written' };

  assert.equal(
    renderReport(clean, ui('status')),
    '✓ asb status · profile aws · last sync 2026-08-03 17:50 · 110 components in sync across 3 apps\n'
  );
  // A sync reports what it just did; the stamp belongs to the status title.
  assert.equal(
    renderReport(clean, ui('sync')),
    '✓ asb sync · profile aws · 110 components in sync across 3 apps\n'
  );

  const scoped = buildReport({ ...PROFILE_SCOPE, project: '/w/app' }, clean.entries);
  scoped.lastRun = clean.lastRun;
  assert.ok(!renderReport(scoped, ui('status')).includes('last sync'), 'project scope');
});

test('one error in two component types stays two rows', () => {
  const custom = path.join(HOME, '.claude', 'plugins', 'lark-cli', 'custom');
  const unreadable = (type: string): ReportEntry => ({
    app: 'claude-code',
    type,
    id: 'lark-cli:custom',
    path: custom,
    outcome: 'failed',
    reason: `cannot read ${custom}`,
    scope: 'user',
  });

  const report = buildReport(PROFILE_SCOPE, [
    unreadable('commands'),
    unreadable('agents'),
    ...unchangedRows(4, APPS),
  ]);
  assert.equal(
    renderReport(report, ui('sync')),
    [
      'asb sync · profile aws',
      '',
      'needs attention',
      '  ✗ lark-cli:custom  claude-code commands failed',
      '    cannot read ~/.claude/plugins/lark-cli/custom',
      '  ✗ lark-cli:custom  claude-code agents failed',
      '    cannot read ~/.claude/plugins/lark-cli/custom',
      '',
      '4 in sync',
      '✗ finished with 2 problems',
      '',
    ].join('\n')
  );
});
