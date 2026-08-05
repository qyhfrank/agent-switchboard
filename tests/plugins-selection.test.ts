import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync, type SyncOptions } from '../src/engine/cli.js';
import {
  effectivePlugins,
  effectiveSelection,
  loadConfig,
  type ResolvedConfig,
  withPluginExpansion,
} from '../src/engine/config.js';
import { buildPluginExpansion, scanLibrary } from '../src/engine/library.js';
import { readSourceCatalog } from '../src/engine/sources.js';
import {
  installApps,
  ruleFilePath,
  type ScratchHomes,
  seedMarketplace,
  seedRule,
  seedSource,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The two selection channels: the global `enabled` list and the components an
 * enabled plugin expands to. What is load-bearing is the order — exclusion
 * applies to the expansion only, so an id the user enabled by hand outlives its
 * own plugin's exclusion, and every ref canonicalizes both on the way in and on
 * the way out.
 */

/** The configuration a run plans against: loaded, scanned, then expanded. */
function expanded(): ResolvedConfig {
  const config = loadConfig();
  const catalog = readSourceCatalog(config);
  const inventory = scanLibrary({ plugins: catalog.plugins });
  return withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));
}

test('an enabled plugin expands its components beside the global selection', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'core.md', '# Core\n');
    seedSource(homes, 'pack', { 'rules/style.md': '# Style\n' });
    seedSource(homes, 'other', { 'rules/tone.md': '# Tone\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[rules]',
        'enabled = ["core"]',
        '',
        '[plugins]',
        'enabled = ["pack", "other"]',
        '',
      ].join('\n')
    );

    const config = expanded();
    // Global first, then each plugin's contribution in the order the plugins
    // were enabled — not the order the sources happen to be discovered in.
    assert.deepEqual(effectiveSelection(config, 'claude-code', 'rules'), [
      'core',
      'pack:style',
      'other:tone',
    ]);
    // An enabled plugin expands for every enabled app, not just the first.
    assert.deepEqual(
      effectiveSelection(config, 'codex', 'rules'),
      effectiveSelection(config, 'claude-code', 'rules')
    );
    assert.deepEqual(effectivePlugins(config, 'codex'), ['pack', 'other']);
  });
});

test('exclusion filters the expansion only, so an explicit enable survives it', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'pack', { 'rules/style.md': '# Style\n', 'rules/tone.md': '# Tone\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["pack:style"]',
        '',
        '[plugins]',
        'enabled = ["pack"]',
        '',
        '[plugins.exclude]',
        'rules = ["pack:style", "pack:tone"]',
        '',
      ].join('\n')
    );

    // Both are excluded from the expansion; only the hand-enabled one remains.
    assert.deepEqual(effectiveSelection(expanded(), 'claude-code', 'rules'), ['pack:style']);
  });
});

test('a per-app override narrows the expansion for that app alone', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'pack', { 'rules/style.md': '# Style\n' });
    seedSource(homes, 'other', { 'rules/tone.md': '# Tone\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[applications.codex.plugins]',
        'remove = ["pack"]',
        '',
        '[applications.claude-code.rules]',
        'remove = ["other:tone"]',
        '',
        '[plugins]',
        'enabled = ["pack", "other"]',
        '',
      ].join('\n')
    );

    const config = expanded();
    assert.deepEqual(effectivePlugins(config, 'codex'), ['other']);
    assert.deepEqual(effectiveSelection(config, 'codex', 'rules'), ['other:tone']);
    // The per-app component override applies after the merge of both channels.
    assert.deepEqual(effectiveSelection(config, 'claude-code', 'rules'), ['pack:style']);
  });
});

test('a bare plugin name names its plugin while exactly one source carries it', async () => {
  await withScratchHomes(async (homes) => {
    seedMarketplace(homes, 'shop', 'shop', 'pack', { 'rules/style.md': '# Style\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[applications.claude-code.rules]',
        'add = ["pack:style"]',
        '',
        '[plugins]',
        'enabled = ["pack"]',
        '',
      ].join('\n')
    );

    const config = expanded();
    // Both the plugin ref and the component ref resolve to their canonical
    // source-qualified spelling, and the add is not a second entry.
    assert.deepEqual(effectivePlugins(config, 'claude-code'), ['pack@shop']);
    assert.deepEqual(effectiveSelection(config, 'claude-code', 'rules'), ['pack@shop:style']);
  });
});

test('an ambiguous bare name resolves to nothing rather than to one of its claimants', async () => {
  await withScratchHomes(async (homes) => {
    seedMarketplace(homes, 'shop', 'shop', 'pack', { 'rules/style.md': '# Shop style\n' });
    seedMarketplace(homes, 'mall', 'mall', 'pack', { 'rules/tone.md': '# Mall tone\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["pack"]',
        '',
      ].join('\n')
    );

    const config = expanded();
    assert.deepEqual(effectivePlugins(config, 'claude-code'), ['pack']);
    // Unresolved: it expands to nothing instead of picking a source at random.
    assert.deepEqual(effectiveSelection(config, 'claude-code', 'rules'), []);

    // Naming the source resolves it.
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["pack@mall"]',
        '',
      ].join('\n')
    );
    assert.deepEqual(effectiveSelection(expanded(), 'claude-code', 'rules'), ['pack@mall:tone']);
  });
});

