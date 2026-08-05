import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runRemoveSource, runSync } from '../src/engine/cli.js';
import { editSourceDeclaration } from '../src/engine/config.js';
import {
  inCwd,
  installApps,
  ruleFilePath,
  type ScratchHomes,
  seedMarketplace,
  seedSkill,
  seedSource,
  skillDoc,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Retiring a source. A distributed slice proves it is asb's by matching what
 * the library renders, so removal has one load-bearing order: the source's ids
 * leave the selection, a full distribution takes their targets out while the
 * source can still be rendered, and only then does the declaration go. Every
 * way that order can be interrupted leaves the source in place, because a
 * source that is gone can never prove the files it left behind.
 */

/** A user config plus the `[plugins.sources]` table its namespaces resolve from. */
function writeConfig(
  homes: ScratchHomes,
  body: readonly string[],
  sources: Record<string, string> = {}
): void {
  const declared = Object.entries(sources).map(([namespace, at]) => `${namespace} = ${at}`);
  writeUserConfig(
    homes,
    [...body, ...(declared.length > 0 ? ['', '[plugins.sources]', ...declared] : []), ''].join('\n')
  );
}

function configText(homes: ScratchHomes): string {
  return fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8');
}

/** Where a distributed component id lands for the app every case here enables. */
function bundleFor(homes: ScratchHomes, id: string): string {
  return path.join(skillsParentDir(homes, 'claude-code'), id);
}

/** The recurring fixture: one source under the plugins tree shipping one skill. */
function seedTeam(homes: ScratchHomes): string {
  return seedSource(homes, 'team', { 'skills/deploy/SKILL.md': skillDoc('deploy') });
}

const BASE = ['[applications]', 'enabled = ["claude-code"]'];

test('removing a source retires every entry it enabled, one reported row each', async () => {
  await withScratchHomes(async (homes) => {
    const team = seedSource(homes, 'team', {
      'rules/style.md': '# Style\n',
      'skills/deploy/SKILL.md': skillDoc('deploy'),
    });
    writeConfig(
      homes,
      [
        ...BASE,
        '',
        '[rules]',
        'enabled = ["core", "team:style"]  # keep core',
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
        '',
        '[plugins]',
        'enabled = ["team"]',
      ],
      { team: JSON.stringify(team) }
    );

    const report = await runRemoveSource('team');
    const retired = report.entries.filter((entry) => entry.detail === 'retired');
    assert.deepEqual(
      retired.map((entry) => `${entry.type}/${entry.id}`).sort(),
      ['plugins/team', 'rules/team:style', 'skills/team:deploy'],
      JSON.stringify(report.entries, null, 2)
    );

    const after = configText(homes);
    assert.doesNotMatch(after, /team:style/);
    assert.doesNotMatch(after, /team:deploy/);
    assert.match(after, /"core"/, 'an unrelated selection is untouched');
    assert.match(after, /# keep core/, 'comments survive the edit');
    assert.doesNotMatch(after, /\[plugins\.sources\][\s\S]*team =/);
  });
});

test('removing a source retires the bare-name spellings its plugins were enabled by', async () => {
  await withScratchHomes(async (homes) => {
    seedMarketplace(homes, 'shop', 'shop', 'pack', { 'rules/style.md': '# Style\n' });
    writeConfig(
      homes,
      [...BASE, '', '[rules]', 'enabled = ["pack:style"]', '', '[plugins]', 'enabled = ["pack"]'],
      { shop: JSON.stringify(path.join(homes.asbHome, 'plugins', 'shop')) }
    );

    const report = await runRemoveSource('shop');

    // The user enabled both through their bare aliases; leaving those behind
    // lets the next source claiming the name re-enable foreign content.
    const retired = report.entries.filter((entry) => entry.detail === 'retired');
    assert.deepEqual(
      retired.map((entry) => `${entry.type}/${entry.id}`).sort(),
      ['plugins/pack', 'rules/pack:style'],
      JSON.stringify(report.entries, null, 2)
    );
    const after = configText(homes);
    assert.doesNotMatch(after, /"pack"/);
    assert.doesNotMatch(after, /"pack:style"/);
  });

  // A source nothing can resolve has no catalog to read the spellings out of,
  // and the splice still has to reach every list that names them.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeConfig(
      homes,
      [
        ...BASE,
        '',
        '[applications.claude-code.native_plugins]',
        'enabled = [ "tool@ns" ]',
        '',
        '[plugins]',
        'enabled = [ "tool@ns" ]',
      ],
      {
        ns: `{ url = ${JSON.stringify(`file://${path.join(homes.root, 'gone.git')}`)}, type = "clone" }`,
      }
    );

    const report = await runRemoveSource('ns');

    assert.ok(
      report.entries.some((entry) => entry.id === 'ns' && entry.outcome === 'removed'),
      JSON.stringify(report.entries, null, 2)
    );
    assert.equal(configText(homes).includes('tool@ns'), false, configText(homes));
  });
});

