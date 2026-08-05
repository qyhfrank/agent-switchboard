import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import type { Report } from '../src/engine/report.js';
import {
  detectDir,
  inCwd,
  installApps,
  renderedRules,
  ruleFilePath,
  type ScratchHomes,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  seedTree,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * One tree cannot be both scopes, and no project write may leave the tree it
 * belongs to. A repository layer that would reach a machine surface is refused
 * or blocked before the write, and the machine keeps whatever the user phase
 * just put there.
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

function projectRows(report: Report) {
  return report.entries.filter((entry) => entry.scope === 'project');
}

function mutations(report: Report) {
  return projectRows(report).filter((entry) => ['written', 'removed'].includes(entry.outcome));
}

interface HeldRoot {
  name: string;
  /** Builds the fixture; returns the root to sync, what must survive, what the row must name. */
  setup(homes: ScratchHomes): { project: string; survivors: string[]; named: string[] };
}

/**
 * `asb init` run in the home directory, or a dotfiles repository that aliases a
 * machine directory into itself. The project phase would read the user phase's
 * fresh writes as renders nothing asks for any more and take them out.
 */
const agentsHomeRoot =
  (body: string) =>
  (homes: ScratchHomes): ReturnType<HeldRoot['setup']> => {
    installApps(homes, 'claude-code');
    seedSkill(homes, 'alpha');
    seedRule(homes, 'house.md', '# House rule\n');
    seedTree(homes.asbHome, { 'commands/build.md': 'desired build\n' });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[skills]',
        'enabled = ["alpha"]',
        '',
        '[rules]',
        'enabled = ["house"]',
        '',
        '[commands]',
        'enabled = ["build"]',
        '',
      ].join('\n')
    );
    fs.writeFileSync(path.join(homes.agentsHome, '.asb.toml'), body);
    return {
      project: homes.agentsHome,
      survivors: [
        path.join(skillsParentDir(homes, 'claude-code'), 'alpha', 'SKILL.md'),
        path.join(homes.agentsHome, '.claude', 'CLAUDE.md'),
        path.join(homes.agentsHome, '.claude', 'commands', 'build.md'),
      ],
      named: [homes.agentsHome],
    };
  };

const HELD_ROOTS: readonly HeldRoot[] = [
  {
    name: 'the agents home declaring a managed project block',
    setup: agentsHomeRoot('[distribution.project]\nmode = "managed"\n'),
  },
  {
    // Refusal precedes mode resolution, so an empty layer is refused too.
    name: 'the agents home declaring nothing at all',
    setup: agentsHomeRoot('# nothing enabled here yet\n'),
  },
  {
    name: "an app's config directory aliased into the root",
    setup: (homes) => {
      const project = path.join(homes.root, 'project');
      const appDir = path.join(project, '.claude');
      fs.mkdirSync(appDir, { recursive: true });
      fs.symlinkSync(appDir, path.join(homes.agentsHome, '.claude'), 'dir');
      seedTree(homes.asbHome, { 'commands/review.md': 'review body\n' });
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["review"]\n'
      );
      projectConfig(project);
      return {
        project,
        survivors: [path.join(homes.agentsHome, '.claude', 'commands', 'review.md')],
        named: ['claude-code', path.join(homes.agentsHome, '.claude')],
      };
    },
  },
  {
    // Trae detects through its vendor data dir but writes under `~/.trae`, so
    // the alias is invisible to detection.
    name: "an app's write root aliased into the root",
    setup: (homes) => {
      const project = path.join(homes.root, 'project');
      const traeDir = path.join(project, '.trae');
      fs.mkdirSync(traeDir, { recursive: true });
      fs.symlinkSync(traeDir, path.join(homes.agentsHome, '.trae'), 'dir');
      installApps(homes, 'trae');
      seedSkill(homes, 'review');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["trae"]\n\n[skills]\nenabled = ["review"]\n'
      );
      projectConfig(project);
      return {
        project,
        survivors: [path.join(homes.agentsHome, '.trae', 'skills', 'review', 'SKILL.md')],
        named: ['trae', path.join(homes.agentsHome, '.trae')],
      };
    },
  },
  {
    // The union row writes under `~/.agents`, which belongs to no single app
    // row: the alias must be caught on the shared root itself.
    name: 'the shared agents directory aliased into the root',
    setup: (homes) => {
      const project = path.join(homes.root, 'project');
      const agentsDir = path.join(project, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.symlinkSync(agentsDir, path.join(homes.agentsHome, '.agents'), 'dir');
      installApps(homes, 'codex');
      seedSkill(homes, 'review');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["codex"]\n\n[skills]\nenabled = ["review"]\n\n[distribution]\nuse_agents_dir = true\n'
      );
      projectConfig(project);
      return {
        project,
        survivors: [path.join(homes.agentsHome, '.agents', 'skills', 'review', 'SKILL.md')],
        named: [path.join(homes.agentsHome, '.agents')],
      };
    },
  },
];

