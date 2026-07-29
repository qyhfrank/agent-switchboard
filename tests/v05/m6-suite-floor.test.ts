import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../../src/engine/apps.js';
import { runImport, runSync } from '../../src/engine/cli.js';
import { editSelection, loadConfig } from '../../src/engine/config.js';
import {
  applyDefaults,
  envMapToKvArray,
  joinFields,
  keyedArrayToRecord,
  kvArrayToEnvMap,
  omitFields,
  pickFields,
  renameFields,
  transformFrontmatter,
  transformMcpServer,
} from '../../src/engine/dialects.js';
import { scanLibrary } from '../../src/engine/library.js';
import { installApps, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

function write(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

test('commands and agents obey the active app set and per-app selection overrides', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    write(path.join(homes.asbHome, 'commands', 'build.md'), 'Build.\n');
    write(path.join(homes.asbHome, 'agents', 'reviewer.md'), 'Review.\n');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "cursor"]',
        '',
        '[commands]',
        'enabled = ["build"]',
        '',
        '[agents]',
        'enabled = ["reviewer"]',
        '',
        '[applications.cursor.commands]',
        'enabled = []',
        '',
        '[applications.cursor.agents]',
        'remove = ["reviewer"]',
      ].join('\n')
    );

    const report = await runSync({ dryRun: true });
    assert.ok(report.entries.some((row) => row.app === 'claude-code' && row.id === 'build'));
    assert.ok(report.entries.some((row) => row.app === 'claude-code' && row.id === 'reviewer'));
    assert.equal(
      report.entries.some((row) => row.app === 'cursor' && row.id === 'build'),
      false
    );
    assert.equal(
      report.entries.some((row) => row.app === 'cursor' && row.id === 'reviewer'),
      false
    );
  });
});

test('every built-in command and agent importer round-trips through its AppRow dialect', async () => {
  await withScratchHomes(async (homes) => {
    const commandSources = new Map<string, string>([
      ['claude-code', '---\ndescription: Claude command\nmodel: opus\n---\nBODY-claude-code\n'],
      ['codex', 'BODY-codex\n'],
      ['cursor', 'BODY-cursor\n'],
      [
        'gemini',
        'prompt = "BODY-gemini\\n"\ndescription = "Gemini command"\ncustom_field = "kept"\n',
      ],
      ['opencode', '---\ndescription: OpenCode command\nmodel: test-model\n---\nBODY-opencode\n'],
    ]);
    const agentSources = new Map<string, string>([
      [
        'claude-code',
        '---\ndescription: Claude agent\nmodel: opus\ntools: [Read]\n---\nBODY-claude-code\n',
      ],
      ['codex', 'model = "gpt-test"\ndeveloper_instructions = "BODY-codex\\n"\n'],
      [
        'cursor',
        '---\ndescription: Cursor agent\nreadonly: true\nignored: drop\n---\nBODY-cursor\n',
      ],
      ['opencode', '---\ndescription: OpenCode agent\nmode: subagent\n---\nBODY-opencode\n'],
    ]);

    for (const [app, content] of commandSources) {
      const row = APP_ROWS.find((candidate) => candidate.id === app)?.commands;
      assert.ok(row?.importer);
      const extension = row.importer.extensions[0] as string;
      write(path.join(row.dir(homes), `${app}${extension}`), content);
      const result = await runImport(app, undefined, {
        types: ['commands'],
        recursive: true,
        force: true,
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result.entries));
    }
    for (const [app, content] of agentSources) {
      const row = APP_ROWS.find((candidate) => candidate.id === app)?.agents;
      assert.ok(row?.importer);
      const extension = row.importer.extensions[0] as string;
      write(path.join(row.dir(homes), `${app}${extension}`), content);
      const result = await runImport(app, undefined, {
        types: ['agents'],
        recursive: true,
        force: true,
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result.entries));
    }

    const inventory = scanLibrary();
    for (const [type, sources] of [
      ['commands', commandSources],
      ['agents', agentSources],
    ] as const) {
      for (const app of sources.keys()) {
        const component = inventory.components.find(
          (candidate) => candidate.type === type && candidate.id === app
        );
        assert.ok(component, `${type}:${app}`);
        assert.ok(
          (component.metadata.extras as Record<string, unknown> | undefined)?.[app] !== undefined,
          `${type}:${app} keeps app-native fields under extras.${app}`
        );
        const row = APP_ROWS.find((candidate) => candidate.id === app)?.[type];
        const rendered = row?.render(component);
        assert.match(rendered ?? '', new RegExp(`BODY-${app}`));
      }
    }
  });
});

test('profile selection writes an explicit empty override without changing the user layer', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '# user\n[commands]\nenabled = ["inherited"]\n');

    editSelection({ type: 'commands', replace: [], profile: 'work' });

    assert.match(fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'), /inherited/);
    const profile = parseToml(fs.readFileSync(path.join(homes.asbHome, 'work.toml'), 'utf-8')) as {
      commands: { enabled: string[] };
    };
    assert.deepEqual(profile.commands.enabled, []);
    assert.deepEqual(loadConfig({ profile: 'work' }).selection.commands, []);
  });
});

test('the carried transform vocabulary and fixed pipeline remain complete', () => {
  const placeholder = 'INVENTED-PLACEHOLDER-9f3a';
  assert.deepEqual(applyDefaults({ a: 1 }, { a: 9, b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(joinFields({ tools: ['read', 'write'], keep: true }, { tools: ',' }), {
    tools: 'read,write',
    keep: true,
  });
  assert.deepEqual(omitFields({ a: 1, b: 2 }, ['b']), { a: 1 });
  assert.deepEqual(pickFields({ a: 1, b: 2 }, ['b']), { b: 2 });
  assert.deepEqual(renameFields({ allowed_tools: ['read'] }, { allowed_tools: 'allowed-tools' }), {
    'allowed-tools': ['read'],
  });
  assert.deepEqual(
    transformFrontmatter(
      { tools: ['read', 'write'], drop: true },
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
  const kv = envMapToKvArray({ TOKEN: placeholder }, 'name', 'value');
  assert.deepEqual(kv, [{ name: 'TOKEN', value: placeholder }]);
  assert.deepEqual(kvArrayToEnvMap(kv, 'name', 'value'), { TOKEN: placeholder });
  assert.deepEqual(
    transformMcpServer(
      { command: 'demo', env: { TOKEN: placeholder } },
      { envTransform: {}, defaults: { type: 'stdio' } }
    ),
    { command: 'demo', env: [{ key: 'TOKEN', value: placeholder }], type: 'stdio' }
  );
  assert.deepEqual(keyedArrayToRecord([{ name: 'demo', command: 'run' }], 'name'), {
    demo: { command: 'run' },
  });
  assert.throws(() => keyedArrayToRecord([{ command: 'run' }], 'name'), /missing identity/);
  assert.throws(
    () => keyedArrayToRecord([{ name: 'demo' }, { name: 'demo' }], 'name'),
    /duplicate identity/
  );
});

test('source-qualified duplicate native refs stay distinct in configuration', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '[applications.claude-code.native_plugins]\nenabled = ["codex@source-two"]\n'
    );
    assert.deepEqual(loadConfig().apps.overrides['claude-code']?.native_plugins?.enabled, [
      'codex@source-two',
    ]);
  });
});

test('custom command rows use the common exact-path planner and encoded filename', async () => {
  await withScratchHomes(async (homes) => {
    write(path.join(homes.asbHome, 'commands', 'pack:build.md'), 'Build.\n');
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
