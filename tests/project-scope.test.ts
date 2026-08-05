import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows, projectAppRows } from '../src/engine/apps.js';
import { runSync } from '../src/engine/cli.js';
import { effectiveSelection, loadConfig, selectionDelta } from '../src/engine/config.js';
import { mergeProjectRegion, projectRegion } from '../src/engine/shapes.js';
import {
  inCwd,
  installApps,
  renderedRules,
  ruleFilePath,
  type ScratchHomes,
  seedRule,
  seedSkill,
  seedTree,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The repository's own layer: distribution policy, then whatever it adds over
 * the base selection file. Project destinations receive the increment alone,
 * so a component the base already selects never gets a repository copy — it is
 * visible to every app in every directory already.
 */
function projectConfig(
  project: string,
  adds = '',
  { mode = 'managed', collision = 'warn-skip' }: { mode?: string; collision?: string } = {}
): void {
  fs.writeFileSync(
    path.join(project, '.asb.toml'),
    `[distribution.project]\nmode = "${mode}"\ncollision = "${collision}"\n\n${adds}`
  );
}

test('project root canonicalizes once and the increment is the overlay minus the base', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'real-project');
    const alias = path.join(homes.root, 'project-link');
    fs.mkdirSync(project);
    fs.symlinkSync(project, alias, 'dir');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["global"]\n\n[skills]\nenabled = ["inherited"]\n'
    );
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[commands]\nenabled = ["project"]\n\n[applications.cursor.skills]\nadd = ["added"]\n'
    );

    const base = loadConfig({});
    const overlay = loadConfig({ project: alias });

    assert.equal(overlay.project, fs.realpathSync(project));
    assert.deepEqual(effectiveSelection(overlay, 'cursor', 'commands'), ['project']);
    assert.deepEqual(effectiveSelection(overlay, 'cursor', 'skills'), ['inherited', 'added']);
    // What the repository distributes: the overlay's set less the base's, in
    // overlay order. `inherited` is already global, so no repository copy.
    assert.deepEqual(selectionDelta(overlay, base, 'cursor', 'commands'), ['project']);
    assert.deepEqual(selectionDelta(overlay, base, 'cursor', 'skills'), ['added']);
  });
});

test('project scope rejects a missing root before planning', async () => {
  await withScratchHomes(async (homes) => {
    await assert.rejects(
      runSync({ project: path.join(homes.root, 'absent-repo') }),
      /does not exist or cannot be resolved/
    );
  });
});

test('one run reconciles the machine first and then what the repository adds', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seedSkill(homes, 'a');
    seedSkill(homes, 'b');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[skills]\nenabled = ["a"]\n'
    );
    projectConfig(project, '[applications.claude-code.skills]\nadd = ["b"]\n');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(
      fs.existsSync(path.join(skillsParentDir(homes, 'claude-code'), 'a', 'SKILL.md')),
      true,
      'the user phase distributes the machine selection'
    );
    assert.equal(fs.existsSync(path.join(project, '.claude', 'skills', 'b', 'SKILL.md')), true);
    assert.equal(
      fs.existsSync(path.join(project, '.claude', 'skills', 'a')),
      false,
      'the repository carries no copy of what the machine already holds'
    );

    // One report, and every row says which phase produced it.
    const scopes = report.entries.map((entry) => entry.scope);
    assert.ok(scopes.includes('user') && scopes.includes('project'), JSON.stringify(scopes));
    assert.ok(
      scopes.lastIndexOf('user') < scopes.indexOf('project'),
      `the whole user phase is read before the increment: ${JSON.stringify(scopes)}`
    );
  });
});