test('a project root holding a machine surface is refused whole, however the root arrives', async () => {
  for (const candidate of HELD_ROOTS) {
    await withScratchHomes(async (homes) => {
      const { project, survivors, named } = candidate.setup(homes);

      // Detected in the invocation directory, and named outright: neither way
      // in gets a project phase.
      for (const run of [
        () => inCwd(project, () => runSync()),
        () => runSync({ project }),
      ] as const) {
        const report = await run();
        const detail = `${candidate.name}: ${JSON.stringify(report.entries, null, 2)}`;

        assert.equal(report.exitCode, 0, detail);
        for (const target of survivors) {
          assert.ok(fs.existsSync(target), `${target} survives the run that wrote it`);
        }
        assert.equal(report.scope.project, null, candidate.name);
        assert.deepEqual(projectRows(report), [], detail);
        const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
        assert.equal(refusals.length, 1, detail);
        assert.equal(refusals[0]?.outcome, 'skipped', detail);
        for (const token of named) {
          assert.ok(refusals[0]?.reason?.includes(token), `${detail}\nmissing ${token}`);
        }
      }
    });
  }
});

test('a user leaf whose write location is a project cell refuses the project phase', async () => {
  // A leaf link is written through at user scope, so the command's real bytes
  // would land on the very cell the empty increment then sweeps. Directory-root
  // matching cannot see the overlap; the write location can.
  const shapes = [
    {
      name: 'a user link onto an existing cell file',
      cell: (project: string) => {
        const cell = path.join(project, '.claude', 'commands', 'review.md');
        fs.mkdirSync(path.dirname(cell), { recursive: true });
        fs.writeFileSync(cell, 'stale\n');
        return cell;
      },
    },
    {
      // The write path follows a dangling link and creates the backing file,
      // so the scan must resolve where realpath cannot.
      name: 'a dangling user link onto a cell that does not exist yet',
      cell: (project: string) => path.join(project, '.claude', 'commands', 'review.md'),
    },
    {
      // The repository aliases its own cell directory, so the cell's write
      // location must be resolved the way the writes resolve it.
      name: 'a user link onto a cell directory the repository aliases',
      cell: (project: string) => {
        const shared = path.join(project, 'shared-commands');
        fs.mkdirSync(shared, { recursive: true });
        fs.writeFileSync(path.join(shared, 'review.md'), 'stale\n');
        fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
        fs.symlinkSync(shared, path.join(project, '.claude', 'commands'), 'dir');
        return path.join(shared, 'review.md');
      },
    },
  ];

  for (const shape of shapes) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project, { recursive: true });
      const cell = shape.cell(project);
      installApps(homes, 'claude-code');
      seedTree(homes.asbHome, { 'commands/review.md': 'review body\n' });
      const userFile = path.join(homes.agentsHome, '.claude', 'commands', 'review.md');
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.symlinkSync(cell, userFile);
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["review"]\n'
      );
      projectConfig(project);

      const report = await inCwd(project, () => runSync());
      const detail = `${shape.name}: ${JSON.stringify(report.entries, null, 2)}`;

      assert.equal(report.exitCode, 0, detail);
      assert.ok(fs.existsSync(userFile), 'the machine keeps the command it just installed');
      assert.equal(report.scope.project, null, shape.name);
      assert.deepEqual(projectRows(report), [], detail);
      const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
      assert.equal(refusals.length, 1, detail);
      assert.ok(refusals[0]?.reason?.includes(userFile), detail);
    });
  }
});

