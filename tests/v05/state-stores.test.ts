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

function seedSource(
  homes: ScratchHomes,
  namespace: string,
  files: Record<string, string>,
  parent = path.join(homes.asbHome, 'plugins')
): string {
  const root = path.join(parent, namespace);
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return root;
}

/** Run a body with the process rooted in `dir`, whatever it throws. */
async function inCwd<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await body();
  } finally {
    process.chdir(previous);
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

test('the project phase records nothing beside the marker every run leaves', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project, { recursive: true });
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Be kind.\n');
    seedRule(homes, 'repo.md', 'Repo only.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );
    fs.writeFileSync(path.join(project, '.asb.toml'), '[rules]\nenabled = ["alpha", "repo"]\n');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.match(
      fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'),
      /Repo only/,
      'the increment reached the repository'
    );
    assert.deepEqual(
      fs.readdirSync(homes.stateHome).sort(),
      ['last-run.json'],
      'the user phase stamps the run; the project phase adds no record of what it put in a repository'
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

test('removing a source takes the slices it put in the named project too', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project, { recursive: true });
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
    // An app the base does not enable holds nothing at user scope, so its
    // whole selection is increment and lands at project destinations. The
    // machine carries no cursor install, so retirement has no inactive app to
    // hold the source back for.
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[applications]\nenabled = ["claude-code", "cursor"]\nassume_installed = ["cursor"]\n'
    );

    await runSync({ project });
    const machine = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    const inRepo = path.join(project, '.cursor', 'skills', 'team:deploy');
    assert.ok(fs.existsSync(machine), 'the source distributed at user scope');
    assert.ok(fs.existsSync(inRepo), 'and into the repository the run named');

    const report = await runRemoveSource('team', { project });

    // The sweep is unfiltered and inherits both phases, so the repository is
    // cleared while the library entry can still prove the tree is asb's.
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(machine), false);
    assert.equal(fs.existsSync(inRepo), false);
  });
});

/**
 * The sweep behind `asb remove` inherits both phases, and the ids it is
 * taking are wanted in neither: the repository's `.asb.toml` is not asb's to
 * edit, so what stops its copy from being written back — or from being
 * stranded past the library entry that proves it — is that the retirement
 * names those ids for both phases at once.
 */
test('removing a source reaches the repository copy in the same ambient run', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project, { recursive: true });
    installApps(homes, 'claude-code');
    // Outside <asbHome>/plugins: there, dropping the declaration is what makes
    // the namespace stop resolving, while a directory under it stays
    // discoverable by its presence alone.
    const vendor = seedSource(
      homes,
      'x',
      { 'skills/foo/SKILL.md': skillDoc('foo') },
      path.join(homes.root, 'vendor')
    );
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins.sources]',
        `x = ${JSON.stringify(vendor)}`,
        '',
      ].join('\n')
    );
    // Only the repository selects it, so the machine never holds a copy.
    fs.writeFileSync(path.join(project, '.asb.toml'), '[skills]\nenabled = ["x:foo"]\n');
    const inRepo = path.join(project, '.claude', 'skills', 'x:foo');
    const configPath = path.join(homes.asbHome, 'config.toml');

    await inCwd(project, async () => {
      assert.equal((await runSync()).exitCode, 0);
      assert.ok(fs.existsSync(inRepo), 'the increment reached the repository');

      const report = await runRemoveSource('x');

      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.equal(fs.existsSync(inRepo), false, 'and left with the source that proved it');
      assert.equal(fs.readFileSync(configPath, 'utf-8').includes(vendor), false);
      // The sweep reconciled this repository, so the report names it.
      assert.equal(report.scope.project, project);

      // The repository's file still names the id, which is correct: the next
      // run is where a selection nothing can render says so.
      const after = await runSync();
      assert.ok(
        after.entries.some((entry) => entry.id === 'x:foo' && entry.outcome === 'missing'),
        JSON.stringify(after.entries, null, 2)
      );
    });
  });
});