test('a project run and a plain run agree whichever happens first', async () => {
  for (const order of ['project-first', 'global-first'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project);
      fs.writeFileSync(
        path.join(project, '.asb.toml'),
        '[distribution.project]\nmode = "managed"\n\n[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["shared"]\n'
      );
      installApps(homes, 'claude-code');
      seedRule(homes, 'shared.md', 'Shared rule.\n');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["shared"]\n'
      );

      // Real writes in both orders: neither run may leak scope state that
      // changes what the other writes or leaves settled.
      const runs =
        order === 'project-first'
          ? [() => runSync({ project }), () => runSync()]
          : [() => runSync(), () => runSync({ project })];
      for (const run of runs) assert.equal((await run()).exitCode, 0, order);

      const globalStatus = await runSync({ dryRun: true });
      const projectStatus = await runSync({ dryRun: true, project });
      assert.equal(globalStatus.exitCode, 0, JSON.stringify(globalStatus.entries, null, 2));
      assert.equal(projectStatus.exitCode, 0, JSON.stringify(projectStatus.entries, null, 2));
      for (const entry of [...globalStatus.entries, ...projectStatus.entries]) {
        assert.notEqual(entry.detail, 'path-escape');
        if (entry.scope !== 'user' || entry.path === null) continue;
        assert.equal(
          entry.path.startsWith(`${project}${path.sep}`),
          false,
          `the user phase plans machine targets only (${entry.path})`
        );
      }
    });
  }
});

test('an ambient .asb.toml in the invocation directory runs the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    const nested = path.join(project, 'src');
    fs.mkdirSync(nested, { recursive: true });
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, { 'commands/repo.md': 'repo command\n' });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[commands]\nenabled = ["repo"]\n');
    const target = path.join(project, '.cursor', 'commands', 'repo.md');

    await inCwd(project, async () => {
      const report = await runSync();
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.equal(report.scope.project, project);
      assert.equal(fs.readFileSync(target, 'utf-8'), 'repo command\n');
    });

    fs.rmSync(path.join(project, '.cursor'), { recursive: true });
    await inCwd(nested, async () => {
      const report = await runSync();
      // Detection reads the invocation directory and only it: a subdirectory
      // of a repository is not the repository.
      assert.equal(report.scope.project, null);
      assert.deepEqual(
        report.entries.filter((entry) => entry.scope === 'project'),
        []
      );
      assert.equal(fs.existsSync(target), false);
    });
  });
});

test('an explicit -P names the root and the invocation directory is ignored', async () => {
  await withScratchHomes(async (homes) => {
    const named = path.join(homes.root, 'named');
    const ambient = path.join(homes.root, 'ambient');
    fs.mkdirSync(named);
    fs.mkdirSync(ambient);
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, { 'commands/named.md': 'named\n', 'commands/ambient.md': 'ambient\n' });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(named, '[commands]\nenabled = ["named"]\n');
    projectConfig(ambient, '[commands]\nenabled = ["ambient"]\n');

    await inCwd(ambient, async () => {
      const report = await runSync({ project: named });

      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.equal(report.scope.project, named);
      assert.equal(
        fs.readFileSync(path.join(named, '.cursor', 'commands', 'named.md'), 'utf-8'),
        'named\n'
      );
      assert.equal(fs.existsSync(path.join(ambient, '.cursor')), false);
    });
  });
});

test('the project registry exposes only ratified destinations and keeps global-only cells out', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    const projectReal = fs.realpathSync(project);
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex", "gemini", "opencode", "cursor", "trae", "trae-cn", "traecli", "custom"]',
        '',
        '[targets.custom.commands]',
        'target_dir = "~/global-commands"',
        'project_target_dir = ".custom/commands"',
        '',
        '[targets.custom.skills]',
        'parent_dir = "~/global-skills"',
        '',
      ].join('\n')
    );
    fs.writeFileSync(path.join(project, '.asb.toml'), '');
    const config = loadConfig({ project });
    const table = projectAppRows(appRows(config), config.project as string);
    const row = (id: string) => table.find((candidate) => candidate.id === id);
    const file = (id: string, cell: 'rules' | 'mcp') => row(id)?.[cell]?.path(config.homes);
    const dir = (id: string, cell: 'commands' | 'agents' | 'skills') =>
      row(id)?.[cell]?.dir(config.homes);

    // Per-app dialect in one place: the cells with a project destination, and
    // the cells that have none because the app reads them from the machine.
    const cells: Array<[string, string | undefined, string | undefined]> = [
      [
        'claude-code rules',
        file('claude-code', 'rules'),
        path.join(projectReal, '.claude', 'CLAUDE.md'),
      ],
      ['codex commands', dir('codex', 'commands'), undefined],
      ['gemini agents', dir('gemini', 'agents'), undefined],
      [
        'opencode mcp',
        file('opencode', 'mcp'),
        path.join(projectReal, '.opencode', 'opencode.json'),
      ],
      ['trae skills', dir('trae', 'skills'), path.join(projectReal, '.trae', 'skills')],
      ['trae-cn mcp', file('trae-cn', 'mcp'), path.join(projectReal, '.trae', 'mcp.json')],
      ['traecli rules', file('traecli', 'rules'), path.join(projectReal, 'AGENTS.md')],
      ['traecli commands', dir('traecli', 'commands'), undefined],
      ['traecli mcp', file('traecli', 'mcp'), undefined],
      ['custom commands', dir('custom', 'commands'), path.join(projectReal, '.custom', 'commands')],
      ['custom rules', file('custom', 'rules'), undefined],
      ['custom skills', dir('custom', 'skills'), undefined],
    ];
    for (const [label, actual, expected] of cells) assert.equal(actual, expected, label);
  });
});

