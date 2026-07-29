import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/engine/config.js';
import { entriesRoot } from '../../src/engine/entries.js';
import { type LibraryInventory, scanLibrary } from '../../src/engine/library.js';
import {
  materializeSourceEntries,
  readSourceCatalog,
  readSourcePlugins,
} from '../../src/engine/sources.js';
import {
  commitAndPush,
  createGitFixture,
  type ScratchHomes,
  seedSkill,
  withScratchHomes,
  writeFixtureFile,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * What a source contributes to the library, ported from the 0.4.35 plugins
 * suite: plugin identity and id namespacing, the offline catalog read, strict
 * mode and custom component paths, the containment defenses around both, and
 * the hook-file tolerance a plugin's hooks/ directory needs.
 */

/** Write a tree of files under one root, creating parents. */
function seedTree(root: string, files: Record<string, string>): string {
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return root;
}

/** A source directory the library discovers by presence. */
function seedSource(
  scratch: ScratchHomes,
  namespace: string,
  files: Record<string, string>
): string {
  return seedTree(path.join(scratch.asbHome, 'plugins', namespace), files);
}

function skillDoc(name: string, description = `${name} does a thing`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;
}

const HOOK_DOC = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
});

function marketplace(entries: unknown[], metadata?: Record<string, unknown>): string {
  return JSON.stringify({ name: 'catalog', ...(metadata ? { metadata } : {}), plugins: entries });
}

function scan(): LibraryInventory {
  return scanLibrary({ plugins: readSourceCatalog(loadConfig()).plugins });
}

function idsOf(inventory: LibraryInventory, type: string): string[] {
  return inventory.components.filter((c) => c.type === type).map((c) => c.id);
}

test('a plugin source contributes its rules, skills and hooks under its own id', async () => {
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'pack', {
      'rules/style.md': '# Style\n',
      'skills/deploy/SKILL.md': skillDoc('deploy'),
      'hooks/guard.json': HOOK_DOC,
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules'), ['pack:style']);
    assert.deepEqual(idsOf(inventory, 'skills'), ['pack:deploy']);
    assert.deepEqual(idsOf(inventory, 'hooks'), ['pack:guard']);
    for (const component of inventory.components) assert.equal(component.source, 'pack');
    assert.deepEqual(inventory.failed, []);
  });
});

test('library content and plugin content coexist without either shadowing the other', async () => {
  await withScratchHomes(async (scratch) => {
    seedSkill(scratch, 'deploy');
    seedTree(scratch.asbHome, { 'rules/style.md': '# Library style\n' });
    seedSource(scratch, 'pack', {
      'rules/style.md': '# Plugin style\n',
      'skills/deploy/SKILL.md': skillDoc('deploy'),
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules'), ['pack:style', 'style']);
    assert.deepEqual(idsOf(inventory, 'skills'), ['deploy', 'pack:deploy']);
    assert.deepEqual(inventory.duplicates, []);
    const library = inventory.components.find((c) => c.id === 'style');
    assert.equal(library?.content.trim(), '# Library style');
  });
});

test('a marketplace source contributes one plugin per catalogued entry', async () => {
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'alpha', source: './alpha' },
        { name: 'beta', source: './packs/beta' },
      ]),
      'alpha/rules/one.md': '# One\n',
      'packs/beta/rules/two.md': '# Two\n',
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules'), ['alpha@shop:one', 'beta@shop:two']);
    assert.deepEqual(
      inventory.components.map((c) => c.source),
      ['alpha@shop', 'beta@shop']
    );
  });
});

test('same-name plugins from different sources keep distinct component ids', async () => {
  await withScratchHomes(async (scratch) => {
    for (const namespace of ['left', 'right']) {
      seedSource(scratch, namespace, {
        '.claude-plugin/marketplace.json': marketplace([{ name: 'pack', source: './pack' }]),
        'pack/rules/shared.md': `# ${namespace}\n`,
      });
    }

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules').sort(), ['pack@left:shared', 'pack@right:shared']);
    assert.deepEqual(inventory.duplicates, []);
  });
});

test('a catalog naming one plugin twice keeps the first reading and reports the loser', async () => {
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'pack', source: './first' },
        { name: 'pack', source: './second' },
      ]),
      'first/rules/shared.md': '# First\n',
      'second/rules/shared.md': '# Second\n',
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'rules'), ['pack@shop:shared']);
    const kept = inventory.components.find((c) => c.id === 'pack@shop:shared');
    assert.equal(kept?.content.trim(), '# First');
    assert.equal(inventory.duplicates.length, 1);
    assert.equal(inventory.duplicates[0]?.id, 'pack@shop:shared');
    assert.equal(inventory.duplicates[0]?.source, 'pack@shop');
    assert.equal(inventory.duplicates[0]?.keptSource, 'pack@shop');
    assert.match(inventory.duplicates[0]?.path ?? '', /second/);
  });
});