test('removing a source never writes a fresh repository copy of what it takes', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project, { recursive: true });
    installApps(homes, 'claude-code');
    const vendor = seedSource(
      homes,
      'x',
      { 'skills/foo/SKILL.md': skillDoc('foo') },
      path.join(homes.root, 'vendor')
    );
    // Both levels select it, so the increment is empty and the repository
    // holds nothing — until a sweep that subtracts the retiring ids from one
    // phase only recomputes the increment as if the machine never wanted it.
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[skills]',
        'enabled = ["x:foo"]',
        '',
        '[plugins.sources]',
        `x = ${JSON.stringify(vendor)}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(path.join(project, '.asb.toml'), '[skills]\nenabled = ["x:foo"]\n');
    const machine = path.join(skillsParentDir(homes, 'claude-code'), 'x:foo');
    const inRepo = path.join(project, '.claude', 'skills', 'x:foo');

    await inCwd(project, async () => {
      assert.equal((await runSync()).exitCode, 0);
      assert.ok(fs.existsSync(machine));
      assert.equal(fs.existsSync(inRepo), false, 'nothing the machine already carries is copied');

      const report = await runRemoveSource('x');

      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.equal(fs.existsSync(machine), false);
      assert.equal(fs.existsSync(inRepo), false, 'and no copy appears on the way out');
    });
  });
});

test('a source outlives a project preflight that suppressed its sweep', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project, { recursive: true });
    installApps(homes, 'claude-code');
    const vendor = seedSource(
      homes,
      'x',
      { 'skills/foo/SKILL.md': skillDoc('foo') },
      path.join(homes.root, 'vendor')
    );
    seedSkill(homes, 'keep');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins.sources]',
        `x = ${JSON.stringify(vendor)}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\ncollision = "error"\n\n[skills]\nenabled = ["x:foo", "keep"]\n'
    );
    const inRepo = path.join(project, '.claude', 'skills', 'x:foo');
    const unrelated = path.join(project, '.claude', 'skills', 'keep');
    const configPath = path.join(homes.asbHome, 'config.toml');

    assert.equal((await runSync({ project })).exitCode, 0);
    assert.ok(fs.existsSync(inRepo), 'the increment reached the repository');

    // An unrelated repository copy stops being the render, and `collision =
    // "error"` answers that by suppressing every project write in the run —
    // the sweep's deletion of this source's copy among them.
    fs.appendFileSync(path.join(unrelated, 'SKILL.md'), 'A line the repository added.\n');

    const report = await runRemoveSource('x', { project });

    assert.ok(fs.existsSync(inRepo), 'the copy the preflight refused to take is still there');
    assert.match(
      fs.readFileSync(configPath, 'utf-8'),
      /\bx =/,
      'and so is the source, which is the only thing that can still prove it'
    );
    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));

    // Resolving the collision is the whole repair: the next run takes the copy
    // while the library can still render it.
    fs.rmSync(unrelated, { recursive: true });
    const retry = await runRemoveSource('x', { project });

    assert.equal(retry.exitCode, 0, JSON.stringify(retry.entries, null, 2));
    assert.equal(fs.existsSync(inRepo), false, 'and the repository is clear');
  });
});

test('source removal changes nothing when another run holds the lock', async () => {
  await withScratchHomes(async (homes) => {
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
    const configPath = path.join(homes.asbHome, 'config.toml');
    const before = fs.readFileSync(configPath, 'utf-8');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    fs.writeFileSync(path.join(homes.stateHome, 'run.lock'), `${process.pid} held\n`);

    await assert.rejects(runRemoveSource('team'), /appears to be active/);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
    assert.ok(fs.existsSync(path.join(homes.asbHome, 'plugins', 'team')));
  });
});

test('source removal rejects an auto-discovered directory before changing its selections', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[skills]\nenabled = ["team:deploy"]\n'
    );
    await runSync();
    const bundle = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    const configPath = path.join(homes.asbHome, 'config.toml');
    const before = fs.readFileSync(configPath, 'utf-8');

    await assert.rejects(runRemoveSource('team'), /Source "team" not found/);

    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
    assert.ok(fs.existsSync(bundle));
  });
});

