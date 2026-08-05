import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows } from '../src/engine/apps.js';
import { runSync } from '../src/engine/cli.js';
import { loadConfig } from '../src/engine/config.js';
import { keyedArrayToRecord } from '../src/engine/dialects.js';
import type { Component } from '../src/engine/library.js';
import { seedMcpLibrary, seedTree, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

/**
 * A target the user declares in `[targets.<id>]` is compiled into the same
 * AppRow columns a builtin occupies, so it plans, writes, and retires through
 * the common machinery. What is asserted here is the compilation, the config
 * rejections that guard it, and one round trip through a real sync.
 */

const CUSTOM_MCP = [
  '[targets.mine.mcp]',
  'format = "yaml"',
  'config_path = "~/.mine/config.yaml"',
  'root_key = "servers"',
  'structure = "keyed-array"',
  'key_field = "name"',
] as const;

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

test('custom target rows reject wrong types and unsafe filename patterns', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[targets.mine.commands]\ntarget_dir = 42\n');
    assert.throws(loadConfig, /targets\.mine\.commands\.target_dir/);

    // The pattern is a user-authored template that becomes a path, so it must
    // name exactly one id, stay inside the target dir, and carry an extension.
    for (const pattern of ['plain.md', '{id}-{id}.md', '../{id}.md', '{id}']) {
      writeUserConfig(
        homes,
        `[targets.mine.commands]\ntarget_dir = "~/.mine/commands"\nfilename_pattern = "${pattern}"\n`
      );
      assert.throws(loadConfig, /filename_pattern/);
    }

    writeUserConfig(
      homes,
      [...CUSTOM_MCP, 'env_transform = { key_name = "env", value_name = "env" }', ''].join('\n')
    );
    assert.throws(loadConfig, /key_name and value_name must differ/);

    writeUserConfig(homes, '[targets.cursor.rules]\nfile_path = "~/.mine/rules.md"\n');
    assert.throws(() => appRows(loadConfig()), /target id "cursor" collides with builtin/);
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
        ...CUSTOM_MCP,
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
    // Defaults, join, include, omit, and rename run in that fixed order.
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

    // Reading a keyed array back is the inverse of writing one, so a member
    // without an identity or sharing one is a refusal, not a silent merge.
    assert.throws(() => keyedArrayToRecord([{ command: 'x' }], 'name'), /missing identity/);
    assert.throws(
      () => keyedArrayToRecord([{ name: 'a' }, { name: 'a' }], 'name'),
      /duplicate identity/
    );
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
    assert.equal(root.servers[0]?.name, 'alpha', 'a truncated array is filled back in');
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

test('custom command rows use the common exact-path planner and encoded filename', async () => {
  await withScratchHomes(async (homes) => {
    seedTree(homes.asbHome, { 'commands/pack:build.md': 'Build.\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["mine"]',
        'assume_installed = ["mine"]',
        '',
        '[commands]',
        'enabled = ["pack:build"]',
        '',
        '[targets.mine.commands]',
        'target_dir = "~/.mine/commands"',
        'filename_pattern = "cmd-{id}.txt"',
        '',
      ].join('\n')
    );

    const report = await runSync();

    const target = path.join(homes.agentsHome, '.mine', 'commands', 'cmd-pack-build.txt');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(
      report.entries.some(
        (row) => row.app === 'mine' && row.type === 'commands' && row.path === target
      ),
      true
    );
    assert.equal(fs.readFileSync(target, 'utf-8'), '---\n{}\n---\n\nBuild.\n');
  });
});

test('a rules path the configuration chose is never swept by name', async () => {
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