test('an external entry stays offline until something fetches it', async () => {
  await withScratchHomes(async (scratch) => {
    const fixture = createGitFixture(scratch.root, 'external');
    writeFixtureFile(fixture, 'rules/remote.md', '# Remote\n');
    commitAndPush(fixture, 'add rule');

    seedSource(scratch, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'ext', source: { url: fixture.bareRepo, ref: 'main' } },
      ]),
    });

    const config = loadConfig();
    const before = readSourceCatalog(config);
    assert.equal(before.plugins.length, 1);
    assert.equal(before.plugins[0]?.root, undefined);
    assert.ok(before.plugins[0]?.request, 'the entry is catalogued with what would fetch it');

    // The scan resolves no content and leaves no cache behind: reading a
    // catalog must never pay for a plugin nobody selected.
    assert.deepEqual(scan().components, []);
    assert.equal(fs.existsSync(entriesRoot(config.homes)), false);

    const results = materializeSourceEntries(config.homes, before.plugins);
    assert.deepEqual(results, [{ id: 'ext@shop' }]);

    assert.deepEqual(idsOf(scan(), 'rules'), ['ext@shop:remote']);
  });
});

test('a Copilot hook file in a plugin is skipped, and a broken portable hook fails alone', async () => {
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'pack', {
      'hooks/copilot.json': JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ type: 'command', bash: 'echo hi' }] },
      }),
      'hooks/broken.json': JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] },
      }),
      'hooks/bundle/hook.json': '{ not json',
      'hooks/good.json': HOOK_DOC,
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'hooks'), ['pack:good']);
    assert.deepEqual(inventory.failed.map((failure) => failure.id).sort(), [
      'pack:broken',
      'pack:bundle',
    ]);
    for (const failure of inventory.failed) assert.equal(failure.source, 'pack');
  });
});

test('a Copilot hook file in the library is still read as a broken portable hook', async () => {
  await withScratchHomes(async (scratch) => {
    seedTree(scratch.asbHome, {
      'hooks/copilot.json': JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ type: 'command', bash: 'echo hi' }] },
      }),
    });

    const inventory = scan();

    assert.deepEqual(idsOf(inventory, 'hooks'), []);
    assert.deepEqual(
      inventory.failed.map((failure) => failure.id),
      ['copilot']
    );
  });
});

test('a catalog entry overrides the plugin manifest, and strict:false inverts that', async () => {
  await withScratchHomes(async (scratch) => {
    const manifest = JSON.stringify({
      name: 'pack',
      description: 'from the manifest',
      version: '2.0.0',
      mcpServers: { fromManifest: { command: 'manifest' } },
    });
    const root = seedSource(scratch, 'shop', {
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
      'pack/.claude-plugin/plugin.json': manifest,
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
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        {
          name: 'pack',
          source: './pack',
          skills: ['extra', 'solo', 'direct/SKILL.md'],
        },
      ]),
      'pack/skills/ignored/SKILL.md': skillDoc('ignored'),
      'pack/extra/one/SKILL.md': skillDoc('one'),
      'pack/extra/two/SKILL.md': skillDoc('two'),
      'pack/solo/SKILL.md': skillDoc('solo'),
      'pack/direct/SKILL.md': skillDoc('direct'),
    });

    assert.deepEqual(idsOf(scan(), 'skills').sort(), [
      'pack@shop:direct',
      'pack@shop:one',
      'pack@shop:solo',
      'pack@shop:two',
    ]);
  });
});

test('a custom component path cannot leave the plugin root, lexically or through a link', async () => {
  await withScratchHomes(async (scratch) => {
    const outside = path.join(scratch.root, 'outside');
    seedTree(outside, { 'secret/SKILL.md': skillDoc('secret') });
    const root = seedSource(scratch, 'shop', {
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
  await withScratchHomes(async (scratch) => {
    seedTree(path.join(scratch.root, 'outside'), { 'rules/leak.md': '# Leak\n' });
    seedSource(scratch, 'shop', {
      '.claude-plugin/marketplace.json': marketplace([
        { name: 'up', source: '../../outside' },
        { name: 'linked', source: './link' },
      ]),
    });
    fs.symlinkSync(
      path.join(scratch.root, 'outside'),
      path.join(scratch.asbHome, 'plugins', 'shop', 'link')
    );

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
  await withScratchHomes(async (scratch) => {
    const root = seedTree(path.join(scratch.root, 'native-src'), {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'openai-codex', version: '0.1.0' }),
      'rules/native.md': '# Native\n',
    });
    writeUserConfig(scratch, `[plugins.sources]\ncodex = "${root}"\n`);

    const catalog = readSourceCatalog(loadConfig());

    assert.equal(catalog.plugins.length, 1);
    assert.equal(catalog.plugins[0]?.id, 'codex');
    assert.equal(catalog.plugins[0]?.name, 'openai-codex');
    assert.equal(catalog.plugins[0]?.native?.target, 'claude-code');
    assert.deepEqual(idsOf(scan(), 'rules'), ['codex:native']);
  });
});

test('an unreadable source is reported and never silently contributes nothing', async () => {
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'shop', { '.claude-plugin/marketplace.json': '{ not json' });
    seedSource(scratch, 'healthy', { 'rules/fine.md': '# Fine\n' });

    const catalog = readSourceCatalog(loadConfig());

    assert.equal(catalog.failed.length, 1);
    assert.equal(catalog.failed[0]?.namespace, 'shop');
    assert.match(catalog.failed[0]?.error ?? '', /marketplace manifest is unreadable/);
    assert.deepEqual(idsOf(scan(), 'rules'), ['healthy:fine']);
  });
});