test('a project leaf symlinked out of the repository is blocked, not written through', async () => {
  // A committed link at the project leaf points out of the tree: the user phase
  // writes the render of `alpha` on the machine, and the increment must not
  // follow the link back out of the repository.
  const shapes = [
    { name: 'a link onto the machine rules file', outside: null },
    { name: 'a dangling link onto a path outside the tree', outside: 'outside/rules.mdc' },
  ];

  for (const shape of shapes) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project);
      installApps(homes, 'cursor');
      seedRule(homes, 'alpha.md', 'Alpha body\n');
      seedRule(homes, 'beta.md', 'Beta body\n');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["cursor"]\n\n[rules]\nenabled = ["alpha"]\n'
      );
      projectConfig(project, '[rules]\nenabled = ["alpha", "beta"]\n');
      const userTarget = ruleFilePath(homes, 'cursor');
      const outside = shape.outside === null ? userTarget : path.join(homes.root, shape.outside);
      if (shape.outside !== null) fs.mkdirSync(path.dirname(outside), { recursive: true });
      const projectTarget = path.join(project, '.cursor', 'rules', 'rules.mdc');
      fs.mkdirSync(path.dirname(projectTarget), { recursive: true });
      fs.symlinkSync(outside, projectTarget);

      const report = await runSync({ project });
      const detail = `${shape.name}: ${JSON.stringify(report.entries, null, 2)}`;
      const blockedRow = (candidate: Report) =>
        candidate.entries.find(
          (entry) => entry.scope === 'project' && entry.path === projectTarget
        );

      assert.equal(report.exitCode, 1, detail);
      assert.equal(blockedRow(report)?.outcome, 'blocked', detail);
      assert.equal(blockedRow(report)?.detail, 'path-escape', detail);
      assert.equal(
        fs.lstatSync(projectTarget).isSymbolicLink(),
        true,
        'the link is left alone, not replaced by a real file'
      );
      assert.equal(
        fs.readFileSync(userTarget, 'utf-8'),
        renderedRules('cursor', 'Alpha body\n'),
        'the machine keeps what its own phase wrote'
      );
      if (shape.outside !== null) {
        assert.equal(fs.existsSync(outside), false, 'the increment creates nothing outside');
      }

      // The capture decides it, so a dry run names the identical row.
      const dry = await runSync({ project, dryRun: true });
      assert.equal(blockedRow(dry)?.outcome, 'blocked', JSON.stringify(dry.entries, null, 2));
      assert.equal(blockedRow(dry)?.detail, 'path-escape', shape.name);
    });
  }
});

test('a project parent escaping the repository blocks even when the leaf loops back', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const outside = path.join(homes.root, 'outside-dir');
    const shared = path.join(project, 'shared', 'review.md');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, 'user bytes\n');
    // The parent chain leaves the repository and the leaf links back in: the
    // parent rule must still call it an escape, or the round trip reaches files
    // other cells never named.
    fs.symlinkSync(outside, path.join(project, '.claude', 'commands'), 'dir');
    fs.symlinkSync(shared, path.join(outside, 'review.md'));
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, { 'commands/review.md': 'review body\n' });
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    projectConfig(project, '[commands]\nenabled = ["review"]\n', { mode: 'exclusive' });

    const report = await runSync({ project });
    const row = projectRows(report).find((entry) => entry.type === 'commands');

    assert.equal(fs.readFileSync(shared, 'utf-8'), 'user bytes\n', 'the loop reaches nothing');
    assert.equal(row?.outcome, 'blocked', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.detail, 'path-escape');
    assert.equal(report.exitCode, 1);
  });
});