test('removing a source takes what it distributed in the same run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const team = seedSource(homes, 'team', {
      'rules/style.md': '# Style\n',
      'skills/deploy/SKILL.md': skillDoc('deploy'),
    });
    writeConfig(
      homes,
      [
        ...BASE,
        '',
        '[rules]',
        'enabled = ["team:style"]',
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
      ],
      { team: JSON.stringify(team) }
    );

    await runSync();
    const bundle = bundleFor(homes, 'team:deploy');
    const rules = ruleFilePath(homes, 'claude-code');
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
      configText(homes),
      /team/,
      'the declaration and both selections are out of the config'
    );

    // Nothing left selected: an id still in any list outlives the library entry
    // that could render it, and the next run is where that shows.
    const after = await runSync();
    assert.deepEqual(
      after.entries.filter((entry) => (entry.id ?? '').includes('team')),
      [],
      JSON.stringify(after.entries, null, 2)
    );
  });
});

/**
 * Every channel a source's content can be selected through, one case each.
 * Retirement enumerates these channels and `effectiveSelection` reads them: two
 * enumerations of one set, and each time they drifted apart a source was
 * deleted while its files stayed installed. The table is the check that keeps
 * them together, so a channel added later fails here rather than in the field.
 */
const SELECTION_CHANNELS: readonly (readonly [string, readonly string[]])[] = [
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
      const team = seedTeam(homes);
      writeConfig(homes, [...BASE, '', ...channel], { team: JSON.stringify(team) });

      await runSync();
      const deploy = bundleFor(homes, 'team:deploy');
      assert.ok(fs.existsSync(deploy), 'the channel distributed the skill');

      assert.equal((await runRemoveSource('team')).exitCode, 0);
      assert.equal(fs.existsSync(deploy), false, 'the skill leaves with the source');

      const after = await runSync();
      assert.deepEqual(
        after.entries.filter((entry) => (entry.id ?? '').includes('team')),
        [],
        JSON.stringify(after.entries, null, 2)
      );
    });
  });
}

