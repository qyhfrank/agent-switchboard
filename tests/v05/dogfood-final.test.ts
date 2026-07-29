import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import { editSourceDeclaration } from '../../src/engine/config.js';
import { installApps, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

test('FD1 a selected plugin id no source provides is a visible missing row', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[plugins]\nenabled = ["ghost"]\n'
    );

    const status = await runSync({ dryRun: true });
    const gap = status.entries.find((entry) => entry.id === 'ghost');
    assert.ok(gap, JSON.stringify(status.entries, null, 2));
    assert.equal(gap.outcome, 'missing');
    assert.equal(status.exitCode, 1);

    const all = await runSync({ dryRun: true, all: true });
    assert.equal(
      all.entries.filter((entry) => entry.id === 'ghost' && entry.outcome === 'missing').length,
      1,
      JSON.stringify(
        all.entries.filter((entry) => entry.id === 'ghost'),
        null,
        2
      )
    );
  });
});

test('FD2 removing an unresolved source splices its spelled selections everywhere', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[applications.claude-code.native_plugins]',
        'enabled = [ "tool@ns" ]',
        '',
        '[plugins]',
        'enabled = [ "tool@ns" ]',
        '',
        '[plugins.sources]',
        `ns = { url = ${JSON.stringify(`file://${path.join(homes.root, 'gone.git')}`)}, type = "clone" }`,
        '',
      ].join('\n')
    );

    const { runRemoveSource } = await import('../../src/engine/cli.js');
    const report = await runRemoveSource('ns', {});
    assert.ok(report.entries.some((entry) => entry.id === 'ns' && entry.outcome === 'removed'));

    const config = fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8');
    assert.equal(config.includes('tool@ns'), false, config);
  });
});

test('FD3 removing a source table keeps the comment block of the next table', async () => {
  await withScratchHomes(async (homes) => {
    const configPath = path.join(homes.asbHome, 'config.toml');
    fs.mkdirSync(homes.asbHome, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        '[plugins.sources]',
        '',
        '    [plugins.sources.doomed]',
        '    url = "https://example.invalid/doomed.git"',
        '    type = "clone"',
        '',
        '    # Keeper: documents the keeper source below.',
        '    [plugins.sources.keeper]',
        '    url = "https://example.invalid/keeper.git"',
        '    type = "clone"',
        '',
      ].join('\n')
    );

    editSourceDeclaration({ namespace: 'doomed' });
    const after = fs.readFileSync(configPath, 'utf-8');
    assert.equal(after.includes('doomed'), false, after);
    assert.ok(after.includes('# Keeper: documents the keeper source below.'), after);
    assert.ok(after.includes('[plugins.sources.keeper]'), after);
  });
});

test('FD4 a plugin flat hook bundles its scripts and resolves the plugin-root placeholder', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = path.join(homes.asbHome, 'plugins', 'shop');
    fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'demo', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(source, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'shop', plugins: [{ name: 'demo', source: './demo' }] })
    );
    fs.writeFileSync(
      path.join(source, 'demo', 'hooks', 'myhook.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
              hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/helper.js"' }],
            },
          ],
        },
      })
    );
    fs.writeFileSync(path.join(source, 'demo', 'hooks', 'helper.js'), 'console.log("hi");\n');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["demo@shop"]',
        '',
        '[hooks]',
        'enabled = ["demo@shop:myhook"]',
        '',
        '[plugins.sources]',
        `shop = ${JSON.stringify(source)}`,
        '',
      ].join('\n')
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const settings = JSON.parse(
      fs.readFileSync(path.join(homes.agentsHome, '.claude', 'settings.json'), 'utf-8')
    ) as { hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] } };
    const command = settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command ?? '';
    assert.equal(command.includes('CLAUDE_PLUGIN_ROOT'), false, command);
    const bundled = path.join(
      homes.agentsHome,
      '.claude',
      'hooks',
      'managed',
      'demo@shop:myhook',
      'helper.js'
    );
    assert.ok(fs.existsSync(bundled), `expected bundled script at ${bundled}\ncommand: ${command}`);
    assert.match(command, /hooks\/managed\/demo@shop:myhook\/helper\.js/);
  });
});