test('an aborted sweep keeps the source and the slices it never reached', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    const teamPath = path.join(homes.asbHome, 'plugins', 'team');
    const config = (broken: boolean) =>
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(teamPath)}`,
        ...(broken ? [`"../broken" = ${JSON.stringify(path.join(homes.root, 'broken'))}`] : []),
        '',
      ].join('\n');
    writeUserConfig(homes, config(false));
    await runSync();
    const bundle = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    writeUserConfig(homes, config(true));

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundle));
    assert.ok(fs.existsSync(teamPath));
    assert.match(fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'), /\bteam\b/);
  });
});

test('a malformed source component keeps its render evidence until it can be swept', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    const teamPath = path.join(homes.asbHome, 'plugins', 'team');
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
        `team = ${JSON.stringify(teamPath)}`,
        '',
      ].join('\n')
    );
    await runSync();
    const bundle = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    fs.writeFileSync(path.join(teamPath, 'skills', 'deploy', 'SKILL.md'), '---\nname: broken\n');

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundle));
    assert.ok(fs.existsSync(teamPath));
    assert.match(fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'), /\bteam\b/);
  });
});

test('an unreadable marketplace keeps its declaration and distributed slices', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const sourcePath = path.join(homes.asbHome, 'plugins', 'shop');
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'shop',
        plugins: [{ name: 'pack', source: './pack' }],
      }),
      'pack/skills/deploy/SKILL.md': skillDoc('deploy'),
    });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[skills]',
        'enabled = ["pack@shop:deploy"]',
        '',
        '[plugins.sources]',
        `shop = ${JSON.stringify(sourcePath)}`,
        '',
      ].join('\n')
    );
    await runSync();
    const bundle = path.join(skillsParentDir(homes, 'claude-code'), 'pack@shop:deploy');
    assert.ok(fs.existsSync(bundle));
    fs.writeFileSync(path.join(sourcePath, '.claude-plugin', 'marketplace.json'), '{ not json');

    const report = await runRemoveSource('shop');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundle));
    assert.ok(fs.existsSync(sourcePath));
    assert.match(fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'), /\bshop\b/);
  });
});

test('a source stays renderable while an installed target that may hold it is inactive', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex');
    seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
    const teamPath = path.join(homes.asbHome, 'plugins', 'team');
    const config = (apps: readonly string[]) =>
      [
        '[applications]',
        `enabled = [${apps.map((app) => JSON.stringify(app)).join(', ')}]`,
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(teamPath)}`,
        '',
      ].join('\n');
    writeUserConfig(homes, config(['claude-code']));
    await runSync();
    const bundle = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
    writeUserConfig(homes, config(['codex']));

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundle));
    assert.ok(fs.existsSync(teamPath));
    assert.match(fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'), /\bteam\b/);
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

/**
 * Every channel a source's content can be selected through, one case each.
 * Retirement enumerates these channels and `effectiveSelection` reads them:
 * two enumerations of one set, and each time they drifted apart a source was
 * deleted while its files stayed installed. The table is the check that keeps
 * them together, so a channel added later fails here rather than in the field.
 */
const SELECTION_CHANNELS: readonly (readonly [string, readonly string[]])[] = [
  ['the global component list', ['[skills]', 'enabled = ["team:deploy"]']],
  ['the global plugin list', ['[plugins]', 'enabled = ["team"]']],
  ['a per-app component add', ['[applications.claude-code.skills]', 'add = ["team:deploy"]']],
  [
    'a per-app component enabled',
    ['[applications.claude-code.skills]', 'enabled = ["team:deploy"]'],
  ],
  ['a per-app plugin add', ['[applications.claude-code.plugins]', 'add = ["team"]']],
  ['a per-app plugin enabled', ['[applications.claude-code.plugins]', 'enabled = ["team"]']],
];

for (const [label, channel] of SELECTION_CHANNELS) {
  test(`removing a source takes what ${label} selected`, async () => {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
      writeUserConfig(
        homes,
        [
          '[applications]',
          'enabled = ["claude-code"]',
          '',
          ...channel,
          '',
          '[plugins.sources]',
          `team = ${JSON.stringify(path.join(homes.asbHome, 'plugins', 'team'))}`,
          '',
        ].join('\n')
      );

      await runSync();
      const deploy = path.join(skillsParentDir(homes, 'claude-code'), 'team:deploy');
      assert.ok(fs.existsSync(deploy), 'the channel distributed the skill');

      assert.equal((await runRemoveSource('team')).exitCode, 0);
      assert.equal(fs.existsSync(deploy), false, 'the skill leaves with the source');

      // Nothing left selected: an id still in any list outlives the library
      // entry that could render it, and the next run is where that shows.
      const after = await runSync();
      assert.deepEqual(
        after.entries.filter((entry) => (entry.id ?? '').includes('team')),
        [],
        JSON.stringify(after.entries, null, 2)
      );
    });
  });
}

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

    const { slices: proven } = await runExplain('deploy');
    const before = proven.filter((slice) => slice.app !== null);
    assert.ok(before.length > 0, JSON.stringify(proven, null, 2));
    assert.ok(
      before.every((slice) => slice.provenance === 'identity'),
      JSON.stringify(before, null, 2)
    );

    const doc = path.join(skillsParentDir(homes, 'claude-code'), 'deploy', 'SKILL.md');
    fs.appendFileSync(doc, '\nA line the user added.\n');

    const after = (await runExplain('deploy')).slices.filter((slice) => slice.app !== null);
    assert.ok(
      after.every((slice) => slice.provenance === null),
      `an edited tree stops being provably asb’s: ${JSON.stringify(after, null, 2)}`
    );
  });
});
