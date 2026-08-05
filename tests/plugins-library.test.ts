import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../src/engine/cli.js';
import { loadConfig } from '../src/engine/config.js';
import { type LibraryInventory, scanLibrary } from '../src/engine/library.js';
import {
  type PluginDescriptor,
  readSourceCatalog,
  readSourcePlugins,
} from '../src/engine/sources.js';
import {
  seedSkill,
  seedSource,
  seedTree,
  skillDoc,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * What a source contributes to the library: plugin identity and id namespacing,
 * the offline catalog read, strict mode and custom component paths, and the
 * containment gates guarding both the entry source and the custom paths.
 */

const HOOK_DOC = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
});

function marketplace(entries: unknown[]): string {
  return JSON.stringify({ name: 'catalog', plugins: entries });
}

/** The inventory a run scans: the catalog first, then everything it resolves. */
function scan(): LibraryInventory {
  return scanLibrary({ plugins: readSourceCatalog(loadConfig()).plugins });
}

function idsOf(inventory: LibraryInventory, type: string): string[] {
  return inventory.components.filter((component) => component.type === type).map((c) => c.id);
}

test('a plugin source contributes its rules, skills and hooks under its own id', async () => {
  await withScratchHomes(async (homes) => {
    // Every basename here also exists in the library, so shadowing either way
    // would show up as a lost component or a duplicate.
    seedSkill(homes, 'deploy');
    seedTree(homes.asbHome, { 'rules/style.md': '# Library style\n' });
    seedSource(homes, 'pack', {
      'rules/style.md': '# Plugin style\n',
      'skills/deploy/SKILL.md': skillDoc('deploy'),
      'hooks/guard.json': HOOK_DOC,
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules'), ['pack:style', 'style']);
    assert.deepEqual(idsOf(inventory, 'skills'), ['deploy', 'pack:deploy']);
    assert.deepEqual(idsOf(inventory, 'hooks'), ['pack:guard']);
    for (const component of inventory.components) {
      assert.equal(component.source, component.id.startsWith('pack:') ? 'pack' : 'library');
    }
    assert.equal(
      inventory.components.find((component) => component.id === 'style')?.content.trim(),
      '# Library style'
    );
    assert.deepEqual(inventory.failed, []);
    assert.deepEqual(inventory.duplicates, []);
  });
});

test('a marketplace source contributes one plugin per catalogued entry', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'alpha', source: './alpha' },
        { name: 'beta', source: './packs/beta' },
      ]),
      'alpha/rules/one.md': '# One\n',
      'packs/beta/rules/two.md': '# Two\n',
    });
    // The same plugin name carried by two sources: the id keeps them apart.
    for (const namespace of ['left', 'right']) {
      seedSource(homes, namespace, {
        '.claude-plugin/marketplace.json': marketplace([{ name: 'pack', source: './pack' }]),
        'pack/rules/shared.md': `# ${namespace}\n`,
      });
    }

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules').sort(), [
      'alpha@shop:one',
      'beta@shop:two',
      'pack@left:shared',
      'pack@right:shared',
    ]);
    assert.deepEqual(inventory.components.map((component) => component.source).sort(), [
      'alpha@shop',
      'beta@shop',
      'pack@left',
      'pack@right',
    ]);
    assert.deepEqual(inventory.duplicates, []);
  });
});

test('a catalog naming one plugin twice keeps the first reading and reports the loser', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'pack', source: './first' },
        { name: 'pack', source: './second' },
      ]),
      'first/rules/shared.md': '# First\n',
      'second/rules/shared.md': '# Second\n',
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules'), ['pack@shop:shared']);
    const kept = inventory.components.find((component) => component.id === 'pack@shop:shared');
    assert.equal(kept?.content.trim(), '# First');
    assert.equal(inventory.duplicates.length, 1);
    assert.equal(inventory.duplicates[0]?.id, 'pack@shop:shared');
    assert.equal(inventory.duplicates[0]?.source, 'pack@shop');
    assert.equal(inventory.duplicates[0]?.keptSource, 'pack@shop');
    assert.match(inventory.duplicates[0]?.path ?? '', /second/);
  });
});

