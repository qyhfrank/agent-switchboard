import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliArgs } from '../../src/engine/cli.js';
import { buildReport, type ReportEntry, renderReport } from '../../src/engine/report.js';

// G11: any flag ordering yields identical behavior. Each class lists argv
// permutations of one logical invocation; all must parse identically.
const EQUIVALENCE_CLASSES: string[][][] = [
  [
    ['sync', '--app', 'cursor', '-n'],
    ['-n', 'sync', '--app', 'cursor'],
    ['sync', '-n', '--app', 'cursor'],
    ['--app', 'cursor', '-n', 'sync'],
  ],
  [
    ['sync', '--app', 'cursor', '--app', 'codex', '--type', 'rules'],
    ['--app', 'cursor', 'sync', '--app', 'codex', '--type', 'rules'],
    ['--app', 'cursor', '--type', 'rules', 'sync', '--app', 'codex'],
  ],
  [
    ['status', '-p', 'work', '--json'],
    ['-p', 'work', 'status', '--json'],
    ['--json', 'status', '-p', 'work'],
  ],
  [
    ['sync', '--no-update'],
    ['--no-update', 'sync'],
  ],
  [
    ['sync', '--update', '--source', 'main', '-P', '/tmp/repo'],
    ['--update', '-P', '/tmp/repo', 'sync', '--source', 'main'],
  ],
  [
    ['explain', 'base', '--app', 'codex'],
    ['--app', 'codex', 'explain', 'base'],
    ['explain', '--app', 'codex', 'base'],
  ],
];

test('flag position never changes the parsed invocation', () => {
  for (const equivalenceClass of EQUIVALENCE_CLASSES) {
    const canonical = parseCliArgs(equivalenceClass[0]);
    for (const argv of equivalenceClass.slice(1)) {
      assert.deepEqual(parseCliArgs(argv), canonical, `asb ${argv.join(' ')}`);
    }
  }
});

test('parsed fields carry the frozen semantics', () => {
  const full = parseCliArgs([
    'sync',
    '--app',
    'cursor',
    '--app',
    'codex',
    '--type',
    'rules',
    '-n',
    '-p',
    'work',
    '--json',
  ]);
  assert.equal(full.command, 'sync');
  assert.deepEqual(full.options.apps, ['cursor', 'codex']);
  assert.deepEqual(full.options.types, ['rules']);
  assert.equal(full.options.dryRun, true);
  assert.equal(full.options.profile, 'work');
  assert.equal(full.options.json, true);

  const bare = parseCliArgs(['sync']);
  assert.deepEqual(
    { update: bare.options.update, noUpdate: bare.options.noUpdate },
    { update: false, noUpdate: false }
  );
  assert.equal(parseCliArgs(['sync', '--update']).options.update, true);
  const suppressed = parseCliArgs(['sync', '--no-update']);
  assert.deepEqual(
    { update: suppressed.options.update, noUpdate: suppressed.options.noUpdate },
    { update: false, noUpdate: true }
  );
});

test('explain carries its target through parsing', () => {
  const invocation = parseCliArgs(['explain', 'base']);
  assert.equal(invocation.command, 'explain');
  if (invocation.command === 'explain') assert.equal(invocation.target, 'base');
});

test('unknown flags and incomplete commands reject while bare invocation selects summary', () => {
  assert.throws(() => parseCliArgs(['sync', '--bogus']));
  assert.throws(() => parseCliArgs(['explode']));
  assert.throws(() => parseCliArgs(['explain']));
  assert.equal(parseCliArgs([]).command, 'summary');
});

const SCOPE = { profile: null, project: null, dryRun: false };

test('empty plan renders the quick start, never a bare success mark', () => {
  const text = renderReport(buildReport(SCOPE, []));
  assert.match(text, /nothing to do/i);
  assert.match(text, /quick start/i);
  assert.match(text, /asb add/);
  assert.match(text, /asb enable/);
  assert.match(text, /asb sync/);
  assert.ok(!text.includes('✓'));
});

test('non-clean entries render with outcome, detail, and reason', () => {
  const entries: ReportEntry[] = [
    {
      app: 'cursor',
      type: null,
      id: null,
      path: null,
      outcome: 'skipped',
      detail: 'app-not-installed',
      reason: 'not found; add "cursor" to [applications].assume_installed to sync anyway',
    },
    { app: 'codex', type: 'rules', id: null, path: '/x/AGENTS.md', outcome: 'unchanged' },
    { app: 'gemini', type: 'rules', id: null, path: '/x/g/AGENTS.md', outcome: 'unchanged' },
  ];
  const text = renderReport(buildReport(SCOPE, entries));
  assert.match(text, /skipped \(app-not-installed\)/);
  assert.match(text, /assume_installed/);
  assert.match(text, /unchanged: 2/);
  assert.ok(!text.includes('codex:'), 'unchanged entries collapse into the count');
});

test('dry-run scope prefixes every action line', () => {
  const entries: ReportEntry[] = [
    {
      app: 'cursor',
      type: 'rules',
      id: null,
      path: '/x/.cursor/rules/rules.mdc',
      outcome: 'written',
      detail: 'created',
    },
  ];
  const text = renderReport(buildReport({ ...SCOPE, dryRun: true }, entries));
  assert.match(text, /\[dry-run\] written \(created\)/);
});
