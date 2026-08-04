import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../../src/engine/cli.js';
import { renderReport } from '../../src/engine/report.js';
import { bundleFingerprint } from '../../src/engine/shapes.js';
import {
  installApps,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Status and explain over the skills cell. Status is the same reconciliation
 * with the writer disabled, so a seeded drift shows up by name before any
 * write happens — the M2 exit fixture.
 */

function baseConfig(skills: readonly string[]): string {
  const list = skills.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = ["claude-code"]\n\n[skills]\nenabled = [${list}]\n`;
}

test('status names a drifted skill as a pending rewrite without touching it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSkill(homes, 'review-pr', { files: { 'references/checklist.md': 'be kind\n' } });
    writeUserConfig(homes, baseConfig(['review-pr']));

    await runSync();
    const target = path.join(skillsParentDir(homes, 'claude-code'), 'review-pr');
    const stale = path.join(target, 'references', 'checklist.md');
    fs.writeFileSync(stale, 'drifted by hand\n');

    const status = await runSync({ dryRun: true });

    const entry = status.entries.find(
      (candidate) => candidate.type === 'skills' && candidate.id === 'review-pr'
    );
    assert.equal(entry?.outcome, 'written', 'status names the drift');
    assert.equal(entry?.detail, 'updated');
    assert.equal(entry?.path, target);
    assert.equal(status.exitCode, 0, 'a rewrite the library will do is not a failure');
    assert.equal(fs.readFileSync(stale, 'utf-8'), 'drifted by hand\n', 'status writes nothing');

    const rendered = renderReport(status);
    assert.match(rendered, /review-pr/);
    assert.match(rendered, /written \(updated\)/);
  });
});

test('explain by skill id joins the live tree and its source bundle', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSkill(homes, 'review-pr');
    writeUserConfig(homes, baseConfig(['review-pr']));
    await runSync();

    const target = path.join(skillsParentDir(homes, 'claude-code'), 'review-pr');
    const { slices } = await runExplain('review-pr');

    assert.equal(slices.length, 1);
    const slice = slices[0];
    assert.equal(slice.app, 'claude-code');
    assert.equal(slice.path, target);
    assert.equal(slice.outcome, 'unchanged');
    assert.equal(slice.provenance, 'identity');
    assert.equal(slice.currentHash, bundleFingerprint(target));
    assert.deepEqual(
      slices[0].components.map((component) => component.id),
      ['review-pr']
    );
    assert.equal(slice.components[0]?.path, source);
  });
});

test('explain matches a skill by target path basename and by app id', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSkill(homes, 'review-pr');
    writeUserConfig(homes, baseConfig(['review-pr']));
    await runSync();

    const { slices: byPath } = await runExplain('skills/review-pr');
    assert.equal(byPath.length, 1, 'a path suffix matches the bundle dir');
    assert.equal(byPath[0].app, 'claude-code');

    const { slices: byApp } = await runExplain('claude-code');
    assert.ok(
      byApp.some((slice) => slice.path?.endsWith(`${path.sep}review-pr`)),
      'an app id surfaces its skills slices'
    );
  });
});

test('explain shows a user-modified bundle as a pending rewrite with diverging hashes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSkill(homes, 'review-pr');
    writeUserConfig(homes, baseConfig(['review-pr']));
    await runSync();

    const target = path.join(skillsParentDir(homes, 'claude-code'), 'review-pr');
    const distributed = bundleFingerprint(target);
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'edited\n');

    const { slices } = await runExplain('review-pr');

    assert.equal(slices[0]?.outcome, 'written');
    assert.equal(slices[0]?.currentHash, bundleFingerprint(target));
    assert.notEqual(slices[0]?.currentHash, distributed, 'the edit moved the live tree');
  });
});

test('explain names a missing skill instead of returning silence', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(homes, baseConfig(['ghost']));

    const { slices } = await runExplain('ghost');

    assert.equal(slices.length, 1);
    assert.equal(slices[0]?.app, null);
    assert.equal(slices[0]?.outcome, 'missing');
    assert.match(slices[0]?.reason ?? '', /skills\/ghost/);
  });
});

test('explain surfaces a parse failure for a selected malformed skill', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const dir = path.join(homes.asbHome, 'skills', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: broken\n', 'utf-8');
    writeUserConfig(homes, baseConfig(['broken']));

    const { slices } = await runExplain('broken');

    assert.equal(slices.length, 1);
    assert.equal(slices[0]?.app, null);
    assert.equal(slices[0]?.outcome, 'failed');
    assert.equal(slices[0]?.detail, 'parse-error');
    assert.match(slices[0]?.reason ?? '', /closing delimiter/);
  });
});