test('managed warn-skip preserves one foreign file while independent project writes continue', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, {
      'commands/build.md': 'desired build\n',
      'commands/ship.md': 'desired ship\n',
      'commands/global.md': 'desired global\n',
    });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["global"]\n'
    );
    projectConfig(project, '[commands]\nenabled = ["build", "ship"]\n');
    const occupied = path.join(project, '.cursor', 'commands', 'build.md');
    seedTree(project, { '.cursor/commands/build.md': 'foreign\n' });

    const report = await runSync({ project });

    // One exit code covers both phases: the user phase landed, the project
    // phase declined one file, and the run says so.
    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(occupied, 'utf-8'), 'foreign\n');
    assert.equal(
      fs.readFileSync(path.join(project, '.cursor', 'commands', 'ship.md'), 'utf-8'),
      'desired ship\n'
    );
    assert.equal(
      fs.readFileSync(path.join(homes.agentsHome, '.cursor', 'commands', 'global.md'), 'utf-8'),
      'desired global\n'
    );
    assert.equal(report.entries.find((entry) => entry.path === occupied)?.scope, 'project');
  });
});

test('managed collision error preflights the whole project before any write', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, {
      'commands/build.md': 'desired build\n',
      'commands/ship.md': 'desired ship\n',
    });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[commands]\nenabled = ["build", "ship"]\n', { collision: 'error' });
    const occupied = path.join(project, '.cursor', 'commands', 'build.md');
    seedTree(project, { '.cursor/commands/build.md': 'foreign\n' });

    const report = await runSync({ project });

    // One conflict cancels the whole project phase, targets that would have
    // succeeded included.
    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(occupied, 'utf-8'), 'foreign\n');
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'ship.md')), false);
  });
});

test('managed takeover overwrites the named foreign project target and then owns it', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, { 'commands/build.md': 'desired\n' });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[commands]\nenabled = ["build"]\n', { collision: 'takeover' });
    const occupied = path.join(project, '.cursor', 'commands', 'build.md');
    seedTree(project, { '.cursor/commands/build.md': 'foreign\n' });

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.readFileSync(occupied, 'utf-8'), 'desired\n');

    // The takeover leaves the render on the target, and that is the whole
    // proof it is asb's: deselecting the command reclaims those bytes.
    projectConfig(project, '[commands]\nenabled = []\n', { collision: 'takeover' });
    const deselected = await runSync({ project });

    assert.equal(deselected.exitCode, 0, JSON.stringify(deselected.entries, null, 2));
    assert.equal(fs.existsSync(occupied), false);
  });
});

