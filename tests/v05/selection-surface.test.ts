import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import {
  main,
  parseCliArgs,
  resolvePickerOrder,
  runAddSource,
  runSelectionCommand,
} from '../../src/engine/cli.js';
import { editSelection } from '../../src/engine/config.js';
import { type ScratchHomes, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

function readConfigFile(homes: ScratchHomes, name: string): string {
  return fs.readFileSync(path.join(homes.asbHome, name), 'utf-8');
}

test('ordered replacement preserves comments, symlink target, mode, and idempotence', async () => {
  await withScratchHomes(async (homes) => {
    const backing = path.join(homes.root, 'dotfiles', 'config.toml');
    fs.mkdirSync(path.dirname(backing), { recursive: true });
    fs.writeFileSync(
      backing,
      '# header\n[commands]\n# keep order note\nenabled = [\n  "a", # pinned\n  # "off",\n  "b",\n]\n'
    );
    fs.chmodSync(backing, 0o600);
    fs.symlinkSync(backing, path.join(homes.asbHome, 'config.toml'));

    editSelection({ type: 'commands', replace: ['b', 'a'] });
    const once = fs.readFileSync(backing, 'utf-8');
    assert.deepEqual(
      ((parseToml(once) as Record<string, unknown>).commands as Record<string, unknown>).enabled,
      ['b', 'a']
    );
    for (const comment of ['# header', '# keep order note', '# pinned', '# "off"']) {
      assert.match(once, new RegExp(comment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(fs.lstatSync(path.join(homes.asbHome, 'config.toml')).isSymbolicLink(), true);
    assert.equal(fs.statSync(backing).mode & 0o777, 0o600);

    editSelection({ type: 'commands', replace: ['b', 'a'] });
    assert.equal(fs.readFileSync(backing, 'utf-8'), once);
  });
});

test('empty replacement is explicit and app edits share add/remove splice mechanics', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '# keep\n[applications.cursor.commands]\nadd = ["old"]\nremove = ["new"]\n'
    );

    editSelection({ type: 'commands', replace: [] });
    editSelection({ type: 'commands', app: 'cursor', enable: ['new'], disable: ['old'] });

    const content = fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8');
    const parsed = parseToml(content) as {
      commands?: { enabled?: string[] };
      applications?: { cursor?: { commands?: { add?: string[]; remove?: string[] } } };
    };
    assert.deepEqual(parsed.commands?.enabled, []);
    assert.deepEqual(parsed.applications?.cursor?.commands?.add, ['new']);
    assert.deepEqual(parsed.applications?.cursor?.commands?.remove, ['old']);
    assert.match(content, /# keep/);
  });
});

test('an app enabled override stays authoritative through disable and re-enable', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '[applications.cursor.commands]\nenabled = ["old"]\nadd = ["ignored"]\nremove = ["also-ignored"]\n'
    );

    editSelection({ type: 'commands', app: 'cursor', disable: ['old'] });
    editSelection({ type: 'commands', app: 'cursor', enable: ['new'] });

    const parsed = parseToml(fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8')) as {
      applications?: {
        cursor?: { commands?: { enabled?: string[]; add?: string[]; remove?: string[] } };
      };
    };
    assert.deepEqual(parsed.applications?.cursor?.commands?.enabled, ['new']);
  });
});

test('selection edits reject the rule id reserved for the outer region', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabled = ["safe"]\n');
    const filePath = path.join(homes.asbHome, 'config.toml');
    const before = fs.readFileSync(filePath, 'utf-8');

    assert.throws(() => editSelection({ type: 'rules', enable: ['rules'] }), /cannot be a rule id/);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), before);
  });
});

test('a selection command changes nothing while another run holds the lock', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[commands]\nenabled = ["old"]\n');
    const configPath = path.join(homes.asbHome, 'config.toml');
    const before = fs.readFileSync(configPath, 'utf-8');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    fs.writeFileSync(path.join(homes.stateHome, 'run.lock'), `${process.pid} held\n`);
    const invocation = parseCliArgs(['enable', 'new', '--type', 'commands']);
    assert.equal(invocation.command, 'enable');
    if (invocation.command !== 'enable') return;

    await assert.rejects(
      runSelectionCommand(invocation.command, invocation.ids, invocation.options),
      /appears to be active/
    );
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
  });
});

