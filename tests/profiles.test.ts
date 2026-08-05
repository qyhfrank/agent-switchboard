import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { runSync, selectedFor } from '../src/engine/cli.js';
import { editSelection, loadConfig } from '../src/engine/config.js';
import type { Report, ReportEntry } from '../src/engine/report.js';
import {
  installApps,
  renderedRules,
  ruleFilePath,
  type ScratchHomes,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * A profile is which selection file a run reads, never a state it records and
 * never a layer stacked on config.toml. Every claim here is made on the
 * rendered target bytes or on the row the run reports, so "the profile is the
 * whole selection" is proven by what reaches disk.
 */

function configFor(rules: readonly string[]): string {
  return `[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = [${rules
    .map((id) => `"${id}"`)
    .join(', ')}]\n`;
}

function writeProfile(homes: ScratchHomes, name: string, toml: string): void {
  fs.writeFileSync(path.join(homes.asbHome, `${name}.toml`), toml, 'utf-8');
}

function rulesRows(report: Report): ReportEntry[] {
  return report.entries.filter((entry) => entry.type === 'rules');
}

function seedTwoRules(homes: ScratchHomes): void {
  seedRule(homes, 'alpha.md', '---\ntitle: Alpha\n---\nFirst version\n');
  seedRule(homes, 'beta.md', 'Beta body\n');
}

test('a profile syncs from its own file and retires what config.toml distributed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['alpha']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    assert.equal(fs.readFileSync(target, 'utf-8'), renderedRules('claude-code', 'First version\n'));

    writeProfile(homes, 'aws', configFor(['beta']));
    const profiled = await runSync({ profile: 'aws' });

    assert.equal(rulesRows(profiled)[0]?.outcome, 'written');
    assert.equal(
      fs.readFileSync(target, 'utf-8'),
      renderedRules('claude-code', 'Beta body\n'),
      "the profile is the whole selection; config.toml's own is not read"
    );
    assert.equal(profiled.exitCode, 0);

    // A section the profile does not carry selects nothing, and the render
    // says the target was asb's to take away.
    writeProfile(homes, 'aws', '[applications]\nenabled = ["claude-code"]\n');
    const emptied = await runSync({ profile: 'aws' });
    assert.equal(rulesRows(emptied)[0]?.outcome, 'removed');
    assert.equal(fs.existsSync(target), false);
    assert.equal(emptied.exitCode, 0);

    // And none of it stuck: the next plain run is the machine's own selection.
    const plain = await runSync();
    assert.equal(fs.readFileSync(target, 'utf-8'), renderedRules('claude-code', 'First version\n'));
    assert.equal(plain.exitCode, 0);
  });
});

test('a selection enabling no applications reconciles nothing and only a profile says so', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['alpha']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    const distributed = fs.readFileSync(target, 'utf-8');

    // A selection with no applications has no reconciliation universe. The run
    // is a no-op, and without the row that reads as "nothing to do".
    writeProfile(homes, 'aws', '[rules]\nenabled = ["beta"]\n');
    const profiled = await runSync({ profile: 'aws' });

    assert.equal(profiled.exitCode, 0, JSON.stringify(profiled.entries, null, 2));
    assert.deepEqual(rulesRows(profiled), []);
    const idle = profiled.entries.find((entry) => entry.detail === 'no-applications');
    assert.ok(idle, JSON.stringify(profiled.entries, null, 2));
    assert.equal(idle.outcome, 'skipped');
    assert.equal(idle.path, path.join(homes.asbHome, 'aws.toml'), 'the row names the file read');
    assert.equal(fs.readFileSync(target, 'utf-8'), distributed);

    // The row belongs to a file the run was told to read. A machine whose own
    // configuration enables nothing has always had nothing to do.
    writeUserConfig(homes, '[rules]\nenabled = ["beta"]\n');
    const plain = await runSync();

    assert.equal(plain.exitCode, 0, JSON.stringify(plain.entries, null, 2));
    assert.deepEqual(
      plain.entries.filter((entry) => entry.detail === 'no-applications'),
      []
    );
    assert.equal(fs.readFileSync(target, 'utf-8'), distributed);
  });
});

test('a profile naming a file that does not exist fails the run instead of reconciling nothing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['alpha']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    const distributed = fs.readFileSync(target, 'utf-8');

    // An absent selection must not read as an empty one, or the run would
    // sweep every target the real selection distributed.
    const expected = path.join(homes.asbHome, 'nosuch.toml');
    for (const report of [
      await runSync({ profile: 'nosuch' }),
      await (async () => {
        process.env.ASB_PROFILE = 'nosuch';
        try {
          return await runSync();
        } finally {
          delete process.env.ASB_PROFILE;
        }
      })(),
    ]) {
      const row = report.entries.find((entry) => entry.detail === 'profile-missing');
      assert.ok(row, JSON.stringify(report.entries, null, 2));
      assert.equal(row.outcome, 'missing');
      assert.equal(row.id, 'nosuch');
      assert.equal(row.path, expected);
      assert.equal(report.exitCode, 1);
      assert.deepEqual(rulesRows(report), [], 'an absent selection reconciles nothing');
      assert.equal(fs.readFileSync(target, 'utf-8'), distributed);
    }
  });
});

test('a scoped selection is read from and written to the active layer alone', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '# user\n[commands]\nenabled = ["inherited"]\n\n[applications.cursor.commands]\nadd = ["inherited-app"]\n'
    );
    writeProfile(
      homes,
      'work',
      '[commands]\nenabled = ["profile-only"]\n\n[applications.cursor.commands]\nadd = ["profile-app"]\n'
    );

    // What the picker offers is what the target file says, so saving it back
    // cannot copy config.toml's ids into the profile.
    const profile = loadConfig({ profile: 'work' });
    assert.deepEqual(selectedFor(profile, 'commands', undefined), ['profile-only']);
    assert.deepEqual(selectedFor(profile, 'commands', 'cursor'), ['profile-app']);

    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.asb.toml'), '[applications]\nenabled = []\n');
    const scoped = loadConfig({ profile: 'work', project });
    assert.deepEqual(selectedFor(scoped, 'commands', undefined), []);
    assert.deepEqual(selectedFor(scoped, 'commands', 'cursor'), []);

    const userLayer = fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8');
    editSelection({ type: 'commands', replace: [], profile: 'work' });

    const edited = parseToml(fs.readFileSync(path.join(homes.asbHome, 'work.toml'), 'utf-8')) as {
      commands: { enabled: string[] };
    };
    assert.deepEqual(edited.commands.enabled, [], 'an empty selection is written, not omitted');
    assert.deepEqual(loadConfig({ profile: 'work' }).selection.commands, []);
    assert.equal(
      fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'),
      userLayer,
      'the layer the run was not told to read is untouched'
    );
  });
});
