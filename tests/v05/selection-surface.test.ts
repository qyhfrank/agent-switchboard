import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { parseCliArgs, resolvePickerOrder } from '../../src/engine/cli.js';
import { editSelection } from '../../src/engine/config.js';
import { withScratchHomes, writeUserConfig } from './helpers/scratch.js';

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
