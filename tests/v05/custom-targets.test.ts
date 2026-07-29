import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { appRows } from '../../src/engine/apps.js';
import { loadConfig } from '../../src/engine/config.js';
import {
  keyedArrayToRecord,
  kvArrayToEnvMap,
  transformFrontmatter,
  transformMcpServer,
} from '../../src/engine/dialects.js';
import type { Component } from '../../src/engine/library.js';
import { withScratchHomes, writeUserConfig } from './helpers/scratch.js';

function command(metadata: Record<string, unknown>): Component {
  return {
    type: 'commands',
    id: 'pack:docs',
    source: 'pack',
    path: '/library/commands/docs.md',
    content: 'Write docs.\n',
    metadata: { tags: [], requires: [], ...metadata },
  };
}

test('custom target rows reject unknown keys with a nearest-key suggestion', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '[targets.mine.mcp]\nformat = "yaml"\nconfig_pth = "~/.mine/config.yaml"\n'
    );

    assert.throws(loadConfig, /unknown key "targets\.mine\.mcp\.config_pth".*config_path/);
  });
});

test('custom target rows reject wrong types and unsafe filename patterns', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[targets.mine.commands]\ntarget_dir = 42\n');
    assert.throws(loadConfig, /targets\.mine\.commands\.target_dir/);

    for (const pattern of ['plain.md', '{id}-{id}.md', '../{id}.md', '{id}']) {
      writeUserConfig(
        homes,
        `[targets.mine.commands]\ntarget_dir = "~/.mine/commands"\nfilename_pattern = "${pattern}"\n`
      );
      assert.throws(loadConfig, /filename_pattern/);
    }
  });
});

test('a custom target compiles directly into common AppRow columns', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      [
        '[targets.mine]',
        'detect = "~/.mine"',
        '',
        '[targets.mine.mcp]',
        'format = "yaml"',
        'config_path = "~/.mine/config.yaml"',
        'root_key = "servers"',
        'structure = "keyed-array"',
        'key_field = "name"',
        'defaults = { type = "stdio" }',
        'env_transform = { key_name = "key", value_name = "value" }',
        '',
        '[targets.mine.commands]',
        'target_dir = "~/.mine/commands"',
        'filename_pattern = "cmd-{id}.txt"',
        'platform_key = "mine"',
        '',
        '[targets.mine.commands.frontmatter]',
        'defaults = { model = "inherit" }',
        'join = { tools = "," }',
        'include = ["description", "model", "tools"]',
        'omit = ["description"]',
        'rename = { tools = "allowed-tools" }',
        '',
        '[targets.mine.rules]',
        'format = "mdc"',
        'file_path = "~/.mine/rules.mdc"',
        '',
        '[targets.mine.skills]',
        'parent_dir = "~/.mine/skills"',
        '',
      ].join('\n')
    );

    const row = appRows(loadConfig()).find((candidate) => candidate.id === 'mine');
    assert.ok(row);
    assert.equal(row.detectDir(homes), path.join(homes.agentsHome, '.mine'));
    assert.equal(row.mcp?.path(homes), path.join(homes.agentsHome, '.mine', 'config.yaml'));
    assert.equal(row.mcp?.format, 'yaml');
    assert.equal(row.mcp?.structure, 'keyed-array');
    assert.deepEqual(
      row.mcp?.dialect({ command: 'npx', env: { TOKEN: 'INVENTED-PLACEHOLDER-9f3a' } }),
      {
        command: 'npx',
        env: [{ key: 'TOKEN', value: 'INVENTED-PLACEHOLDER-9f3a' }],
        type: 'stdio',
      }
    );
    assert.equal(row.commands?.filename('pack:docs'), 'cmd-pack-docs.txt');
    assert.equal(
      row.commands?.render(
        command({
          description: 'Generate docs',
          extras: { mine: { tools: ['read', 'write'], ignored: true } },
        })
      ),
      '---\ndescription: Generate docs\nmodel: inherit\nallowed-tools: read,write\n---\n\nWrite docs.\n'
    );
    assert.ok(row.rules && row.skills);
  });
});

test('a custom target id cannot collide with a builtin', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[targets.cursor.rules]\nfile_path = "~/.mine/rules.md"\n');
    assert.throws(() => appRows(loadConfig()), /target id "cursor" collides with builtin/);
  });
});

test('the carried transforms keep pipeline order and inverse validation', () => {
  assert.deepEqual(
    transformFrontmatter(
      { tools: ['read', 'write'], omitMe: true },
      {
        defaults: { model: 'inherit' },
        join: { tools: ',' },
        include: ['model', 'tools'],
        omit: ['tools'],
        rename: { tools: 'allowed-tools' },
      }
    ),
    { model: 'inherit', 'allowed-tools': 'read,write' }
  );
  assert.deepEqual(
    transformMcpServer(
      { env: { A: 'one' } },
      { defaults: { type: 'stdio' }, envTransform: { keyName: 'key', valueName: 'value' } }
    ),
    { env: [{ key: 'A', value: 'one' }], type: 'stdio' }
  );
  assert.deepEqual(kvArrayToEnvMap([{ key: 'A', value: 'one' }]), { A: 'one' });
  assert.throws(() => keyedArrayToRecord([{ command: 'x' }], 'name'), /missing identity/);
  assert.throws(
    () => keyedArrayToRecord([{ name: 'a' }, { name: 'a' }], 'name'),
    /duplicate identity/
  );
});
