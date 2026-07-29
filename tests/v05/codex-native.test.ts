import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows } from '../../src/engine/apps.js';
import { loadConfig } from '../../src/engine/config.js';
import {
  applyNative,
  captureNative,
  type NativeCommandRunner,
  planNative,
} from '../../src/engine/native.js';
import { readSourceCatalog } from '../../src/engine/sources.js';
import { withScratchHomes, writeUserConfig } from './helpers/scratch.js';

function seedBarePlugin(asbHome: string): string {
  const root = path.join(asbHome, 'plugins', 'bare');
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.codex-plugin', 'plugin.json'),
    '{"name":"demo","version":"1.0.0"}\n',
    'utf-8'
  );
  fs.writeFileSync(path.join(root, 'README.md'), 'Demo.\n', 'utf-8');
  return root;
}

function configText(enabled: string[]): string {
  return [
    '[applications]',
    'enabled = ["codex"]',
    'assume_installed = ["codex"]',
    '',
    '[applications.codex.native_plugins]',
    `enabled = ${JSON.stringify(enabled)}`,
    '',
  ].join('\n');
}

test('bare Codex plugins materialize an ASB wrapper and use the probed verb sequence', async () => {
  await withScratchHomes(async (homes) => {
    const source = seedBarePlugin(homes.asbHome);
    writeUserConfig(homes, configText(['bare']));
    const config = loadConfig();
    const table = appRows(config);
    const catalog = readSourceCatalog(config);
    const captureCalls: string[][] = [];
    const captureRunner: NativeCommandRunner = (_bin, args) => {
      captureCalls.push([...args]);
      return { status: 0, stdout: '{"marketplaces":[]}\n', stderr: '' };
    };
    const captured = captureNative(
      config,
      catalog,
      table,
      process.env,
      { codex: true },
      false,
      captureRunner
    );
    assert.deepEqual(captureCalls, [['plugin', 'marketplace', 'list', '--json']]);

    const actions = planNative({
      config,
      catalog,
      capture: captured,
      table,
      env: process.env,
      installed: { codex: true },
      dryRun: false,
    });
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].native?.commands, [
      [
        'plugin',
        'marketplace',
        'add',
        path.join(homes.asbHome, 'state', 'native-plugins', 'codex', 'bare'),
        '--json',
      ],
      ['plugin', 'list', '--marketplace', 'bare', '--json'],
      ['plugin', 'add', 'demo@bare', '--json'],
    ]);

    const applyCalls: string[][] = [];
    const applyRunner: NativeCommandRunner = (_bin, args) => {
      applyCalls.push([...args]);
      return { status: 0, stdout: '{}\n', stderr: '' };
    };
    assert.equal(
      applyNative(actions[0].native as NonNullable<(typeof actions)[0]['native']>, applyRunner),
      undefined
    );
    assert.deepEqual(applyCalls, actions[0].native?.commands);
    const wrapper = path.join(homes.asbHome, 'state', 'native-plugins', 'codex', 'bare');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(wrapper, '.agents', 'plugins', 'marketplace.json'), 'utf-8')
    ) as { name: string; plugins: { name: string; source: string }[] };
    assert.deepEqual(manifest, {
      name: 'bare',
      plugins: [{ name: 'demo', source: './plugins/demo' }],
    });
    assert.equal(fs.realpathSync(path.join(wrapper, 'plugins', 'demo')), fs.realpathSync(source));
  });
});

