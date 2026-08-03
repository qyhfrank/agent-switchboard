import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runRemoveSource, runSync } from '../../src/engine/cli.js';
import {
  installApps,
  ruleFilePath,
  type ScratchHomes,
  seedRule,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * asb keeps no record of what it owns. Ownership is a comparison against what
 * the library renders, made fresh on every run, so the state directory holds
 * only the lock that serializes runs and the fact of the last one — and the
 * stores an earlier version wrote are cleared the first time this one runs.
 *
 * The comparison has one ordering consequence worth a test of its own: a
 * component asb cannot render proves nothing, so anything that retires a
 * component has to take its distributed slices out while the library still
 * holds it.
 */

function skillDoc(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\nBody of ${name}.\n`;
}

function seedSource(homes: ScratchHomes, namespace: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(homes.asbHome, 'plugins', namespace, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

test('a sync clears the stores an earlier version wrote and leaves only run state', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Be kind.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );

    // What a 0.4 install left in place: the entry ledger, the per-project
    // manifests, and the hook peer records.
    fs.mkdirSync(homes.stateHome, { recursive: true });
    fs.writeFileSync(path.join(homes.stateHome, 'ledger.json'), '{"version":1,"entries":[]}\n');
    for (const store of ['hooks', 'manifests']) {
      const dir = path.join(homes.asbHome, 'state', store);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stale.json'), '{}\n');
    }
    // A live neighbour under the same parent, which is not asb's to clear.
    const native = path.join(homes.asbHome, 'state', 'native-plugins');
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'keep.json'), '{}\n');

    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(
      fs.readdirSync(homes.stateHome).sort(),
      ['last-run.json'],
      'the state dir carries the last run and, while one is in flight, run.lock'
    );
    assert.deepEqual(fs.readdirSync(path.join(homes.asbHome, 'state')), ['native-plugins']);
    assert.ok(fs.existsSync(path.join(native, 'keep.json')));

    const lastRun = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'last-run.json'), 'utf-8')
    ) as { at: string; summary: string };
    assert.match(lastRun.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(lastRun.summary, /written/);
  });
});

test('a project run writes nothing to the machine state directory', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Be kind.\n');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["alpha"]',
        '',
        '[distribution.project]',
        'mode = "managed"',
        '',
      ].join('\n')
    );

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(
      fs.existsSync(homes.stateHome) && fs.readdirSync(homes.stateHome).length > 0,
      false,
      'a repository run proves itself from the repository, not from this machine'
    );
    assert.equal(fs.existsSync(path.join(homes.asbHome, 'state', 'manifests')), false);
  });
});

test('removing a source takes what it distributed in the same run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', {
      'rules/style.md': '# Style\n',
      'skills/deploy/SKILL.md': skillDoc('deploy'),
    });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["team:style"]',
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'team'))}`,
        '',
      ].join('\n')
    );

    await runSync();
    const bundle = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    const rules = path.join(homes.agentsHome, '.claude', 'CLAUDE.md');
    assert.ok(fs.existsSync(bundle), 'the source distributed a skill bundle');
    assert.match(fs.readFileSync(rules, 'utf-8'), /Style/);

    const report = await runRemoveSource('team');

    // The bundle can only be proven asb's against a render, and removing the
    // source is what makes that render impossible: taking it out afterwards
    // would be taking out a tree nothing can attribute.
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(bundle), false, 'the bundle went with the source');
    assert.equal(fs.existsSync(rules), false, 'and so did a host that held nothing else');
    assert.doesNotMatch(
      fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'),
      /team/,
      'the declaration and both selections are out of the config'
    );
  });
});

test('removing a source reaches what the plugin list and a per-app override selected', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    seedSource(homes, 'solo', { 'skills/audit/SKILL.md': skillDoc('audit') });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        // Neither id is in a global [skills] list: one arrives through the
        // plugin the source ships, the other through an override that names
        // one app. Both are what `asb enable` writes for those shapes.
        '[plugins]',
        'enabled = ["team"]',
        '',
        '[applications.claude-code.skills]',
        'add = ["solo:audit"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'team'))}`,
        `solo = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'solo'))}`,
        '',
      ].join('\n')
    );

    await runSync();
    const deploy = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    const audit = path.join(skillsParentDir(homes, 'claude-code'), 'solo:audit');
    assert.ok(fs.existsSync(deploy), 'the plugin distributed its skill');
    assert.ok(fs.existsSync(audit), 'and so did the per-app override');

    assert.equal((await runRemoveSource('team')).exitCode, 0);
    assert.equal(
      fs.existsSync(deploy),
      false,
      'a component the plugin list selected is swept while its library entry can still render it'
    );

    assert.equal((await runRemoveSource('solo')).exitCode, 0);
    assert.equal(
      fs.existsSync(audit),
      false,
      'and so is one a per-app override selected, which no global list mentions'
    );
  });
});