test('removing a source clears the project copies a .asb.toml still names', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    installApps(homes, 'claude-code');
    const source = seedSource(homes, 'x', { 'skills/foo/SKILL.md': skillDoc('foo') });
    writeConfig(homes, BASE, { x: JSON.stringify(source) });
    fs.writeFileSync(path.join(project, '.asb.toml'), '[skills]\nenabled = ["x:foo"]\n');
    const projectSkills = path.join(project, '.claude', 'skills');
    const copies = (): string[] =>
      fs.existsSync(projectSkills) ? fs.readdirSync(projectSkills) : [];

    await runSync({ project });
    assert.equal(copies().length, 1, 'the repository holds the increment');

    // The repository's own file still names the id, and asb never edits it.
    // The sweep has to take the copy anyway: once the source is gone, nothing
    // can render that slice again, so nothing could ever prove it.
    const report = await runRemoveSource('x', { project });

    assert.deepEqual(copies(), [], JSON.stringify(report.entries, null, 2));
    assert.ok(
      report.entries.some((entry) => entry.id === 'x' && entry.outcome === 'removed'),
      JSON.stringify(report.entries, null, 2)
    );
    assert.equal(report.scope.project, project, 'the report names the root the sweep reconciled');
    assert.doesNotMatch(configText(homes), /\[plugins\.sources\][\s\S]*x =/);
  });
});

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
    writeConfig(homes, BASE, { x: JSON.stringify(vendor) });
    // Only the repository selects it, so the machine never holds a copy.
    fs.writeFileSync(path.join(project, '.asb.toml'), '[skills]\nenabled = ["x:foo"]\n');
    const inRepo = path.join(project, '.claude', 'skills', 'x:foo');

    await inCwd(project, async () => {
      assert.equal((await runSync()).exitCode, 0);
      assert.ok(fs.existsSync(inRepo), 'the increment reached the repository');

      const report = await runRemoveSource('x');

      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.equal(fs.existsSync(inRepo), false, 'and left with the source that proved it');
      assert.equal(configText(homes).includes(vendor), false);
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
    // Both levels select it, so the increment is empty and the repository holds
    // nothing — until a sweep that subtracts the retiring ids from one phase
    // only recomputes the increment as if the machine never wanted it.
    writeConfig(homes, [...BASE, '', '[skills]', 'enabled = ["x:foo"]'], {
      x: JSON.stringify(vendor),
    });
    fs.writeFileSync(path.join(project, '.asb.toml'), '[skills]\nenabled = ["x:foo"]\n');
    const machine = bundleFor(homes, 'x:foo');
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
    writeConfig(homes, BASE, { x: JSON.stringify(vendor) });
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\ncollision = "error"\n\n[skills]\nenabled = ["x:foo", "keep"]\n'
    );
    const inRepo = path.join(project, '.claude', 'skills', 'x:foo');
    const unrelated = path.join(project, '.claude', 'skills', 'keep');

    assert.equal((await runSync({ project })).exitCode, 0);
    assert.ok(fs.existsSync(inRepo), 'the increment reached the repository');

    // An unrelated repository copy stops being the render, and `collision =
    // "error"` answers that by suppressing every project write in the run —
    // the sweep's deletion of this source's copy among them.
    fs.appendFileSync(path.join(unrelated, 'SKILL.md'), 'A line the repository added.\n');

    const report = await runRemoveSource('x', { project });

    assert.ok(fs.existsSync(inRepo), 'the copy the preflight refused to take is still there');
    assert.match(
      configText(homes),
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
    const team = seedTeam(homes);
    writeConfig(homes, [...BASE, '', '[skills]', 'enabled = ["team:deploy"]'], {
      team: JSON.stringify(team),
    });
    const before = configText(homes);
    fs.mkdirSync(homes.stateHome, { recursive: true });
    fs.writeFileSync(path.join(homes.stateHome, 'run.lock'), `${process.pid} held\n`);

    await assert.rejects(runRemoveSource('team'), /appears to be active/);
    assert.equal(configText(homes), before);
    assert.ok(fs.existsSync(team));
  });
});

test('source removal rejects an auto-discovered directory before changing its selections', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTeam(homes);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[skills]\nenabled = ["team:deploy"]\n'
    );
    await runSync();
    const before = configText(homes);

    await assert.rejects(runRemoveSource('team'), /Source "team" not found/);

    assert.equal(configText(homes), before);
    assert.ok(fs.existsSync(bundleFor(homes, 'team:deploy')));
  });
});

test('an aborted sweep keeps the source and the slices it never reached', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const team = seedTeam(homes);
    const declare = (broken: boolean): void => {
      writeConfig(homes, [...BASE, '', '[skills]', 'enabled = ["team:deploy"]'], {
        team: JSON.stringify(team),
        ...(broken ? { '"../broken"': JSON.stringify(path.join(homes.root, 'broken')) } : {}),
      });
    };
    declare(false);
    await runSync();
    declare(true);

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundleFor(homes, 'team:deploy')));
    assert.ok(fs.existsSync(team));
    assert.match(configText(homes), /\bteam\b/);
  });
});

test('a malformed source component keeps its render evidence until it can be swept', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const team = seedTeam(homes);
    writeConfig(homes, [...BASE, '', '[skills]', 'enabled = ["team:deploy"]'], {
      team: JSON.stringify(team),
    });
    await runSync();
    fs.writeFileSync(path.join(team, 'skills', 'deploy', 'SKILL.md'), '---\nname: broken\n');

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundleFor(homes, 'team:deploy')));
    assert.ok(fs.existsSync(team));
    assert.match(configText(homes), /\bteam\b/);
  });
});

test('an unreadable marketplace keeps its declaration and distributed slices', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedMarketplace(homes, 'shop', 'shop', 'pack', {
      'skills/deploy/SKILL.md': skillDoc('deploy'),
    });
    const shop = path.join(homes.asbHome, 'plugins', 'shop');
    writeConfig(homes, [...BASE, '', '[skills]', 'enabled = ["pack@shop:deploy"]'], {
      shop: JSON.stringify(shop),
    });
    await runSync();
    const bundle = bundleFor(homes, 'pack@shop:deploy');
    assert.ok(fs.existsSync(bundle));
    fs.writeFileSync(path.join(shop, '.claude-plugin', 'marketplace.json'), '{ not json');

    const report = await runRemoveSource('shop');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundle));
    assert.ok(fs.existsSync(shop));
    assert.match(configText(homes), /\bshop\b/);
  });
});