test('two leaves meeting on one shared file block the project write', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const shared = path.join(project, 'shared', 'review.md');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, '');
    fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
    // The user rules host and a project command leaf both resolve to one
    // in-repository file: parent and leaf containment both pass, so only the
    // write location itself can reveal the overlap.
    fs.symlinkSync(shared, path.join(project, '.claude', 'commands', 'review.md'));
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    seedTree(homes.asbHome, { 'commands/review.md': 'review body\n' });
    const userRules = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(userRules), { recursive: true });
    fs.symlinkSync(shared, userRules);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );
    projectConfig(project, '[commands]\nenabled = ["review"]\n', { mode: 'exclusive' });

    const report = await runSync({ project });
    const row = projectRows(report).find((entry) => entry.type === 'commands');

    assert.match(
      fs.readFileSync(shared, 'utf-8'),
      /Alpha body/,
      'the machine keeps the rules it just installed'
    );
    assert.doesNotMatch(fs.readFileSync(shared, 'utf-8'), /review body/);
    assert.equal(row?.outcome, 'blocked', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.detail, 'path-escape');
  });
});

test('a user file aliased elsewhere into the repository keeps the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    seedTree(homes.asbHome, { 'commands/repo.md': 'repo command\n' });
    // A dotfiles-style link of the rules host to a repo path no project cell
    // manages: write-through and the project phase coexist. The negative that
    // stops the refusal scan from over-refusing every dotfiles repository.
    const repoCopy = path.join(project, 'CLAUDE.md');
    fs.writeFileSync(repoCopy, '');
    const userFile = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.symlinkSync(repoCopy, userFile);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );
    projectConfig(project, '[commands]\nenabled = ["repo"]\n');

    const report = await inCwd(project, () => runSync());

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.match(fs.readFileSync(repoCopy, 'utf-8'), /Alpha body/);
    assert.equal(report.scope.project, fs.realpathSync(project));
    assert.match(
      fs.readFileSync(path.join(project, '.claude', 'commands', 'repo.md'), 'utf-8'),
      /repo command/
    );
    assert.deepEqual(
      report.entries.filter((entry) => entry.detail === 'project-refused'),
      []
    );
  });
});

test('a project run never reaches a machine host aliased into the repository', async () => {
  // The guard enumerates every app row, enabled or not, and resolves hosts the
  // way the writes do: losing either deletes machine config.
  const scenarios: Array<{ name: string; setup(homes: ScratchHomes): Promise<string> }> = [
    {
      name: 'the repository layer disables every app',
      setup: async (homes) => {
        const project = path.join(homes.root, 'project');
        fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
        installApps(homes, 'cursor');
        seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
        const userHost = path.join(homes.agentsHome, '.cursor', 'mcp.json');
        fs.mkdirSync(path.dirname(userHost), { recursive: true });
        fs.symlinkSync(path.join(project, '.cursor', 'mcp.json'), userHost);
        writeUserConfig(
          homes,
          '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n'
        );
        projectConfig(project, '[applications]\nenabled = []\n');
        return userHost;
      },
    },
    {
      name: 'the machine left the app behind and its config lay dormant',
      setup: async (homes) => {
        const project = path.join(homes.root, 'project');
        fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
        installApps(homes, 'cursor', 'claude-code');
        seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
        const userHost = path.join(homes.agentsHome, '.cursor', 'mcp.json');
        fs.mkdirSync(path.dirname(userHost), { recursive: true });
        fs.symlinkSync(path.join(project, '.cursor', 'mcp.json'), userHost);
        // Yesterday's run, cursor enabled: the machine wrote alpha through the
        // link. Cursor then left the user selection, and the dormant config
        // kept its render.
        writeUserConfig(
          homes,
          '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n'
        );
        await inCwd(homes.root, () => runSync());
        assert.match(fs.readFileSync(userHost, 'utf-8'), /alpha/);
        writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
        projectConfig(project);
        return userHost;
      },
    },
    {
      name: 'the dormant host is chosen by a dynamic selector',
      setup: async (homes) => {
        const project = path.join(homes.root, 'project');
        const shared = path.join(project, 'shared', 'opencode.json');
        fs.mkdirSync(path.dirname(shared), { recursive: true });
        installApps(homes, 'opencode', 'claude-code');
        seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
        const opencodeRoot = detectDir(homes, 'opencode');
        fs.symlinkSync(shared, path.join(opencodeRoot, 'opencode.json'));
        writeUserConfig(
          homes,
          '[applications]\nenabled = ["opencode"]\n\n[mcp]\nenabled = ["alpha"]\n'
        );
        await inCwd(homes.root, () => runSync());
        assert.match(fs.readFileSync(shared, 'utf-8'), /alpha/);

        // The jsonc sibling moves the machine's host, and the repository
        // selects a server of its own through the same physical file.
        writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
        fs.writeFileSync(path.join(opencodeRoot, 'opencode.jsonc'), '{}');
        fs.mkdirSync(path.join(project, '.opencode'));
        fs.symlinkSync(shared, path.join(project, '.opencode', 'opencode.json'));
        projectConfig(
          project,
          '[applications]\nenabled = ["opencode"]\n\n[mcp]\nenabled = ["beta"]\n'
        );
        return shared;
      },
    },
  ];

  for (const scenario of scenarios) {
    await withScratchHomes(async (homes) => {
      const host = await scenario.setup(homes);

      const report = await runSync({ project: path.join(homes.root, 'project') });
      const content = fs.readFileSync(host, 'utf-8');

      assert.match(content, /alpha/, `${scenario.name}: the machine keeps its own server`);
      assert.doesNotMatch(content, /beta/, scenario.name);
      assert.deepEqual(
        mutations(report),
        [],
        `${scenario.name}: ${JSON.stringify(report.entries, null, 2)}`
      );
    });
  }
});