test('a source outlives a sweep that could not take everything it distributed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'team'))}`,
        '',
      ].join('\n')
    );
    await runSync();

    // The tree is still exactly the render, so the sweep plans to take it.
    // What stops the deletion is containment: the skills parent now leaves
    // the app root, and asb refuses to delete through it.
    const parent = skillsParentDir(homes, 'claude-code');
    const outside = path.join(homes.root, 'elsewhere');
    fs.renameSync(parent, outside);
    fs.symlinkSync(outside, parent);
    const bundle = path.join(outside, 'team:deploy');

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundle), 'the tree the sweep could not take is still there');
    assert.match(
      fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'),
      /\bteam\b/,
      'and so is the source, which is the only thing that can still render it'
    );
  });
});

test('removing a source reaches a plugin only a per-app override selected', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[applications.claude-code.plugins]',
        'add = ["team"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'team'))}`,
        '',
      ].join('\n')
    );

    await runSync();
    const deploy = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    assert.ok(fs.existsSync(deploy), 'the per-app plugin override distributed the skill');

    assert.equal((await runRemoveSource('team')).exitCode, 0);
    assert.equal(
      fs.existsSync(deploy),
      false,
      'a plugin no global list mentions still expands to components, so retiring the source has to reach the override that named it'
    );
  });
});

test('a source outlives a deletion the file system refused', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'team'))}`,
        '',
      ].join('\n')
    );
    await runSync();

    // The tree is still exactly the render, so the sweep plans to take it and
    // the unlink is what fails. Fixing the mode and re-running is the whole
    // repair, which is why the source has to still be there afterwards.
    const bundle = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    fs.chmodSync(bundle, 0o500);
    try {
      const report = await runRemoveSource('team');

      assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
      assert.ok(fs.existsSync(path.join(bundle, 'SKILL.md')), 'the file is still installed');
      assert.match(
        fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'),
        /\bteam\b/,
        'and so is the source, which is the only thing that can still render it'
      );
    } finally {
      fs.chmodSync(bundle, 0o700);
    }
  });
});

test('a source outlives a host failure on a type it distributed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'rules/base.md': 'Team rule body.\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["team:base"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'team'))}`,
        '',
      ].join('\n')
    );
    await runSync();

    // A shared host fails as a whole and names no component, so nothing in
    // the row says the rule inside it came from this source. What says so is
    // the type: the source distributes rules, and the rules host is stuck.
    const host = ruleFilePath(homes, 'claude-code');
    const broken = '# Notes\n\n<!-- rules:start -->\nHalf a region.\n';
    fs.writeFileSync(host, broken, 'utf-8');

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.readFileSync(host, 'utf-8'), broken, 'the host is left exactly as it was');
    assert.match(
      fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'),
      /\bteam\b/,
      'and the source stays until the host can be swept'
    );
  });
});

test('explain names what proves ownership now, not what a record once said', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSkill(homes, 'deploy', { body: 'Body of deploy.\n' });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[skills]\nenabled = ["deploy"]\n'
    );
    await runSync();

    const proven = await runExplain('deploy');
    const before = proven.filter((slice) => slice.app !== null);
    assert.ok(before.length > 0, JSON.stringify(proven, null, 2));
    assert.ok(
      before.every((slice) => slice.provenance === 'identity'),
      JSON.stringify(before, null, 2)
    );

    const doc = path.join(skillsParentDir(homes, 'claude-code'), 'deploy', 'SKILL.md');
    fs.appendFileSync(doc, '\nA line the user added.\n');

    const after = (await runExplain('deploy')).filter((slice) => slice.app !== null);
    assert.ok(
      after.every((slice) => slice.provenance === null),
      `an edited tree stops being provably asb’s: ${JSON.stringify(after, null, 2)}`
    );
  });
});