test('a catalogued plugin name must encode one child path segment', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([{ name: '../escape', source: './demo' }]),
      'demo/rules/one.md': '# One\n',
    });

    const catalog = readSourceCatalog(loadConfig());

    // The name becomes both a path segment and half of every component id.
    assert.deepEqual(catalog.plugins, []);
    assert.ok(catalog.failed.some((failure) => /one path segment/i.test(failure.error)));
    assert.deepEqual(scan().components, []);
  });
});

test('a catalog entry overrides the plugin manifest, and strict:false inverts that', async () => {
  await withScratchHomes(async (homes) => {
    const root = seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        {
          name: 'strict',
          source: './pack',
          description: 'from the entry',
          version: '1.0.0',
          mcpServers: { fromEntry: { command: 'entry' } },
        },
        { name: 'loose', source: './pack', strict: false },
      ]),
      'pack/.claude-plugin/plugin.json': JSON.stringify({
        name: 'pack',
        description: 'from the manifest',
        version: '2.0.0',
        mcpServers: { fromManifest: { command: 'manifest' } },
      }),
    });

    const plugins = readSourcePlugins(loadConfig().homes, 'shop', root).plugins;
    const strict = plugins.find((plugin) => plugin.name === 'strict');
    const loose = plugins.find((plugin) => plugin.name === 'loose');

    assert.equal(strict?.description, 'from the entry');
    assert.equal(strict?.version, '1.0.0');
    assert.deepEqual(Object.keys(strict?.mcpServers ?? {}), ['fromEntry']);

    // Non-strict falls back to the manifest for component data; description
    // and version stay the entry's when it states them.
    assert.deepEqual(Object.keys(loose?.mcpServers ?? {}), ['fromManifest']);
    assert.equal(loose?.description, 'from the manifest');
  });
});

test('custom skills paths replace the default scan and may name a bundle or its SKILL.md', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'pack', source: './pack', skills: ['extra', 'solo', 'direct/SKILL.md'] },
      ]),
      'pack/skills/ignored/SKILL.md': skillDoc('ignored'),
      'pack/extra/one/SKILL.md': skillDoc('one'),
      'pack/extra/two/SKILL.md': skillDoc('two'),
      'pack/solo/SKILL.md': skillDoc('solo'),
      'pack/direct/SKILL.md': skillDoc('direct'),
    });

    // The declared paths replace skills/, which stops being scanned at all.
    assert.deepEqual(idsOf(scan(), 'skills').sort(), [
      'pack@shop:direct',
      'pack@shop:one',
      'pack@shop:solo',
      'pack@shop:two',
    ]);
  });
});

test('plugin command and agent paths keep the namespace and name a file or a directory', async () => {
  await withScratchHomes(async (homes) => {
    const root = seedTree(path.join(homes.root, 'plugin'), {
      'entry/ship.md': 'Ship it.\n',
      'personas/check.md': 'Check it.\n',
    });
    const plugin: PluginDescriptor = {
      id: 'pack@shop',
      name: 'pack',
      source: 'shop',
      root,
      customPaths: { commands: ['entry/ship.md'], agents: ['personas'] },
    };

    const inventory = scanLibrary({ plugins: [plugin] });

    assert.deepEqual(
      inventory.components
        .filter((component) => component.type === 'commands' || component.type === 'agents')
        .map((component) => `${component.type}:${component.id}`),
      ['agents:pack@shop:check', 'commands:pack@shop:ship']
    );
  });
});

test('a custom component path cannot leave the plugin root, lexically or through a link', async () => {
  await withScratchHomes(async (homes) => {
    const outside = seedTree(path.join(homes.root, 'outside'), {
      'secret/SKILL.md': skillDoc('secret'),
    });
    const root = seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'up', source: './pack', skills: ['../../../outside'] },
        { name: 'absolute', source: './pack', skills: [outside] },
        { name: 'linked', source: './pack', skills: ['escape'] },
      ]),
      'pack/keep.md': 'placeholder\n',
    });
    fs.symlinkSync(outside, path.join(root, 'pack', 'escape'));

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'skills'), []);
    assert.deepEqual(inventory.failed.map((failure) => failure.id).sort(), [
      'absolute@shop',
      'linked@shop',
      'up@shop',
    ]);
    for (const failure of inventory.failed) {
      assert.match(failure.error, /must be relative|escapes the plugin root/);
    }
  });
});

