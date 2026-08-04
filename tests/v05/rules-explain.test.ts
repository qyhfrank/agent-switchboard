import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../../src/engine/cli.js';
import type { ExplainSlice } from '../../src/engine/plan.js';
import { renderExplain } from '../../src/engine/report.js';
import {
  installApps,
  ruleFilePath,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const CONFIG = `
[applications]
enabled = ["claude-code", "codex"]

[rules]
enabled = ["base"]
`;

test('explain by component id joins every slice with owner, hashes, and desired bytes', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CONFIG);
    installApps(homes, 'claude-code', 'codex');
    await runSync();

    const { slices } = await runExplain('base');
    assert.deepEqual(slices.map((slice) => slice.app).sort(), ['claude-code', 'codex']);
    for (const slice of slices) {
      assert.equal(slice.outcome, 'unchanged');
      assert.equal(slice.provenance, 'marker');
      assert.equal(slice.currentHash, slice.desiredHash);
      assert.equal(slice.desired, fs.readFileSync(slice.path as string, 'utf-8'));
      assert.deepEqual(slice.components, [
        { id: 'base', path: path.join(homes.asbHome, 'rules', 'base.md') },
      ]);
    }
  });
});

test('explain matches app ids and path basenames to single slices', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CONFIG);
    installApps(homes, 'claude-code', 'codex');

    const { slices: byApp } = await runExplain('codex');
    assert.equal(byApp.length, 1);
    assert.equal(byApp[0].path, ruleFilePath(homes, 'codex'));

    const { slices: byPath } = await runExplain('CLAUDE.md');
    assert.equal(byPath.length, 1);
    assert.equal(byPath[0].app, 'claude-code');
    assert.equal(byPath[0].provenance, null, 'nothing synced yet: nothing proves the slice');
    assert.equal(byPath[0].currentHash, null, 'target file absent');
    assert.notEqual(byPath[0].desiredHash, null);
  });
});

test('explain shows an enabled-but-undetected app as skipped, never invents a plan', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[rules]\nenabled = ["base"]\n');

    const { slices } = await runExplain('cursor');
    assert.equal(slices.length, 1);
    assert.equal(slices[0].outcome, 'skipped');
    assert.equal(slices[0].detail, 'app-not-installed');
    assert.equal(slices[0].path, null);
    assert.equal(slices[0].provenance, null);
    assert.equal(slices[0].desired, null);

    assert.deepEqual((await runExplain('nope')).slices, []);
  });
});

test('renderExplain names the miss and renders matched slices with desired content', () => {
  assert.match(renderExplain([], 'nope'), /nothing matches "nope"/i);

  const slice: ExplainSlice = {
    app: 'codex',
    path: '/x/.codex/AGENTS.md',
    outcome: 'unchanged',
    provenance: 'marker',
    currentHash: 'a'.repeat(64),
    desiredHash: 'a'.repeat(64),
    desired: 'Always be kind.\n',
    components: [{ id: 'base', path: '/lib/rules/base.md' }],
  };
  const text = renderExplain([slice], 'base');
  assert.match(text, /owner: marker\n/);
  assert.match(text, /base {2}\/lib\/rules\/base\.md/);
  assert.match(text, /--- desired content \(codex\) ---/);
  assert.match(text, /Always be kind\./);
});
