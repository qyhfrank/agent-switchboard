import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import {
  effectivePlugins,
  effectiveSelection,
  loadConfig,
  type ResolvedConfig,
  withPluginExpansion,
} from '../../src/engine/config.js';
import { buildPluginExpansion, scanLibrary } from '../../src/engine/library.js';
import { readSourceCatalog } from '../../src/engine/sources.js';
import {
  installApps,
  ruleFilePath,
  type ScratchHomes,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The two selection channels, ported from the 0.4.35 plugins suite: the global
 * `enabled` list and the components an enabled plugin expands to. What is
 * load-bearing here is the order — exclusion applies to the expansion only, so
 * an id the user enabled by hand outlives its own plugin's exclusion, and every
 * ref canonicalizes both on the way in and on the way out.
 */

function seedSource(scratch: ScratchHomes, namespace: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(scratch.asbHome, 'plugins', namespace, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

/** A marketplace source whose single entry lives in a subdirectory. */
function seedMarketplace(
  scratch: ScratchHomes,
  namespace: string,
  marketplaceName: string,
  entry: string,
  files: Record<string, string>
): void {
  seedSource(scratch, namespace, {
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: marketplaceName,
      plugins: [{ name: entry, source: `./${entry}` }],
    }),
  });
  const prefixed: Record<string, string> = {};
  for (const [relative, content] of Object.entries(files)) {
    prefixed[path.join(entry, relative)] = content;
  }
  seedSource(scratch, namespace, prefixed);
}

/** The configuration a run plans against: loaded, scanned, then expanded. */
function expanded(): ResolvedConfig {
  const config = loadConfig();
  const catalog = readSourceCatalog(config);
  const inventory = scanLibrary({ plugins: catalog.plugins });
  return withPluginExpansion(config, buildPluginExpansion(catalog.plugins, inventory));
}

test('an enabled plugin expands its components beside the global selection', async () => {
  await withScratchHomes(async (scratch) => {
    seedRule(scratch, 'core.md', '# Core\n');
    seedSource(scratch, 'pack', { 'rules/style.md': '# Style\n' });
    seedSource(scratch, 'other', { 'rules/tone.md': '# Tone\n' });
    writeUserConfig(
      scratch,
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
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'pack', { 'rules/style.md': '# Style\n', 'rules/tone.md': '# Tone\n' });
    writeUserConfig(
      scratch,
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
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'pack', { 'rules/style.md': '# Style\n' });
    seedSource(scratch, 'other', { 'rules/tone.md': '# Tone\n' });
    writeUserConfig(
      scratch,
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
  await withScratchHomes(async (scratch) => {
    seedMarketplace(scratch, 'shop', 'shop', 'pack', { 'rules/style.md': '# Style\n' });
    writeUserConfig(
      scratch,
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
  await withScratchHomes(async (scratch) => {
    seedMarketplace(scratch, 'shop', 'shop', 'pack', { 'rules/style.md': '# Shop style\n' });
    seedMarketplace(scratch, 'mall', 'mall', 'pack', { 'rules/tone.md': '# Mall tone\n' });
    writeUserConfig(
      scratch,
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
      scratch,
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
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code', 'codex');
    seedMarketplace(scratch, 'shop', 'shop', 'pack', { 'rules/packed.md': 'PACK RULE BODY\n' });
    const removal = (enabled: string, removed: string): string =>
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
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
    writeUserConfig(scratch, removal('pack@shop', 'pack'));
    assert.deepEqual(effectivePlugins(expanded(), 'claude-code'), ['pack@shop']);
    assert.deepEqual(effectivePlugins(expanded(), 'codex'), []);

    writeUserConfig(scratch, removal('pack', 'pack@shop'));
    assert.deepEqual(effectivePlugins(expanded(), 'codex'), []);

    await runSync();
    assert.match(fs.readFileSync(ruleFilePath(scratch, 'claude-code'), 'utf-8'), /PACK RULE BODY/);
    const codexTarget = ruleFilePath(scratch, 'codex');
    const codexBody = fs.existsSync(codexTarget) ? fs.readFileSync(codexTarget, 'utf-8') : '';
    assert.doesNotMatch(codexBody, /PACK RULE BODY/, 'the removed plugin never reaches codex');
  });
});

test('a plugin rule reaches the app target through a real sync', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedRule(scratch, 'core.md', 'Be kind.\n');
    seedSource(scratch, 'pack', { 'rules/style.md': 'Be brief.\n' });
    writeUserConfig(
      scratch,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["core"]',
        '',
        '[plugins]',
        'enabled = ["pack"]',
        '',
      ].join('\n')
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const written = fs.readFileSync(ruleFilePath(scratch, 'claude-code'), 'utf-8');
    assert.match(written, /Be kind\./);
    assert.match(written, /Be brief\./);
  });
});
