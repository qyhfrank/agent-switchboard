import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { parseCliArgs, resolvePickerOrder, runSelectionCommand } from '../src/engine/cli.js';
import { editSelection } from '../src/engine/config.js';
import {
  runMain,
  type ScratchHomes,
  seedMarketplace,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The argv surface and the selection commands that write through it. Parsing is
 * asserted on the invocation object, rejection on what the process returns, and
 * every edit on the bytes of the selection file: never on rendered wording.
 */

function configPath(homes: ScratchHomes, name = 'config.toml'): string {
  return path.join(homes.asbHome, name);
}

function readConfig(homes: ScratchHomes, name = 'config.toml'): string {
  return fs.readFileSync(configPath(homes, name), 'utf-8');
}

function selectionOf(homes: ScratchHomes, name = 'config.toml'): Record<string, unknown> {
  return parseToml(readConfig(homes, name)) as Record<string, unknown>;
}

/** A live run's lock, held by this very process so the holder is provably alive. */
function holdRunLock(homes: ScratchHomes): void {
  fs.mkdirSync(homes.stateHome, { recursive: true });
  fs.writeFileSync(path.join(homes.stateHome, 'run.lock'), `${process.pid} held\n`);
}

// Every entry is one logical invocation written several ways; all spellings
// must parse to the same thing, because a dropped filter is a wrong-scope run.
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
    ['status', 'build-*', '--all', '--type', 'commands'],
    ['--all', '--type', 'commands', 'status', 'build-*'],
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

  const status = parseCliArgs(['status', 'build-*', '--all', '--type', 'commands']);
  assert.equal(status.command, 'status');
  if (status.command !== 'status') return;
  assert.equal(status.options.idGlob, 'build-*');
  assert.equal(status.options.all, true);
  assert.deepEqual(status.options.types, ['commands']);
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

  // The update tri-state decides whether managed clones are refreshed, so an
  // absent --update and an explicit --no-update stay distinguishable.
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

  const explained = parseCliArgs(['explain', 'base']);
  assert.equal(explained.command, 'explain');
  if (explained.command === 'explain') assert.equal(explained.target, 'base');

  assert.deepEqual(parseCliArgs(['import', 'gemini', '--type', 'commands', '-r', '-f']), {
    command: 'import',
    app: 'gemini',
    path: undefined,
    options: { types: ['commands'], recursive: true, force: true, json: false },
  });
});

test('unknown, incomplete, and inapplicable invocations reject while a bare one selects summary', () => {
  assert.throws(() => parseCliArgs(['sync', '--bogus']));
  assert.throws(() => parseCliArgs(['explode']));
  assert.throws(() => parseCliArgs(['explain']));

  // A flag the command cannot honour is refused rather than ignored: silently
  // dropping it would run the opposite of what was asked.
  assert.throws(() => parseCliArgs(['enable', 'demo', '--type', 'skills', '--dry-run']), /dry-run/);
  assert.throws(() => parseCliArgs(['add', '/tmp/repo', '-P', '/tmp/repo']), /project/);

  assert.equal(parseCliArgs([]).command, 'summary');
});

test('enable and disable parse on the unified surface and picker order rejects bad permutations', () => {
  const parsed = parseCliArgs(['enable', 'alpha', '--type', 'rules', '--app', 'cursor']);
  assert.equal(parsed.command, 'enable');
  if (parsed.command !== 'enable') return;
  assert.deepEqual(parsed.ids, ['alpha']);
  assert.deepEqual(parsed.options.types, ['rules']);
  assert.deepEqual(parsed.options.apps, ['cursor']);

  // A reorder answer that is not a permutation would silently drop or
  // duplicate a selection, so only a full one-based permutation resolves.
  assert.deepEqual(resolvePickerOrder('2,1', ['a', 'b']), ['b', 'a']);
  assert.throws(() => resolvePickerOrder('1', ['a', 'b']), /exactly 2/);
  assert.throws(() => resolvePickerOrder('1,1', ['a', 'b']), /duplicate/i);
  assert.throws(() => resolvePickerOrder('a,c', ['a', 'b']), /unknown/i);
});