test('a shared project AGENTS.md has exactly one marker writer whatever reads it', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex', 'gemini', 'opencode');
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    seedRule(homes, 'machine.md', '# Machine rule\n');
    seedRule(homes, 'project.md', '# Shared rule\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "gemini", "opencode", "traecli"]\n\n[rules]\nenabled = ["machine"]\n'
    );
    projectConfig(project, '[rules]\nenabled = ["machine", "project"]\n');
    const agents = path.join(project, 'AGENTS.md');
    fs.writeFileSync(agents, '# User instructions\n');

    const report = await runSync({ project });
    const content = fs.readFileSync(agents, 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(content.match(/<!-- rules:start -->/g)?.length, 1);
    assert.equal(content.match(/<!-- rules:end -->/g)?.length, 1);
    assert.ok(!/asb/i.test(content), 'the written project region never names asb');
    assert.ok(content.includes('<!-- rules:start -->\n# Shared rule\n<!-- rules:end -->'), content);
    assert.match(content, /# User instructions/);
    assert.ok(
      !content.includes('# Machine rule'),
      'the region composes the increment alone, so agent context stops double-loading'
    );
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8'),
      renderedRules('codex', '# Machine rule\n'),
      'the user phase never loads the project layer'
    );

    const rules = report.entries.filter((entry) => entry.type === 'rules');
    assert.deepEqual(
      rules
        .filter((entry) => entry.scope === 'user')
        .map((entry) => entry.app)
        .sort(),
      ['codex', 'gemini', 'opencode', 'traecli'],
      'four apps read the one project host'
    );
    assert.deepEqual(
      rules.filter((entry) => entry.scope === 'project').map((entry) => entry.path),
      [agents],
      'every contributor folds into the one region rather than writing beside it'
    );
    const scopes = rules.map((entry) => entry.scope);
    assert.ok(scopes.lastIndexOf('user') < scopes.indexOf('project'), JSON.stringify(scopes));
  });
});

test('malformed shared AGENTS markers fail closed without repair guessing', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedRule(homes, 'project.md', '# New rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectConfig(project, '[rules]\nenabled = ["project"]\n');
    const broken =
      '<!-- asb:rules:start -->\nold\n<!-- asb:rules:start -->\n<!-- asb:rules:end -->\n';
    const agents = path.join(project, 'AGENTS.md');
    fs.writeFileSync(agents, broken);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(agents, 'utf-8'), broken);
    assert.match(report.entries.find((entry) => entry.path === agents)?.reason ?? '', /duplicate/i);
  });
});

test('the project rules region honors its placement and restores the user bytes on deselection', async () => {
  // Trailing-boundary contract: the managed region joins user content with
  // exactly one blank line and the file ends with one newline; interior and
  // leading user bytes round-trip exactly under both placements.
  for (const placement of ['prepend', 'append'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, `project-${placement}`);
      fs.mkdirSync(project);
      const layer = `[distribution.project]\nmode = "managed"\n\n[distribution.project.rules]\nplacement = "${placement}"\n\n[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["shared", "repo"]\n`;
      fs.writeFileSync(path.join(project, '.asb.toml'), layer);
      const agents = path.join(project, 'AGENTS.md');
      const userBytes = '# First user section\n\n\n# Second user section\n';
      fs.writeFileSync(agents, userBytes);
      installApps(homes, 'codex');
      seedRule(homes, 'shared.md', 'Managed.\n');
      seedRule(homes, 'repo.md', 'Repository rule.\n');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["shared"]\n'
      );
      assert.equal((await runSync({ project })).exitCode, 0, placement);

      // The repository hosts the increment alone, at the placement it asked
      // for, joined to the user's own sections by one blank line.
      const region = '<!-- rules:start -->\nRepository rule.\n<!-- rules:end -->';
      assert.equal(
        fs.readFileSync(agents, 'utf-8'),
        placement === 'prepend' ? `${region}\n\n${userBytes}` : `${userBytes}\n${region}\n`,
        placement
      );

      fs.writeFileSync(
        path.join(project, '.asb.toml'),
        layer.replace('enabled = ["shared", "repo"]', 'enabled = ["shared"]')
      );
      assert.equal((await runSync({ project })).exitCode, 0, placement);
      assert.equal(fs.readFileSync(agents, 'utf-8'), userBytes, placement);
    });
  }
});

test('a region an earlier version wrapped is rewritten in place, not duplicated', () => {
  const existing =
    'Mine above\n<!-- asb:rules:start -->\nold\n<!-- asb:rules:end -->\nMine below\n';
  const result = mergeProjectRegion(existing, 'new');

  assert.equal(result.match(/<!-- rules:start -->/g)?.length, 1);
  assert.ok(!result.includes('asb:rules'));
  assert.ok(!result.includes('old'));
  assert.ok(result.includes('new'));
  assert.ok(result.includes('Mine above'));
  assert.ok(result.includes('Mine below'));
});