test('the interactive selection picker changes nothing while another run holds the lock', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[commands]\nenabled = ["old"]\n');
    const configPath = path.join(homes.asbHome, 'config.toml');
    const before = fs.readFileSync(configPath, 'utf-8');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    fs.writeFileSync(path.join(homes.stateHome, 'run.lock'), `${process.pid} held\n`);
    const stderr = process.stderr.write.bind(process.stderr);
    let err = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(await main(['enable']), 2);
    } finally {
      process.stderr.write = stderr;
    }
    assert.match(err, /appears to be active/);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
  });
});

test('enable -p edits the named selection file and leaves config.toml alone', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[commands]\nenabled = ["old"]\n');
    fs.writeFileSync(
      path.join(homes.asbHome, 'aws.toml'),
      '[commands]\nenabled = ["kept"]\n',
      'utf-8'
    );
    const untouched = readConfigFile(homes, 'config.toml');

    const invocation = parseCliArgs(['enable', 'new', '--type', 'commands', '-p', 'aws']);
    assert.equal(invocation.command, 'enable');
    if (invocation.command !== 'enable') return;
    assert.equal(invocation.options.profile, 'aws');
    await runSelectionCommand(invocation.command, invocation.ids, invocation.options);

    const parsed = parseToml(readConfigFile(homes, 'aws.toml')) as {
      commands?: { enabled?: string[] };
    };
    assert.deepEqual(parsed.commands?.enabled, ['kept', 'new']);
    assert.equal(readConfigFile(homes, 'config.toml'), untouched);
  });
});

test('a source added while a profile is active is declared in config.toml', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    fs.writeFileSync(
      path.join(homes.asbHome, 'aws.toml'),
      '[applications]\nenabled = ["claude-code"]\n',
      'utf-8'
    );
    const untouched = readConfigFile(homes, 'aws.toml');
    const local = path.join(homes.root, 'local-lib');
    fs.mkdirSync(path.join(local, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(local, 'rules', 'style.md'), '# Style\n', 'utf-8');
    process.env.ASB_PROFILE = 'aws';

    // A profile selects; it never owns the machine's setup. The declaration
    // lands in the file every run resolves sources from, whichever selection
    // file that run reads.
    const report = await runAddSource(local, { as: 'lib' });

    assert.equal(report.exitCode, 0);
    const parsed = parseToml(readConfigFile(homes, 'config.toml')) as {
      plugins?: { sources?: Record<string, unknown> };
    };
    assert.equal(parsed.plugins?.sources?.lib, local);
    assert.equal(readConfigFile(homes, 'aws.toml'), untouched);
  });
});

test('enable/disable parse on the unified surface and picker order rejects bad permutations', () => {
  const parsed = parseCliArgs(['enable', 'alpha', '--type', 'rules', '--app', 'cursor']);
  assert.equal(parsed.command, 'enable');
  if (parsed.command !== 'enable') return;
  assert.deepEqual(parsed.ids, ['alpha']);
  assert.deepEqual(parsed.options.types, ['rules']);
  assert.deepEqual(parsed.options.apps, ['cursor']);

  assert.deepEqual(resolvePickerOrder('2,1', ['a', 'b']), ['b', 'a']);
  assert.throws(() => resolvePickerOrder('1', ['a', 'b']), /exactly 2/);
  assert.throws(() => resolvePickerOrder('1,1', ['a', 'b']), /duplicate/i);
  assert.throws(() => resolvePickerOrder('a,c', ['a', 'b']), /unknown/i);
});

test('a repository-declared source contributes nothing an enable -P can resolve', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const vendored = path.join(homes.root, 'vendored');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(vendored, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(vendored, 'commands', 'leak.md'), 'repository body\n', 'utf-8');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      `[plugins.sources]\nevil = ${JSON.stringify(vendored)}\n`,
      'utf-8'
    );

    // Sources are config.toml's in every scope, so the id the repository
    // would supply resolves against the machine's library and is not there.
    await assert.rejects(
      runSelectionCommand('enable', ['evil:leak'], { project }),
      /Unknown component "evil:leak"/
    );
  });
});