test('Codex dry-run invokes no CLI and materializes no wrapper', async () => {
  await withScratchHomes(async (homes) => {
    seedBarePlugin(homes.asbHome);
    writeUserConfig(homes, configText(['bare']));
    const config = loadConfig();
    const table = appRows(config);
    const catalog = readSourceCatalog(config);
    let calls = 0;
    const runner: NativeCommandRunner = () => {
      calls++;
      throw new Error('dry-run must not invoke Codex');
    };
    const captured = captureNative(
      config,
      catalog,
      table,
      process.env,
      { codex: true },
      true,
      runner
    );
    const actions = planNative({
      config,
      catalog,
      capture: captured,
      table,
      env: process.env,
      installed: { codex: true },
      dryRun: true,
    });
    assert.equal(calls, 0);
    assert.equal(actions[0].outcome, 'written');
    assert.equal(actions[0].native, undefined);
    assert.equal(
      fs.existsSync(path.join(homes.asbHome, 'state', 'native-plugins', 'codex')),
      false
    );
  });
});

test('Codex refuses a foreign same-name marketplace and removes a deselected ASB wrapper', async () => {
  await withScratchHomes(async (homes) => {
    seedBarePlugin(homes.asbHome);
    writeUserConfig(homes, configText(['bare']));
    const config = loadConfig();
    const table = appRows(config);
    const catalog = readSourceCatalog(config);
    const foreign: NativeCommandRunner = (_bin, args) => ({
      status: 0,
      stdout:
        args[1] === 'marketplace'
          ? '{"marketplaces":[{"name":"bare","root":"/foreign"}]}'
          : '{"installed":[]}',
      stderr: '',
    });
    const foreignCapture = captureNative(
      config,
      catalog,
      table,
      process.env,
      { codex: true },
      false,
      foreign
    );
    const refused = planNative({
      config,
      catalog,
      capture: foreignCapture,
      table,
      env: process.env,
      installed: { codex: true },
      dryRun: false,
    });
    assert.equal(refused[0].outcome, 'conflict');
    assert.match(refused[0].reason ?? '', /different source/);

    const wrapper = path.join(homes.asbHome, 'state', 'native-plugins', 'codex', 'bare');
    fs.mkdirSync(path.join(wrapper, '.agents', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(wrapper, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(wrapper, '.agents', 'plugins', 'marketplace.json'),
      '{"name":"bare","plugins":[{"name":"demo","source":"./plugins/demo"}]}\n',
      'utf-8'
    );
    fs.symlinkSync(
      path.join(homes.asbHome, 'plugins', 'bare'),
      path.join(wrapper, 'plugins', 'demo'),
      'dir'
    );
    writeUserConfig(homes, configText([]));
    const retiredConfig = loadConfig();
    const retiredTable = appRows(retiredConfig);
    let managerCalls = 0;
    const manager: NativeCommandRunner = (_bin, args) => {
      managerCalls++;
      return {
        status: 0,
        stdout:
          args[1] === 'marketplace'
            ? JSON.stringify({ marketplaces: [{ name: 'bare', root: wrapper }] })
            : '{"installed":[{"id":"demo@bare","enabled":true,"version":"1.0.0"}]}',
        stderr: '',
      };
    };
    const retiredCapture = captureNative(
      retiredConfig,
      readSourceCatalog(retiredConfig),
      retiredTable,
      process.env,
      { codex: true },
      false,
      manager
    );
    const retired = planNative({
      config: retiredConfig,
      catalog: readSourceCatalog(retiredConfig),
      capture: retiredCapture,
      table: retiredTable,
      env: process.env,
      installed: { codex: true },
      dryRun: false,
    });
    assert.equal(retired[0].outcome, 'removed');
    assert.deepEqual(retired[0].native?.commands, [
      ['plugin', 'remove', 'demo@bare', '--json'],
      ['plugin', 'marketplace', 'remove', 'bare', '--json'],
    ]);
    assert.equal(
      applyNative(retired[0].native as NonNullable<(typeof retired)[0]['native']>, manager),
      undefined
    );
    assert.equal(fs.existsSync(wrapper), false);
    managerCalls = 0;
    captureNative(
      retiredConfig,
      readSourceCatalog(retiredConfig),
      retiredTable,
      process.env,
      { codex: true },
      false,
      manager
    );
    assert.equal(managerCalls, 0, 'an empty state root does not keep Codex capture active');
  });
});