test('a per-app plugin override is honored in either spelling of the ref', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex');
    seedRule(homes, 'core.md', 'LIBRARY RULE BODY\n');
    seedMarketplace(homes, 'shop', 'shop', 'pack', { 'rules/packed.md': 'PACK RULE BODY\n' });
    const removal = (enabled: string, removed: string): string =>
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[rules]',
        'enabled = ["core"]',
        '',
        '[plugins]',
        `enabled = ["${enabled}"]`,
        '',
        '[applications.codex.plugins]',
        `remove = ["${removed}"]`,
        '',
      ].join('\n');

    // The base list and the override are written in different spellings of
    // the same ref, which is the ergonomic form the bare name exists for.
    writeUserConfig(homes, removal('pack@shop', 'pack'));
    assert.deepEqual(effectivePlugins(expanded(), 'claude-code'), ['pack@shop']);
    assert.deepEqual(effectivePlugins(expanded(), 'codex'), []);

    writeUserConfig(homes, removal('pack', 'pack@shop'));
    assert.deepEqual(effectivePlugins(expanded(), 'codex'), []);

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const written = fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8');
    assert.match(written, /PACK RULE BODY/);
    assert.match(
      written,
      /LIBRARY RULE BODY/,
      'the expansion composes beside the global selection'
    );
    const codexTarget = ruleFilePath(homes, 'codex');
    const codexBody = fs.existsSync(codexTarget) ? fs.readFileSync(codexTarget, 'utf-8') : '';
    assert.doesNotMatch(codexBody, /PACK RULE BODY/, 'the removed plugin never reaches codex');
  });
});

test('a ref spelled as an inherited object key resolves to nothing, not a crash', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedRule(homes, 'house.md', '# House\n');
    // Alias lookups are ordinary property reads: on a plain object literal
    // these two names answer with a prototype member and every consumer of a
    // canonical ref gets an object or a function where an id belongs.
    for (const ref of ['__proto__', 'constructor']) {
      writeUserConfig(
        homes,
        ['[applications]', 'enabled = ["cursor"]', '', '[rules]', `enabled = ["${ref}"]`, ''].join(
          '\n'
        )
      );

      const report = await runSync({});

      assert.equal(
        report.entries.some((entry) => entry.outcome === 'missing' && entry.id === ref),
        true,
        ref
      );
    }
  });
});

test('a selected plugin ref no source provides is one visible missing row', async () => {
  const scenarios: {
    ref: string;
    /** Seeds the scratch tree and returns the options the run is made with. */
    prepare: (homes: ScratchHomes) => SyncOptions;
    /** Ids the row's reason must spell out. */
    spellings?: string[];
    scope?: string;
  }[] = [
    {
      ref: 'ghost',
      prepare: (homes) => {
        writeUserConfig(
          homes,
          '[applications]\nenabled = ["claude-code"]\n\n[plugins]\nenabled = ["ghost"]\n'
        );
        return {};
      },
    },
    {
      // Two sources claim the bare name, so the row has to name the spelling
      // that would disambiguate it rather than pick a claimant.
      ref: 'pack',
      spellings: ['pack@shop-a', 'pack@shop-b'],
      prepare: (homes) => {
        for (const namespace of ['shop-a', 'shop-b']) {
          seedMarketplace(homes, namespace, namespace, 'pack', {
            'commands/hi.toml': 'prompt = "hi"\n',
          });
        }
        writeUserConfig(
          homes,
          '[applications]\nenabled = ["claude-code"]\n\n[plugins]\nenabled = ["pack"]\n'
        );
        return {};
      },
    },
    {
      ref: 'ghost-app',
      prepare: (homes) => {
        writeUserConfig(
          homes,
          '[applications]\nenabled = ["claude-code"]\n\n[applications.claude-code.plugins]\nadd = ["ghost-app"]\n'
        );
        return {};
      },
    },
    {
      // Scoping a run to one namespace still shows the gap inside it.
      ref: 'ghost@ns',
      prepare: (homes) => {
        seedSource(homes, 'ns', {
          '.claude-plugin/marketplace.json': JSON.stringify({ name: 'ns', plugins: [] }),
        });
        writeUserConfig(
          homes,
          '[applications]\nenabled = ["claude-code"]\n\n[plugins]\nenabled = ["ghost@ns"]\n'
        );
        return { sources: ['ns'] };
      },
    },
    {
      ref: 'ghost-project',
      scope: 'project',
      prepare: (homes) => {
        const project = path.join(homes.root, 'project');
        fs.mkdirSync(project);
        fs.writeFileSync(
          path.join(project, '.asb.toml'),
          '[distribution.project]\nmode = "managed"\n\n[plugins]\nenabled = ["ghost-project"]\n'
        );
        writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
        return { project };
      },
    },
  ];

  for (const scenario of scenarios) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      const options = scenario.prepare(homes);

      // `--all` adds the inactive inventory; the gap stays one row either way.
      for (const all of [false, true]) {
        const report = await runSync({ dryRun: true, all, ...options });
        const rows = report.entries.filter(
          (entry) => entry.id === scenario.ref && entry.outcome === 'missing'
        );
        assert.equal(rows.length, 1, JSON.stringify(report.entries, null, 2));
        assert.equal(report.exitCode, 1, scenario.ref);
        if (scenario.scope) assert.equal(rows[0]?.scope, scenario.scope);
        for (const spelling of scenario.spellings ?? []) {
          assert.ok(rows[0]?.reason?.includes(spelling), rows[0]?.reason);
        }
      }
    });
  }
});
