import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from '@iarna/toml';
import { parseCliArgs, resolvePickerOrder, runSelectionCommand } from '../src/engine/cli.js';
import {
  clearDefaultProfile,
  defaultProfilePath,
  editSelection,
  setDefaultProfile,
} from '../src/engine/config.js';
import {
  inCwd,
  runMain,
  type ScratchHomes,
  seedMarketplace,
  seedRule,
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

test('default management reports saved and effective selections without editing shared files', async () => {
  await withScratchHomes(async (homes) => {
    const original = '[applications]\nenabled = []\n';
    for (const name of ['config', 'work', 'personal']) {
      fs.writeFileSync(configPath(homes, `${name}.toml`), original);
    }
    const set = await runMain(['profile', 'default', 'work']);
    assert.equal(set.code, 0, set.err);
    assert.equal(fs.readFileSync(defaultProfilePath(), 'utf-8'), 'work\n');
    assert.match(set.out, /Saved default: work\nEffective profile: work\nSource: default/);
    process.env.ASB_PROFILE = 'personal';
    for (const argv of [
      ['--json', 'profile', 'default'],
      ['profile', '--json', 'default'],
      ['profile', 'default', '--json'],
    ]) {
      const result = await runMain(argv);
      assert.equal(result.code, 0, result.err);
      const envelope = JSON.parse(result.out);
      assert.equal(envelope.version, 1);
      assert.equal(envelope.scope.profile, 'personal');
      assert.deepEqual(envelope.entries, [
        {
          path: defaultProfilePath(),
          saved: 'work',
          effective: 'personal',
          source: 'env',
          outcome: 'unchanged',
        },
      ]);
    }
    delete process.env.ASB_PROFILE;
    for (const invalid of ['work\npersonal', 'absent']) {
      fs.writeFileSync(defaultProfilePath(), invalid);
      assert.notEqual((await runMain(['profile', 'default'])).code, 0);
      assert.equal((await runMain(['profile', 'default', '--clear'])).code, 0);
      assert.equal((await runMain(['profile', 'default', '--clear'])).code, 0);
      assert.equal(fs.existsSync(defaultProfilePath()), false);
    }
    for (const name of ['config', 'work', 'personal'])
      assert.equal(readConfig(homes, `${name}.toml`), original);
    assert.deepEqual(fs.readdirSync(homes.agentsHome), []);
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'last-run.json')), false);
  });
});

test('invalid environment profiles reject default mutations before changing the selector', async () => {
  await withScratchHomes(async (homes) => {
    for (const name of ['work', 'personal']) {
      fs.writeFileSync(configPath(homes, `${name}.toml`), '[rules]\nenabled = []\n');
    }
    for (const saved of ['work', null]) {
      if (saved === null) clearDefaultProfile();
      else setDefaultProfile(saved);
      process.env.ASB_PROFILE = 'config';
      for (const args of [['personal'], ['--clear']]) {
        const result = await runMain(['profile', 'default', ...args, '--json']);
        assert.equal(result.code, 2, result.err);
        assert.equal(result.out, '');
        if (saved === null) assert.equal(fs.existsSync(defaultProfilePath()), false);
        else assert.equal(fs.readFileSync(defaultProfilePath(), 'utf-8'), `${saved}\n`);
      }
      delete process.env.ASB_PROFILE;
    }
  });
});

test('default management rejects conflicting arguments and unrelated scope flags', () => {
  for (const argv of [
    ['profile', 'default', 'work', '--clear'],
    ['profile', 'default', 'work', 'personal'],
    ['-p', 'work', 'profile', 'default'],
    ['-P', '/tmp/repo', 'profile', 'default'],
    ['--dry-run', 'profile', 'default'],
    ['--app', 'codex', 'profile', 'default'],
    ['profile', 'default', '--update'],
  ])
    assert.throws(() => parseCliArgs(argv), argv.join(' '));
});