test('a catalog entry cannot point outside its own marketplace root', async () => {
  await withScratchHomes(async (homes) => {
    const outside = seedTree(path.join(homes.root, 'outside'), { 'rules/leak.md': '# Leak\n' });
    const root = seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'up', source: '../../outside' },
        { name: 'linked', source: './link' },
      ]),
    });
    fs.symlinkSync(outside, path.join(root, 'link'));

    const catalog = readSourceCatalog(loadConfig());

    assert.deepEqual(catalog.plugins, []);
    assert.equal(catalog.failed.length, 2);
    for (const failure of catalog.failed) {
      assert.equal(failure.namespace, 'shop');
      assert.match(failure.error, /escapes the marketplace root/);
    }
    assert.deepEqual(scan().components, []);
  });
});

test('a plugin root reached through a configured source keeps its native manifest metadata', async () => {
  await withScratchHomes(async (homes) => {
    const root = seedTree(path.join(homes.root, 'native-src'), {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'openai-codex', version: '0.1.0' }),
      'rules/native.md': '# Native\n',
    });
    writeUserConfig(homes, `[plugins.sources]\ncodex = "${root}"\n`);

    const catalog = readSourceCatalog(loadConfig());

    assert.equal(catalog.plugins.length, 1);
    assert.equal(catalog.plugins[0]?.id, 'codex');
    assert.equal(catalog.plugins[0]?.name, 'openai-codex');
    assert.equal(catalog.plugins[0]?.native?.target, 'claude-code');
    assert.deepEqual(idsOf(scan(), 'rules'), ['codex:native']);
  });
});

test('a foreign hook file is skipped inside a plugin but read in the library', async () => {
  await withScratchHomes(async (homes) => {
    const foreign = JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ type: 'command', bash: 'echo hi' }] },
    });
    seedSource(homes, 'pack', {
      'hooks/foreign.json': foreign,
      'hooks/broken.json': JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] },
      }),
      'hooks/bundle/hook.json': '{ not json',
      'hooks/good.json': HOOK_DOC,
    });
    // The library holds no foreign dialects, so the same file is a broken
    // portable hook there rather than something to walk past.
    seedTree(homes.asbHome, { 'hooks/foreign.json': foreign });

    const inventory = scan();

    // One bad entry never takes its neighbours with it.
    assert.deepEqual(idsOf(inventory, 'hooks'), ['pack:good']);
    assert.deepEqual(inventory.failed.map((failure) => failure.id).sort(), [
      'foreign',
      'pack:broken',
      'pack:bundle',
    ]);
    assert.deepEqual(inventory.failed.map((failure) => failure.source).sort(), [
      'library',
      'pack',
      'pack',
    ]);
  });
});

test('a source and its catalogued plugin are inventory rows with no components of their own', async () => {
  await withScratchHomes(async (homes) => {
    const source = seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([{ name: 'empty', source: './empty' }]),
      'empty/.claude-plugin/plugin.json': JSON.stringify({ name: 'empty', version: '1.0.0' }),
    });
    writeUserConfig(homes, '[applications]\nenabled = []\n');

    const all = await runSync({ dryRun: true, all: true });
    assert.ok(
      all.entries.some(
        (entry) => entry.type === 'plugins' && entry.id === 'shop' && entry.path === source
      ),
      JSON.stringify(all.entries, null, 2)
    );
    assert.ok(all.entries.some((entry) => entry.type === 'plugins' && entry.id === 'empty@shop'));

    const typed = await runSync({ dryRun: true, types: ['plugins'] });
    assert.ok(typed.entries.some((entry) => entry.id === 'shop'));
    assert.ok(typed.entries.some((entry) => entry.id === 'empty@shop'));
    assert.ok((await runExplain('shop')).slices.length > 0);
    assert.ok((await runExplain('empty@shop')).slices.length > 0);
  });
});