test('the project marker parser accepts one pair in either spelling and rejects partial or reordered pairs', () => {
  assert.equal(
    projectRegion('before\n<!-- rules:start -->\nmanaged\n<!-- rules:end -->\nafter\n'),
    '<!-- rules:start -->\nmanaged\n<!-- rules:end -->'
  );
  assert.equal(
    projectRegion('before\n<!-- asb:rules:start -->\nmanaged\n<!-- asb:rules:end -->\nafter\n'),
    '<!-- asb:rules:start -->\nmanaged\n<!-- asb:rules:end -->'
  );
  assert.throws(() => projectRegion('<!-- rules:start -->\nmanaged\n'), /incomplete/i);
  assert.throws(() => projectRegion('<!-- asb:rules:start -->\nmanaged\n'), /incomplete/i);
  assert.throws(
    () => projectRegion('<!-- rules:end -->\nmanaged\n<!-- rules:start -->\n'),
    /reordered/i
  );
});

test('a dedicated project rules file follows the increment because its bytes prove the render', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    seedRule(homes, 'beta.md', 'Beta body\n');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[rules]\nenabled = ["alpha", "beta"]\n');
    const target = path.join(project, '.cursor', 'rules', 'rules.mdc');

    const first = await runSync({ project });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));
    assert.equal(
      fs.readFileSync(target, 'utf-8'),
      renderedRules('cursor', 'Alpha body\n\nBeta body\n')
    );

    // The machine takes alpha over, so the increment shrinks to beta. What
    // sits in the repository is a render of library blocks — stale, but still
    // asb's — and it is rewritten rather than preserved as foreign content.
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[rules]\nenabled = ["alpha"]\n'
    );
    const shrunk = await runSync({ project });
    assert.equal(shrunk.exitCode, 0, JSON.stringify(shrunk.entries, null, 2));
    assert.equal(fs.readFileSync(target, 'utf-8'), renderedRules('cursor', 'Beta body\n'));

    // Nothing left to add: the file goes instead of double-loading a rule the
    // machine already carries in ~/.cursor.
    projectConfig(project, '[rules]\nenabled = ["alpha"]\n');
    const emptied = await runSync({ project });
    assert.equal(emptied.exitCode, 0, JSON.stringify(emptied.entries, null, 2));
    assert.equal(fs.existsSync(target), false);

    // An edited copy is not a render: ownership stays derived, so it stands.
    // Preserving it is the run working as intended, so the row carries the
    // whole signal and the exit code stays clean.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# The repository wrote this\n');
    projectConfig(project, '[rules]\nenabled = ["alpha", "beta"]\n');
    const foreign = await runSync({ project });
    assert.equal(foreign.exitCode, 0, JSON.stringify(foreign.entries, null, 2));
    assert.equal(fs.readFileSync(target, 'utf-8'), '# The repository wrote this\n');
    const kept = foreign.entries.find((entry) => entry.path === target);
    assert.equal(kept?.outcome, 'left-behind', JSON.stringify(foreign.entries, null, 2));
    assert.equal(kept?.detail, 'unproven');
  });
});

test('exclusive cleanup removes recognizable files and non-reserved bundles', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, { 'commands/build.md': 'desired\n' });
    seedSkill(homes, 'kept-before');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(
      project,
      '[commands]\nenabled = ["build"]\n\n[skills]\nenabled = ["kept-before"]\n'
    );
    const first = await runSync({ project });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));

    projectConfig(project, '[commands]\nenabled = []\n\n[skills]\nenabled = []\n', {
      mode: 'exclusive',
    });
    seedTree(project, {
      '.cursor/skills/orphan/SKILL.md': 'foreign\n',
      '.cursor/skills/.system/KEEP': 'reserved\n',
    });

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'skills', 'orphan')), false);
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'skills', '.system', 'KEEP')), true);

    projectConfig(project, '[commands]\nenabled = ["build"]\n');
    const managedAgain = await runSync({ project });
    assert.equal(managedAgain.exitCode, 0, JSON.stringify(managedAgain.entries, null, 2));
    assert.equal(
      fs.readFileSync(path.join(project, '.cursor', 'commands', 'build.md'), 'utf-8'),
      'desired\n'
    );
  });
});