test('a project run that cannot enumerate a machine surface fails closed and touches nothing', async () => {
  // A legacy OpenCode skill directory links into the repository, so an
  // exclusive sweep would reach the machine's copy unless the guard sees it.
  // Under a privileged user these modes grant access anyway and the case
  // passes without exercising the flag; the suite runs unprivileged.
  for (const variant of ['an unreadable directory', 'an unresolvable link chain'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project);
      installApps(homes, 'opencode', 'claude-code');
      const librarySkill = seedSkill(homes, 'check');
      const sharedSkill = path.join(project, 'shared-skills', 'check');
      fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
      fs.cpSync(librarySkill, sharedSkill, { recursive: true });
      const legacyDir = path.join(detectDir(homes, 'opencode'), 'skill');
      fs.mkdirSync(legacyDir);

      let restricted = legacyDir;
      let mode = 0o111;
      if (variant === 'an unreadable directory') {
        fs.symlinkSync(sharedSkill, path.join(legacyDir, 'check'), 'dir');
      } else {
        const blocked = path.join(homes.root, 'blocked');
        fs.mkdirSync(blocked);
        fs.symlinkSync(path.join(project, 'shared-skills'), path.join(blocked, 'jump'), 'dir');
        fs.symlinkSync(path.join(blocked, 'jump', 'check'), path.join(legacyDir, 'check'), 'dir');
        restricted = blocked;
        mode = 0o000;
      }

      writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
      fs.mkdirSync(path.join(project, '.opencode'));
      fs.symlinkSync(
        path.join(project, 'shared-skills'),
        path.join(project, '.opencode', 'skills'),
        'dir'
      );
      projectConfig(project, '[applications]\nenabled = ["opencode"]\n\n[skills]\nenabled = []\n', {
        mode: 'exclusive',
      });

      fs.chmodSync(restricted, mode);
      try {
        const report = await runSync({ project });

        assert.equal(
          fs.readFileSync(path.join(sharedSkill, 'SKILL.md'), 'utf-8'),
          fs.readFileSync(path.join(librarySkill, 'SKILL.md'), 'utf-8'),
          `${variant}: the machine keeps what the run cannot enumerate`
        );
        assert.deepEqual(mutations(report), [], JSON.stringify(report.entries, null, 2));
      } finally {
        fs.chmodSync(restricted, 0o755);
      }
    });
  }
});

test('a failed exclusive cleanup fails the run and preserves the escaping link', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedSkill(homes, 'managed');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[skills]\nenabled = ["managed"]\n');
    await runSync({ project });
    projectConfig(project, '[skills]\nenabled = []\n', { mode: 'exclusive' });
    const outside = path.join(homes.root, 'outside-skill');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.md'), 'outside\n');
    const link = path.join(project, '.cursor', 'skills', 'escape');
    fs.symlinkSync(outside, link, 'dir');

    // Removal-side containment: a sweep that would delete through a link out of
    // the repository is refused, and the link and its target both survive.
    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.md'), 'utf-8'), 'outside\n');
  });
});