test('ordered replacement preserves comments, symlink target, mode, and idempotence', async () => {
  await withScratchHomes(async (homes) => {
    const backing = path.join(homes.root, 'dotfiles', 'config.toml');
    fs.mkdirSync(path.dirname(backing), { recursive: true });
    fs.writeFileSync(
      backing,
      '# header\n[commands]\n# keep order note\nenabled = [\n  "a", # pinned\n  # "off",\n  "b",\n]\n'
    );
    fs.chmodSync(backing, 0o600);
    fs.symlinkSync(backing, configPath(homes));

    editSelection({ type: 'commands', replace: ['b', 'a'] });

    const once = fs.readFileSync(backing, 'utf-8');
    assert.deepEqual(
      ((parseToml(once) as Record<string, unknown>).commands as Record<string, unknown>).enabled,
      ['b', 'a']
    );
    for (const comment of ['# header', '# keep order note', '# pinned', '# "off"']) {
      assert.match(once, new RegExp(comment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(fs.lstatSync(configPath(homes)).isSymbolicLink(), true, 'edited through the link');
    assert.equal(fs.statSync(backing).mode & 0o777, 0o600);

    editSelection({ type: 'commands', replace: ['b', 'a'] });
    assert.equal(fs.readFileSync(backing, 'utf-8'), once);
  });
});

test('empty replacement is explicit and app edits splice add and remove lists', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '# keep\n[applications.cursor.commands]\nadd = ["old"]\nremove = ["new"]\n'
    );

    editSelection({ type: 'commands', replace: [] });
    editSelection({ type: 'commands', app: 'cursor', enable: ['new'], disable: ['old'] });

    const spliced = selectionOf(homes) as {
      commands?: { enabled?: string[] };
      applications?: { cursor?: { commands?: { add?: string[]; remove?: string[] } } };
    };
    // An empty selection is a decision, so it is written rather than left to
    // an absent key, which reads as "inherit whatever the layer below says".
    assert.deepEqual(spliced.commands?.enabled, []);
    assert.deepEqual(spliced.applications?.cursor?.commands?.add, ['new']);
    assert.deepEqual(spliced.applications?.cursor?.commands?.remove, ['old']);
    assert.match(readConfig(homes), /# keep/);

    // An app block that already answers with `enabled` keeps answering that
    // way: edits rewrite it and its add/remove siblings stay ignored.
    writeUserConfig(
      homes,
      '[applications.cursor.commands]\nenabled = ["old"]\nadd = ["ignored"]\nremove = ["also-ignored"]\n'
    );
    editSelection({ type: 'commands', app: 'cursor', disable: ['old'] });
    editSelection({ type: 'commands', app: 'cursor', enable: ['new'] });

    const overridden = selectionOf(homes) as {
      applications?: { cursor?: { commands?: { enabled?: string[] } } };
    };
    assert.deepEqual(overridden.applications?.cursor?.commands?.enabled, ['new']);
  });
});

test('a selection command changes nothing while another run holds the lock', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[commands]\nenabled = ["old"]\n');
    const before = readConfig(homes);
    holdRunLock(homes);

    const invocation = parseCliArgs(['enable', 'new', '--type', 'commands']);
    assert.equal(invocation.command, 'enable');
    if (invocation.command !== 'enable') return;
    await assert.rejects(
      runSelectionCommand(invocation.command, invocation.ids, invocation.options),
      /appears to be active/
    );
    assert.equal(readConfig(homes), before);

    // The picker route asks one frame earlier and fails at the same gate.
    const picker = await runMain(['enable']);
    assert.equal(picker.code, 2, picker.out || picker.err);
    assert.equal(readConfig(homes), before);
  });
});

test('enable rejects an unknown app before writing and records ids the library lacks', async () => {
  await withScratchHomes(async (homes) => {
    seedMarketplace(homes, 'shop', 'shop', 'demo', { 'README.md': 'Demo plugin.\n' });
    writeUserConfig(homes, '[applications]\nenabled = []\n');
    const before = readConfig(homes);

    const unknown = await runMain(['enable', 'demo', '--type', 'mcp', '--app', 'codez']);
    assert.equal(unknown.code, 2, unknown.out || unknown.err);
    assert.match(unknown.err, /codez/, 'the rejected app id is named');
    assert.equal(readConfig(homes), before, 'a rejected invocation writes nothing');

    // An id nothing defines yet is accepted and validated at the next sync,
    // so a selection can be prepared before the source that carries it.
    const unresolved = await runMain(['enable', 'future', '--type', 'mcp']);
    assert.equal(unresolved.code, 0, unresolved.err);
    assert.deepEqual((selectionOf(homes).mcp as { enabled?: string[] })?.enabled, ['future']);

    // With no --type, a bare marketplace entry name resolves to its plugin.
    const alias = await runMain(['enable', 'demo']);
    assert.equal(alias.code, 0, alias.err);
    assert.deepEqual((selectionOf(homes).plugins as { enabled?: string[] })?.enabled, ['demo']);
  });
});

test('selection and explain JSON use the standard report envelope', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[applications]\nenabled = []\n');

    for (const result of [
      await runMain(['enable', 'future', '--type', 'mcp', '--json']),
      await runMain(['explain', 'future', '--json']),
    ]) {
      const envelope = JSON.parse(result.out) as Record<string, unknown>;
      assert.equal(envelope.version, 1);
      assert.equal(typeof envelope.scope, 'object');
      assert.ok(Array.isArray(envelope.entries));
      assert.equal(typeof envelope.summary, 'object');
      assert.equal(typeof envelope.exitCode, 'number');
    }
  });
});