test('a source stays renderable while an installed target that may hold it is inactive', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex');
    const team = seedTeam(homes);
    const declare = (apps: readonly string[]): void => {
      writeConfig(
        homes,
        [
          '[applications]',
          `enabled = [${apps.map((app) => JSON.stringify(app)).join(', ')}]`,
          '',
          '[skills]',
          'enabled = ["team:deploy"]',
        ],
        { team: JSON.stringify(team) }
      );
    };
    declare(['claude-code']);
    await runSync();
    declare(['codex']);

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(bundleFor(homes, 'team:deploy')));
    assert.ok(fs.existsSync(team));
    assert.match(configText(homes), /\bteam\b/);
  });
});

test('a source outlives a deletion the file system refused', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const team = seedTeam(homes);
    writeConfig(homes, [...BASE, '', '[skills]', 'enabled = ["team:deploy"]'], {
      team: JSON.stringify(team),
    });
    await runSync();

    // The tree is still exactly the render, so the sweep plans to take it and
    // the unlink is what fails. Fixing the mode and re-running is the whole
    // repair, which is why the source has to still be there afterwards.
    const bundle = bundleFor(homes, 'team:deploy');
    fs.chmodSync(bundle, 0o500);
    try {
      const report = await runRemoveSource('team');

      assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
      assert.ok(fs.existsSync(path.join(bundle, 'SKILL.md')), 'the file is still installed');
      assert.match(
        configText(homes),
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
    const team = seedSource(homes, 'team', { 'rules/base.md': 'Team rule body.\n' });
    writeConfig(homes, [...BASE, '', '[rules]', 'enabled = ["team:base"]'], {
      team: JSON.stringify(team),
    });
    await runSync();

    // A shared host fails as a whole and names no component, so nothing in the
    // row says the rule inside it came from this source. What says so is the
    // type: the source distributes rules, and the rules host is stuck.
    const host = ruleFilePath(homes, 'claude-code');
    const broken = '# Notes\n\n<!-- rules:start -->\nHalf a region.\n';
    fs.writeFileSync(host, broken, 'utf-8');

    const report = await runRemoveSource('team');

    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.readFileSync(host, 'utf-8'), broken, 'the host is left exactly as it was');
    assert.match(configText(homes), /\bteam\b/, 'and the source stays until the host can be swept');
  });
});

test('removing a source keeps the comments that belong to what stays', async () => {
  await withScratchHomes(async (homes) => {
    const configPath = path.join(homes.asbHome, 'config.toml');
    fs.mkdirSync(homes.asbHome, { recursive: true });
    const splice = (lines: readonly string[]): string => {
      fs.writeFileSync(configPath, lines.join('\n'));
      editSourceDeclaration({ namespace: 'doomed' });
      const after = fs.readFileSync(configPath, 'utf-8');
      assert.equal(after.includes('doomed'), false, after);
      return after;
    };

    // A comment block introducing the next table belongs to that table.
    const kept = splice([
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
    ]);
    assert.ok(kept.includes('# Keeper: documents the keeper source below.'), kept);
    assert.ok(kept.includes('[plugins.sources.keeper]'), kept);

    // At the end of the file, with no trailing newline to delimit it.
    const atEof = splice([
      '[plugins.sources]',
      '',
      '    [plugins.sources.doomed]',
      '    url = "https://example.invalid/doomed.git"',
      '    type = "clone"',
      '',
      '    # keep-at-eof',
    ]);
    assert.ok(atEof.includes('# keep-at-eof'), atEof);

    // A comment on the source's own key belongs to the source and goes with it.
    for (const ending of ['', '\n']) {
      const own = splice([
        '[rules]',
        'enabled = []',
        '',
        '[plugins.sources.doomed]',
        'url = "https://example.invalid/doomed.git"',
        `type = "clone" # belongs-to-doomed${ending}`,
      ]);
      assert.equal(own.includes('belongs-to-doomed'), false, JSON.stringify({ ending, own }));
      assert.ok(own.includes('[rules]'), own);
    }
  });
});
