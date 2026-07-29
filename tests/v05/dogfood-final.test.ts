import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import { editSourceDeclaration } from '../../src/engine/config.js';
import {
  gitFixtureCommand as git,
  installApps,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

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

function marketplaceSource(root: string, sourceName: string, pluginName: string): void {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, pluginName, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: sourceName,
      plugins: [{ name: pluginName, source: `./${pluginName}` }],
    })
  );
  fs.writeFileSync(path.join(root, pluginName, 'commands', 'hi.toml'), 'prompt = "hi"\n');
}

test('FD5 an ambiguous bare plugin selection is a visible missing row naming the spelling', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const shopA = path.join(homes.asbHome, 'plugins', 'shop-a');
    const shopB = path.join(homes.asbHome, 'plugins', 'shop-b');
    marketplaceSource(shopA, 'shop-a', 'pack');
    marketplaceSource(shopB, 'shop-b', 'pack');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["pack"]',
        '',
        '[plugins.sources]',
        `shop-a = ${JSON.stringify(shopA)}`,
        `shop-b = ${JSON.stringify(shopB)}`,
        '',
      ].join('\n')
    );

    const status = await runSync({ dryRun: true });
    const gap = status.entries.find((entry) => entry.id === 'pack' && entry.outcome === 'missing');
    assert.ok(gap, JSON.stringify(status.entries, null, 2));
    assert.match(gap.reason ?? '', /source/i);
    assert.match(gap.reason ?? '', /@/, 'the row must point at the name@source spelling');
    assert.equal(status.exitCode, 1);
  });
});

test('FD6 an app-scoped plugin selection with no provider is a visible missing row', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[applications.claude-code.plugins]',
        'add = ["ghost-app"]',
        '',
      ].join('\n')
    );

    const status = await runSync({ dryRun: true });
    const gap = status.entries.find((entry) => entry.id === 'ghost-app');
    assert.ok(gap, JSON.stringify(status.entries, null, 2));
    assert.equal(gap.outcome, 'missing');
    assert.equal(status.exitCode, 1);
  });
});

test('FD7 removing a source keeps an EOF comment that has no trailing newline', async () => {
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
        '    # keep-at-eof',
      ].join('\n')
    );

    editSourceDeclaration({ namespace: 'doomed' });
    const after = fs.readFileSync(configPath, 'utf-8');
    assert.equal(after.includes('doomed'), false, after);
    assert.ok(after.includes('# keep-at-eof'), after);
  });
});

test('FD8 --source scoping shows a gap row under its own namespace', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const empty = path.join(homes.asbHome, 'plugins', 'ns');
    fs.mkdirSync(path.join(empty, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(empty, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'ns', plugins: [] })
    );
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["ghost@ns"]',
        '',
        '[plugins.sources]',
        `ns = ${JSON.stringify(empty)}`,
        '',
      ].join('\n')
    );

    const scoped = await runSync({ dryRun: true, sources: ['ns'] });
    assert.ok(
      scoped.entries.some((entry) => entry.id === 'ghost@ns' && entry.outcome === 'missing'),
      JSON.stringify(scoped.entries, null, 2)
    );
  });
});

test('FD9 a pending-clone namespace suppresses gap rows for its own refs in dry-run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const repo = path.join(homes.root, 'src-repo');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], repo);
    marketplaceSource(repo, 'src', 'pack');
    git(['add', '-A'], repo);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo);
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["pack@src"]',
        '',
        '[plugins.sources.src]',
        `url = ${JSON.stringify(`file://${repo}`)}`,
        'type = "clone"',
        '',
      ].join('\n')
    );

    const dry = await runSync({ dryRun: true });
    assert.equal(
      dry.entries.some((entry) => entry.id === 'pack@src' && entry.outcome === 'missing'),
      false,
      JSON.stringify(dry.entries, null, 2)
    );
    assert.ok(
      dry.entries.some((entry) => entry.outcome === 'pending'),
      JSON.stringify(dry.entries, null, 2)
    );
    // Pending work is not an attention state: the exit vocabulary reserves 1
    // for failing outcomes, and the pending row itself names the next step.
    assert.equal(dry.exitCode, 0, JSON.stringify(dry.entries, null, 2));
  });
});