test('project mode none skips the whole phase while the machine still reconciles', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, { 'commands/build.md': 'desired\n', 'commands/repo.md': 'repo\n' });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build"]\n'
    );
    // An increment the repository would otherwise receive, and does not.
    projectConfig(project, '[commands]\nenabled = ["build", "repo"]\n', { mode: 'none' });

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.cursor')), false);
    assert.deepEqual(
      report.entries.filter((entry) => entry.scope === 'project'),
      [],
      'no phase ran, so there is nothing to report about one'
    );
    // A root nothing reconciled is not this run's scope.
    assert.equal(report.scope.project, null);
    assert.equal(
      fs.readFileSync(path.join(homes.agentsHome, '.cursor', 'commands', 'build.md'), 'utf-8'),
      'desired\n'
    );
  });
});

test('an increment for a cell with no project destination is named, not dropped', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedTree(homes.asbHome, { 'commands/build.md': 'desired build\n' });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectConfig(project, '[commands]\nenabled = ["build"]\n');

    const report = await runSync({ project });
    const row = report.entries.find((entry) => entry.detail === 'no-project-target');

    // Codex reads prompts from the machine alone, so the repository has
    // nowhere to put one. The gap is a row: nothing lands silently in the
    // repository, and nothing lands globally instead.
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(row?.outcome, 'skipped', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.scope, 'project');
    assert.equal(row?.app, 'codex');
    assert.equal(row?.type, 'commands');
    assert.match(row?.reason ?? '', /build/);
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.codex', 'prompts', 'build.md')),
      false
    );
    assert.deepEqual(fs.readdirSync(project), ['.asb.toml']);
  });
});

test('the project union directory holds the increment, never the machine copies', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex', 'gemini');
    seedSkill(homes, 'alpha');
    seedSkill(homes, 'repo');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "gemini"]\n\n[skills]\nenabled = ["alpha"]\n\n[distribution]\nuse_agents_dir = true\n'
    );
    projectConfig(project, '[skills]\nenabled = ["alpha", "repo"]\n');

    const report = await runSync({ project });
    const projectUnion = path.join(project, '.agents', 'skills');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(projectUnion, 'repo', 'SKILL.md')), true);
    assert.equal(
      fs.existsSync(path.join(projectUnion, 'alpha')),
      false,
      'every member already reads alpha from the machine union'
    );
    assert.equal(
      fs.existsSync(path.join(skillsParentDir(homes, 'agents'), 'alpha', 'SKILL.md')),
      true
    );
    const written = report.entries.filter(
      (entry) => entry.type === 'skills' && entry.id === 'repo'
    );
    assert.equal(written.length, 1, 'both members share the one project union destination');
    assert.equal(written[0]?.scope, 'project');
    assert.equal(written[0]?.path, path.join(projectUnion, 'repo'));
  });
});

const LINT_LIBRARY = {
  UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo lint' }] }],
};
const LINT_RENDERED = { matcher: '*', hooks: [{ type: 'command', command: 'echo lint' }] };
const WATCH_LIBRARY = {
  UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo watch' }] }],
};
const WATCH_RENDERED = { matcher: '*', hooks: [{ type: 'command', command: 'echo watch' }] };
const USER_GROUP = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] };

function seedHook(homes: ScratchHomes, id: string, hooks: unknown): void {
  seedTree(homes.asbHome, { [`hooks/${id}.json`]: JSON.stringify({ name: id, hooks }, null, 2) });
}