test('selection commands edit the effective profile or the explicitly requested project', async () => {
  await withScratchHomes(async (homes) => {
    const original = '[rules]\nenabled = []\n';
    for (const name of ['config', 'work', 'personal'])
      fs.writeFileSync(configPath(homes, `${name}.toml`), original);
    setDefaultProfile('work');
    for (const [profile, args, environment] of [
      ['work', [], undefined],
      ['personal', [], 'personal'],
      ['work', ['-p', 'work'], 'personal'],
    ] as const) {
      if (environment) process.env.ASB_PROFILE = environment;
      else delete process.env.ASB_PROFILE;
      for (const command of ['enable', 'disable']) {
        const result = await runMain([command, 'extra', '--type', 'rules', ...args, '--json']);
        assert.equal(result.code, 0, result.err);
        assert.equal(JSON.parse(result.out).scope.profile, profile);
        assert.deepEqual(
          (selectionOf(homes, `${profile}.toml`).rules as { enabled: string[] }).enabled,
          command === 'enable' ? ['extra'] : []
        );
        assert.equal(readConfig(homes), original);
        assert.equal(
          readConfig(homes, `${profile === 'work' ? 'personal' : 'work'}.toml`),
          original
        );
      }
    }
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    const projectFile = path.join(project, '.asb.toml');
    fs.writeFileSync(projectFile, original);
    for (const environment of [undefined, 'personal']) {
      if (environment) process.env.ASB_PROFILE = environment;
      else delete process.env.ASB_PROFILE;
      for (const command of ['enable', 'disable']) {
        const result = await runMain([command, 'extra', '--type', 'rules', '-P', project]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(
          (parseToml(fs.readFileSync(projectFile, 'utf-8')).rules as { enabled: string[] }).enabled,
          command === 'enable' ? ['extra'] : []
        );
      }
    }
    const rejected = await runMain([
      'enable',
      'extra',
      '--type',
      'rules',
      '-p',
      'work',
      '-P',
      project,
    ]);
    assert.equal(rejected.code, 2);
    for (const name of ['config', 'work', 'personal'])
      assert.equal(readConfig(homes, `${name}.toml`), original);
  });
});

test('the real picker retains its selection and report when the saved default changes', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'extra.md', 'Extra rule body.\n');
    const original = '[rules]\nenabled = ["extra"]\n';
    for (const name of ['config', 'work', 'personal']) {
      fs.writeFileSync(configPath(homes, `${name}.toml`), original);
    }
    setDefaultProfile('work');
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    const projectFile = path.join(project, '.asb.toml');
    fs.writeFileSync(projectFile, original);
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    for (const [target, args, environment, initial, next] of [
      [configPath(homes, 'work.toml'), [], '', 'work', 'personal'],
      [configPath(homes, 'personal.toml'), [], 'personal', 'work', null],
      [projectFile, ['-P', project], 'personal', 'work', 'personal'],
      [configPath(homes, 'work.toml'), ['--app', 'cursor'], '', 'work', 'personal'],
      [configPath(homes, 'work.toml'), [], '', 'work', null],
      [configPath(homes), [], '', null, 'work'],
    ] as const) {
      fs.writeFileSync(target, original);
      if (initial === null) clearDefaultProfile();
      else setDefaultProfile(initial);
      if (args.includes('--app')) {
        fs.writeFileSync(target, '[applications.cursor.rules]\nadd = ["extra"]\n');
      }
      const files = ['config.toml', 'work.toml', 'personal.toml'].map((name) =>
        configPath(homes, name)
      );
      files.push(projectFile);
      const before = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf-8')]));
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            entry,
            'enable',
            '--type',
            'rules',
            '--json',
            ...args,
          ],
          {
            cwd: homes.root,
            env: {
              ...process.env,
              ASB_PROFILE: environment,
              XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
              NO_COLOR: '1',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
        let output = '';
        let answered = false;
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Picker did not finish: ${output}`));
        }, 10000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stderr.on('data', (chunk) => {
          output += chunk;
        });
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (!answered && output.includes('Select components to enable')) {
            answered = true;
            if (next === null) clearDefaultProfile();
            else setDefaultProfile(next);
            child.stdin.write(' \r');
          }
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`Picker exited ${code}: ${output}`));
          else resolve(output);
        });
      });
      const envelopeStart = output.lastIndexOf('{\n  "version": 1,');
      assert.ok(envelopeStart >= 0, output);
      const envelope = JSON.parse(output.slice(envelopeStart));
      assert.equal(envelope.scope.profile, environment || initial);
      assert.equal(envelope.scope.project, target === projectFile ? project : null);
      assert.notEqual(fs.readFileSync(target, 'utf-8'), before.get(target));
      for (const file of files.filter((file) => file !== target)) {
        assert.equal(fs.readFileSync(file, 'utf-8'), before.get(file));
      }
      if (next === null) assert.equal(fs.existsSync(defaultProfilePath()), false);
      else assert.equal(fs.readFileSync(defaultProfilePath(), 'utf-8'), `${next}\n`);
    }
  });
});

test('init JSON completes with a stale saved selector', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.dirname(defaultProfilePath()), { recursive: true });
    fs.writeFileSync(defaultProfilePath(), 'absent\n');
    await inCwd(homes.root, async () => {
      const result = await runMain(['init', '--json']);
      assert.equal(result.code, 0, result.err);
      const envelope = JSON.parse(result.out);
      assert.equal(envelope.exitCode, 0);
      assert.deepEqual(envelope.scope, { profile: null, project: null, dryRun: false });
      assert.equal(envelope.entries[0].outcome, 'written');
      assert.ok(fs.existsSync(path.join(homes.root, '.asb.toml')));
      assert.equal(fs.readFileSync(defaultProfilePath(), 'utf-8'), 'absent\n');
    });
  });
});

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
