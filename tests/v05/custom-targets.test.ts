import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows } from '../../src/engine/apps.js';
import { runSync } from '../../src/engine/cli.js';
import { loadConfig } from '../../src/engine/config.js';
import {
  keyedArrayToRecord,
  kvArrayToEnvMap,
  transformFrontmatter,
  transformMcpServer,
} from '../../src/engine/dialects.js';
import type { Component } from '../../src/engine/library.js';
import { seedMcpLibrary, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

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

test('a custom JSON keyed-array target writes, updates, and removes array members', async () => {
  await withScratchHomes(async (homes) => {
    const targetDir = path.join(homes.agentsHome, '.mine');
    const host = path.join(targetDir, 'config.json');
    fs.mkdirSync(targetDir, { recursive: true });
    const config = (enabled: boolean): string =>
      [
        '[applications]',
        'enabled = ["mine"]',
        '',
        '[mcp]',
        `enabled = ${enabled ? '["alpha"]' : '[]'}`,
        '',
        '[targets.mine]',
        'detect = "~/.mine"',
        '',
        '[targets.mine.mcp]',
        'format = "json"',
        'config_path = "~/.mine/config.json"',
        'root_key = "servers"',
        'structure = "keyed-array"',
        'key_field = "name"',
        '',
      ].join('\n');
    seedMcpLibrary(homes, { alpha: { command: 'one' } });
    writeUserConfig(homes, config(true));

    assert.equal((await runSync()).exitCode, 0);
    assert.equal(JSON.parse(fs.readFileSync(host, 'utf-8')).servers[0].name, 'alpha');

    fs.writeFileSync(host, '{\n  "servers": [],\n  "keep": true\n}\n', 'utf-8');
    assert.equal((await runSync()).exitCode, 0);
    let root = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      servers: Record<string, unknown>[];
      keep: boolean;
    };
    assert.equal(root.servers[0]?.name, 'alpha');
    assert.equal(root.keep, true);

    root.servers.push({ name: 'foreign', command: 'keep' });
    fs.writeFileSync(host, `${JSON.stringify(root, null, 2)}\n`, 'utf-8');
    seedMcpLibrary(homes, { alpha: { command: 'two' } });
    assert.equal((await runSync()).exitCode, 0);
    root = JSON.parse(fs.readFileSync(host, 'utf-8'));
    assert.equal(root.servers.find((server) => server.name === 'alpha')?.command, 'two');

    writeUserConfig(homes, config(false));
    assert.equal((await runSync()).exitCode, 0);
    root = JSON.parse(fs.readFileSync(host, 'utf-8'));
    assert.deepEqual(root.servers, [{ name: 'foreign', command: 'keep' }]);
    assert.equal(root.keep, true);
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

test('a rules path configuration chose is never swept by name', async () => {
  await withScratchHomes(async (homes) => {
    const targetDir = path.join(homes.agentsHome, '.mine');
    fs.mkdirSync(targetDir, { recursive: true });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["mine"]',
        '',
        '[rules]',
        'enabled = []',
        '',
        '[targets.mine]',
        'detect = "~/.mine"',
        '',
        '[targets.mine.rules]',
        'file_path = "~/.mine/rules.md"',
        '',
      ].join('\n')
    );

    // The path is the user's answer to "where do rules go", not a name asb
    // chose, so neither it nor a sibling wearing the retired prefix is
    // evidence of anything. Both are the user's bytes.
    const chosen = path.join(targetDir, 'rules.md');
    const sibling = path.join(targetDir, 'asb-rules.md');
    fs.writeFileSync(chosen, 'House rules, written by hand.\n', 'utf-8');
    fs.writeFileSync(sibling, 'Notes about asb, written by hand.\n', 'utf-8');

    const report = await runSync();

    assert.equal(fs.readFileSync(chosen, 'utf-8'), 'House rules, written by hand.\n');
    assert.equal(fs.readFileSync(sibling, 'utf-8'), 'Notes about asb, written by hand.\n');
    const row = report.entries.find((entry) => entry.path === chosen);
    assert.equal(row?.outcome, 'left-behind', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.detail, 'unproven');
    assert.equal(
      report.entries.some((entry) => entry.path === sibling),
      false,
      'a file asb has no claim on is not its business to name'
    );
  });
});