function hookConfig(apps: readonly string[], hooks: readonly string[]): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${list(apps)}]\n\n[hooks]\nenabled = [${list(hooks)}]\n`;
}

function eventGroups(filePath: string, event: string): Array<Record<string, unknown>> {
  const root = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const hooks = root.hooks as Record<string, unknown[]> | undefined;
  return (hooks?.[event] ?? []) as Array<Record<string, unknown>>;
}

test('only the hooks a repository adds over the user level land in it', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    seedHook(homes, 'watch', WATCH_LIBRARY);
    writeUserConfig(homes, hookConfig(['claude-code'], ['lint']));
    fs.writeFileSync(path.join(project, '.asb.toml'), '[hooks]\nenabled = ["lint", "watch"]\n');

    const report = await runSync({ project });
    const local = path.join(project, '.claude', 'settings.local.json');
    const machine = path.join(homes.agentsHome, '.claude', 'settings.json');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(eventGroups(machine, 'UserPromptSubmit'), [LINT_RENDERED]);
    // The machine's config loads `lint` in every directory, so a repository
    // copy would run it twice; `watch` is what this repository adds.
    assert.deepEqual(eventGroups(local, 'UserPromptSubmit'), [WATCH_RENDERED]);
    assert.equal(
      report.entries.find((entry) => entry.type === 'hooks' && entry.path === local)?.scope,
      'project'
    );
  });
});

test('a hook the user level takes over leaves the repository, its own groups intact', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    writeUserConfig(homes, hookConfig(['claude-code'], []));
    fs.writeFileSync(path.join(project, '.asb.toml'), '[hooks]\nenabled = ["lint"]\n');

    // The repository as an earlier run left it, plus a group of its own.
    await runSync({ project });
    const local = path.join(project, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(local, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    settings.hooks.UserPromptSubmit.unshift(USER_GROUP);
    fs.writeFileSync(local, `${JSON.stringify(settings, null, 2)}\n`);

    writeUserConfig(homes, hookConfig(['claude-code'], ['lint']));
    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    // The group holds the render, so it is asb's and goes; the repository's own
    // group is nobody's business but its author's.
    assert.deepEqual(eventGroups(local, 'UserPromptSubmit'), [USER_GROUP]);
    assert.deepEqual(
      eventGroups(path.join(homes.agentsHome, '.claude', 'settings.json'), 'UserPromptSubmit'),
      [LINT_RENDERED]
    );
  });
});

test('includeDelimiters resolves from global config and the project layer overrides it', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabled = ["alpha"]\nincludeDelimiters = true\n');
    seedRule(homes, 'alpha.md', 'Alpha body\n');

    assert.equal(loadConfig().rules.includeDelimiters, true);

    const inheriting = path.join(homes.root, 'project-inherit');
    fs.mkdirSync(inheriting, { recursive: true });
    fs.writeFileSync(path.join(inheriting, '.asb.toml'), '[rules]\nenabled = ["alpha"]\n', 'utf-8');
    assert.equal(loadConfig({ project: inheriting }).rules.includeDelimiters, true);

    const overriding = path.join(homes.root, 'project-override');
    fs.mkdirSync(overriding, { recursive: true });
    fs.writeFileSync(
      path.join(overriding, '.asb.toml'),
      '[rules]\nenabled = ["alpha"]\nincludeDelimiters = false\n',
      'utf-8'
    );
    assert.equal(loadConfig({ project: overriding }).rules.includeDelimiters, false);
  });
});

test('a repository layer adds, hides, and flips nothing at user scope', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code', 'cursor');
    seedSkill(homes, 'present');
    seedSkill(homes, 'repo-only');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[skills]\nenabled = ["present", "gone"]\n'
    );
    // The repository replaces both lists it names, which under the frozen merge
    // is the strongest thing a layer can do: a different app, a different
    // selection, and no mention of the id the machine is missing.
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[applications]\nenabled = ["cursor"]\n\n[skills]\nenabled = ["repo-only"]\n'
    );

    const plain = await runSync({ dryRun: true });
    const withRepo = await runSync({ dryRun: true, project });
    const userRows = (report: Awaited<ReturnType<typeof runSync>>) =>
      report.entries.filter((entry) => entry.scope === 'user');

    assert.deepEqual(userRows(withRepo), userRows(plain));
    assert.ok(
      userRows(plain).some((entry) => entry.id === 'gone' && entry.outcome === 'missing'),
      JSON.stringify(plain.entries, null, 2)
    );
    assert.equal(plain.exitCode, 1);
    assert.equal(withRepo.exitCode, plain.exitCode, 'a repository cannot answer for the machine');
    assert.equal(
      userRows(withRepo).some((entry) => entry.id === 'repo-only'),
      false,
      'and what it adds stays in it'
    );
    for (const entry of userRows(withRepo)) {
      assert.equal(
        entry.path?.startsWith(`${project}${path.sep}`) ?? false,
        false,
        `the user phase plans machine targets only (${entry.path})`
      );
    }
    assert.ok(
      withRepo.entries.some(
        (entry) => entry.scope === 'project' && entry.id === 'repo-only' && entry.app === 'cursor'
      ),
      JSON.stringify(withRepo.entries, null, 2)
    );
  });
});

test('a repository re-pointing a namespace changes no render and is reported all the same', async () => {
  // Neither vendor directory sits under <asbHome>/plugins, so a declaration is
  // the only thing that can make the namespace resolve.
  for (const layer of ['a source of its own', "config.toml's own source"] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project);
      const machineSource = path.join(homes.root, 'vendor', 'machine');
      const repoSource = path.join(homes.root, 'vendor', 'repo');
      seedTree(machineSource, { 'rules/base.md': 'Machine body\n' });
      seedTree(repoSource, { 'rules/base.md': 'Repository body\n' });
      installApps(homes, 'claude-code');
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
          `team = ${JSON.stringify(machineSource)}`,
          '',
        ].join('\n')
      );
      const declared = layer === 'a source of its own' ? repoSource : machineSource;
      fs.writeFileSync(
        path.join(project, '.asb.toml'),
        ['[plugins.sources]', `team = ${JSON.stringify(declared)}`, ''].join('\n')
      );

      const report = await runSync({ project });
      const host = fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8');
      const rows = report.entries.filter((entry) => entry.detail === 'project-source');

      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.match(host, /Machine body/);
      assert.equal(
        host.includes('Repository body'),
        false,
        'the namespace resolves where config.toml points it, in every directory'
      );
      // The row is what tells the operator the namespace resolves from the
      // machine's declaration alone, even when the repository repeats it.
      assert.equal(rows.length, 1, JSON.stringify(report.entries, null, 2));
      assert.equal(rows[0]?.id, 'team');
      assert.equal(rows[0]?.scope, 'project');
      assert.equal(rows[0]?.outcome, 'skipped');
    });
  }
});

test('a repository [plugins] sub-table adds to the base selection instead of clearing it', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const teamSource = path.join(homes.root, 'team-plugin');
    fs.mkdirSync(project);
    seedTree(teamSource, { 'rules/style.md': 'Team style\n' });
    installApps(homes, 'claude-code', 'cursor');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["team"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(teamSource)}`,
        '',
      ].join('\n')
    );
    // The repository writes no `enabled` array, so the `[plugins]` object
    // deep-merges: cursor's whole selection, the plugin's expansion included,
    // is the increment.
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      [
        '[applications]',
        'enabled = ["claude-code", "cursor"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(teamSource)}`,
        '',
      ].join('\n')
    );

    assert.deepEqual(loadConfig({ project }).selection.plugins, ['team']);
    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.match(
      fs.readFileSync(path.join(project, '.cursor', 'rules', 'rules.mdc'), 'utf-8'),
      /Team style/
    );

    // Every other `[plugins]` spelling merges the same way, and `source` is a
    // name like any other in the modern map: reading it as a legacy plugin
    // sub-table would fabricate an empty `enabled` that clears the inheritance.
    for (const body of [
      '[plugins.exclude]\nrules = ["team:none"]\n',
      '[plugins.sources]\nsource = "/vendor/x"\n',
    ]) {
      fs.writeFileSync(path.join(project, '.asb.toml'), body);
      assert.deepEqual(loadConfig({ project }).selection.plugins, ['team'], body);
    }
  });
});

test('an ambient .asb.toml the loader rejects is one row, never an aborted run', async () => {
  // The two ways a repository layer can be unusable: the loader rejects the
  // file, and the app table rejects what it declares.
  for (const broken of ['not = toml = here\n', '[targets.claude-code.rules]\nfile_path = "x"\n']) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project);
      installApps(homes, 'claude-code');
      seedRule(homes, 'alpha.md', 'Alpha body\n');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
      );
      fs.writeFileSync(path.join(project, '.asb.toml'), broken);

      const report = await inCwd(project, () => runSync());

      // The machine still reconciles: an unusable repository layer costs the
      // project phase, not the run.
      assert.match(fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'), /Alpha body/);
      const row = report.entries.find((entry) => entry.detail === 'project-config');
      assert.equal(row?.outcome, 'failed', JSON.stringify(report.entries, null, 2));
      assert.equal(row?.path, path.join(project, '.asb.toml'));
      assert.notEqual(report.exitCode, 0);
      assert.equal(report.scope.project, null);
    });
  }
});
