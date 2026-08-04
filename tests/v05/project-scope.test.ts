import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows, projectAppRows } from '../../src/engine/apps.js';
import { runExplain, runSync } from '../../src/engine/cli.js';
import { effectiveSelection, loadConfig, selectionDelta } from '../../src/engine/config.js';
import { renderReport } from '../../src/engine/report.js';
import { mergeProjectRegion, projectRegion } from '../../src/engine/shapes.js';
import {
  detectDir,
  installApps,
  renderedRules,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function seed(root: string, relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

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
    const rendered = renderReport(report);
    assert.ok(
      rendered.indexOf('claude-code:') < rendered.indexOf('claude-code (project):'),
      rendered
    );
  });
});

test('the project phase captures what the user phase just wrote', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectConfig(project, '[mcp]\nenabled = ["alpha", "beta"]\n');

    const report = await runSync({ project });
    const globalHost = path.join(homes.agentsHome, '.codex', 'config.toml');

    // Codex shares one document between the machine's MCP servers and the
    // project trust the project phase adds. The second phase reads it after
    // the first wrote it, so neither write loses the other.
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const globalText = fs.readFileSync(globalHost, 'utf-8');
    assert.match(globalText, /alpha/);
    assert.match(globalText, /trust_level/);
    const projectText = fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf-8');
    assert.match(projectText, /beta/);
    assert.doesNotMatch(projectText, /alpha/, 'the repository holds only the increment');
  });
});

test('an ambient .asb.toml in the invocation directory runs the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    const nested = path.join(project, 'src');
    fs.mkdirSync(nested, { recursive: true });
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/repo.md', 'repo command\n');
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
    seed(homes.asbHome, 'commands/named.md', 'named\n');
    seed(homes.asbHome, 'commands/ambient.md', 'ambient\n');
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

test('project registry exposes only ratified destinations and keeps global-only cells out', async () => {
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

    assert.equal(
      row('claude-code')?.rules?.path(config.homes),
      path.join(projectReal, '.claude', 'CLAUDE.md')
    );
    assert.equal(row('claude-code')?.mcp?.path(config.homes), path.join(projectReal, '.mcp.json'));
    assert.equal(row('codex')?.rules?.path(config.homes), path.join(projectReal, 'AGENTS.md'));
    assert.equal(row('codex')?.commands, undefined);
    assert.equal(
      row('codex')?.skills?.dir(config.homes),
      path.join(projectReal, '.agents', 'skills')
    );
    assert.equal(row('gemini')?.agents, undefined);
    assert.equal(
      row('opencode')?.mcp?.path(config.homes),
      path.join(projectReal, '.opencode', 'opencode.json')
    );
    assert.equal(
      row('cursor')?.mcp?.path(config.homes),
      path.join(projectReal, '.cursor', 'mcp.json')
    );
    assert.equal(row('trae')?.skills?.dir(config.homes), path.join(projectReal, '.trae', 'skills'));
    assert.equal(
      row('trae-cn')?.mcp?.path(config.homes),
      path.join(projectReal, '.trae', 'mcp.json')
    );
    assert.equal(row('traecli')?.rules?.path(config.homes), path.join(projectReal, 'AGENTS.md'));
    assert.equal(row('traecli')?.commands, undefined);
    assert.equal(row('traecli')?.mcp, undefined);
    assert.equal(row('custom')?.rules, undefined);
    assert.equal(
      row('custom')?.commands?.dir(config.homes),
      path.join(projectReal, '.custom', 'commands')
    );
    assert.equal(row('custom')?.skills, undefined, 'missing project_parent_dir is global-only');
  });
});

test('managed warn-skip preserves one foreign file while independent project writes continue', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/build.md', 'desired build\n');
    seed(homes.asbHome, 'commands/ship.md', 'desired ship\n');
    seed(homes.asbHome, 'commands/global.md', 'desired global\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["global"]\n'
    );
    projectConfig(project, '[commands]\nenabled = ["build", "ship"]\n');
    const occupied = seed(project, '.cursor/commands/build.md', 'foreign\n');

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
    seed(homes.asbHome, 'commands/build.md', 'desired build\n');
    seed(homes.asbHome, 'commands/ship.md', 'desired ship\n');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[commands]\nenabled = ["build", "ship"]\n', { collision: 'error' });
    const occupied = seed(project, '.cursor/commands/build.md', 'foreign\n');

    const report = await runSync({ project });

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
    seed(homes.asbHome, 'commands/build.md', 'desired\n');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[commands]\nenabled = ["build"]\n', { collision: 'takeover' });
    const occupied = seed(project, '.cursor/commands/build.md', 'foreign\n');

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

test('shared project AGENTS.md has one strict 0.4 marker writer', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex', 'gemini', 'opencode');
    seedRule(homes, 'machine.md', '# Machine rule\n');
    seedRule(homes, 'project.md', '# Shared rule\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "gemini", "opencode"]\n\n[rules]\nenabled = ["machine"]\n'
    );
    projectConfig(project, '[rules]\nenabled = ["machine", "project"]\n');
    const agents = seed(project, 'AGENTS.md', '# User instructions\n');

    const report = await runSync({ project });
    const content = fs.readFileSync(agents, 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(content.match(/<!-- rules:start -->/g)?.length, 1);
    assert.equal(content.match(/<!-- rules:end -->/g)?.length, 1);
    assert.ok(!/asb/i.test(content), 'the written project region never names asb');
    assert.match(content, /# Shared rule/);
    assert.match(content, /# User instructions/);
    assert.ok(
      !content.includes('# Machine rule'),
      'the region composes the increment alone, so agent context stops double-loading'
    );
    assert.match(
      fs.readFileSync(path.join(homes.agentsHome, '.codex', 'AGENTS.md'), 'utf-8'),
      /# Machine rule/
    );
    assert.equal(
      report.entries.filter((entry) => entry.type === 'rules' && entry.path === agents).length,
      1
    );
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
    const agents = seed(project, 'AGENTS.md', broken);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(agents, 'utf-8'), broken);
    assert.match(report.entries.find((entry) => entry.path === agents)?.reason ?? '', /duplicate/i);
  });
});

test('a byte-proven project rules file moves off the retired dedicated filename', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedRule(homes, 'project.md', '# Project rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[rules]\nenabled = ["project"]\n');
    await runSync({ project });
    const current = path.join(project, '.cursor', 'rules', 'rules.mdc');
    const legacy = path.join(project, '.cursor', 'rules', 'asb-rules.mdc');
    fs.renameSync(current, legacy);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(current), true);
    assert.equal(fs.existsSync(legacy), false);

    fs.writeFileSync(legacy, '# User-owned copy\n');
    const drifted = await runSync({ project });
    assert.ok(
      drifted.entries.some((entry) => entry.path === legacy && entry.outcome === 'left-behind'),
      JSON.stringify(drifted.entries, null, 2)
    );
    assert.equal(fs.readFileSync(legacy, 'utf-8'), '# User-owned copy\n');
  });
});

test('deselecting the project rules region preserves every byte outside it', () => {
  const existing = [
    '# My instructions',
    '',
    '<!-- rules:start -->',
    'Managed rules, then a line I added by hand.',
    '<!-- rules:end -->',
    '',
    'A trailing note of mine.',
    '',
  ].join('\n');

  const result = mergeProjectRegion(existing, '');

  assert.ok(!result.includes('rules:start'));
  assert.ok(!result.includes('Managed rules'));
  assert.ok(!result.includes('a line I added by hand'));
  assert.ok(result.includes('# My instructions'));
  assert.ok(result.includes('A trailing note of mine.'));
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

test('project marker parser accepts one pair in either spelling and rejects partial or reordered pairs', () => {
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

test('project hooks land in the project config and leave it on deselection', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seed(
      homes.asbHome,
      'hooks/lint.json',
      `${JSON.stringify({
        name: 'lint',
        hooks: {
          UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo lint' }] }],
        },
      })}\n`
    );
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    projectConfig(project, '[hooks]\nenabled = ["lint"]\n');

    const first = await runSync({ project });
    const projectSettings = path.join(project, '.claude', 'settings.local.json');
    const landed = JSON.parse(fs.readFileSync(projectSettings, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };

    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));
    assert.equal(landed.hooks.UserPromptSubmit.length, 1);
    // The increment is the repository's alone: nothing the machine did not
    // already select reaches a global target, and the project phase writes no
    // machine state of its own.
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.claude', 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(homes.asbHome, 'state', 'hooks')), false);
    assert.deepEqual(fs.readdirSync(homes.stateHome), ['last-run.json']);

    projectConfig(project, '[hooks]\nenabled = []\n');
    const second = await runSync({ project });
    const settings = JSON.parse(fs.readFileSync(projectSettings, 'utf-8')) as Record<
      string,
      unknown
    >;

    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.equal(Object.hasOwn(settings, 'hooks'), false);
  });
});

test('an edited project hook bundle is preserved and reported, never swept', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    const source = path.join(homes.asbHome, 'hooks', 'tool');
    fs.mkdirSync(source, { recursive: true });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional hook placeholder
    const command = '${HOOK_DIR}/run.sh';
    fs.writeFileSync(
      path.join(source, 'hook.json'),
      `${JSON.stringify({
        name: 'tool',
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
        },
      })}\n`
    );
    fs.writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\necho managed\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    projectConfig(project, '[hooks]\nenabled = ["tool"]\n');
    await runSync({ project });
    const target = path.join(project, '.claude', 'hooks', 'managed', 'tool', 'run.sh');
    fs.writeFileSync(target, '#!/bin/sh\necho edited\n');
    projectConfig(project, '[hooks]\nenabled = []\n');

    const report = await runSync({ project });

    // The group in the config names the managed path, so it is asb's and goes;
    // the tree no longer matches the render, so in a repository it stays and is
    // named instead.
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.readFileSync(target, 'utf-8'), '#!/bin/sh\necho edited\n');
    const row = report.entries.find((entry) => entry.type === 'hooks' && entry.id === 'tool');
    assert.equal(row?.outcome, 'left-behind');
    assert.equal(row?.detail, 'unproven');
    const settings = JSON.parse(
      fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf-8')
    ) as Record<string, unknown>;
    assert.equal(Object.hasOwn(settings, 'hooks'), false);
  });
});

test('managed cleanup keeps a modified command and names it instead of sweeping', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/build.md', 'desired\n');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, '[commands]\nenabled = ["build"]\n');
    await runSync({ project });
    const target = path.join(project, '.cursor', 'commands', 'build.md');
    fs.writeFileSync(target, 'user edit\n');
    projectConfig(project, '[commands]\nenabled = []\n');

    const report = await runSync({ project });
    const row = report.entries.find((entry) => entry.path === target);

    assert.equal(report.exitCode, 0, 'preserving a user edit is not a failure');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'user edit\n');
    assert.equal(row?.outcome, 'left-behind');
    assert.equal(row?.detail, 'unproven');
  });
});

test('exclusive cleanup removes recognizable files and non-reserved bundles', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/build.md', 'desired\n');
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
    const orphan = seed(project, '.cursor/skills/orphan/SKILL.md', 'foreign\n');
    const reserved = seed(project, '.cursor/skills/.system/KEEP', 'reserved\n');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    assert.equal(fs.existsSync(path.dirname(orphan)), false);
    assert.equal(fs.existsSync(reserved), true);

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
    seed(homes.asbHome, 'commands/build.md', 'desired\n');
    seed(homes.asbHome, 'commands/repo.md', 'repo\n');
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
    // A root nothing reconciled is not this run's scope, so no output names it.
    assert.equal(report.scope.project, null);
    assert.equal(renderReport(report).includes(project), false, renderReport(report));
    assert.equal(
      fs.readFileSync(path.join(homes.agentsHome, '.cursor', 'commands', 'build.md'), 'utf-8'),
      'desired\n'
    );
  });
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

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.md'), 'utf-8'), 'outside\n');
  });
});

test('Codex project hooks do not create project trust without project MCP', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seed(
      homes.asbHome,
      'hooks/notify.json',
      `${JSON.stringify({
        name: 'notify',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo notify' }] }] },
      })}\n`
    );
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectConfig(project, '[hooks]\nenabled = ["notify"]\n');

    const report = await runSync({ project });
    const globalConfig = path.join(homes.agentsHome, '.codex', 'config.toml');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.codex', 'hooks.json')), true);
    assert.equal(fs.existsSync(globalConfig), false);
  });
});

test('an ambient run reaches project MCP without touching the machine Codex trust', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectConfig(project, '[mcp]\nenabled = ["alpha"]\n');
    const globalConfig = path.join(homes.agentsHome, '.codex', 'config.toml');

    await inCwd(project, async () => {
      const report = await runSync();

      // Trust is a write outside the repository, so only a run that named the
      // root asks for it: syncing inside a clone creates no side effect there.
      // The write that did not happen is still a fact of the run, so one row
      // stands where it would have been and names the flag that asks for it.
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.match(fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf-8'), /alpha/);
      assert.equal(fs.existsSync(globalConfig), false);
      const suppressed = report.entries.filter((entry) => entry.path === globalConfig);
      assert.equal(suppressed.length, 1, JSON.stringify(report.entries, null, 2));
      assert.equal(suppressed[0]?.outcome, 'skipped');
      assert.equal(suppressed[0]?.detail, 'ambient-project');
      assert.equal(suppressed[0]?.scope, 'project');
      assert.match(suppressed[0]?.reason ?? '', new RegExp(`-P ${project}`));
    });

    const named = await runSync({ project });

    assert.equal(named.exitCode, 0, JSON.stringify(named.entries, null, 2));
    assert.match(fs.readFileSync(globalConfig, 'utf-8'), /trust_level = "trusted"/);
  });
});

test('shared Trae project skills plan one physical writer from both app selections', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'trae', 'trae-cn');
    seedSkill(homes, 'shared');
    writeUserConfig(homes, '[applications]\nenabled = ["trae", "trae-cn"]\n');
    projectConfig(project, '[skills]\nenabled = ["shared"]\n');

    const report = await runSync({ project });
    const target = path.join(project, '.trae', 'skills', 'shared', 'SKILL.md');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(target), true);
    assert.equal(report.entries.filter((entry) => entry.path === path.dirname(target)).length, 1);
  });
});

test('project explain matches status project slices without writes or credential leaks', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seedRule(homes, 'project-rule.md', '# Project rule\n');
    seedRule(homes, 'repo-rule.md', '# Repo rule\n');
    seed(
      homes.asbHome,
      'hooks/notify.json',
      `${JSON.stringify({
        name: 'notify',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo notify' }] }] },
      })}\n`
    );
    seed(
      homes.asbHome,
      'mcp.json',
      `${JSON.stringify({
        mcpServers: { alpha: { command: 'run', env: { API_TOKEN: 'PROJECT-SECRET-123' } } },
      })}\n`
    );
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["project-rule"]\n\n[hooks]\nenabled = ["notify"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );
    projectConfig(project, '[rules]\nenabled = ["project-rule", "repo-rule"]\n');

    const before = fs.readdirSync(homes.root, { recursive: true }).sort();
    const status = await runSync({ project, dryRun: true });
    for (const target of ['project-rule', 'repo-rule', 'notify', 'alpha']) {
      const { slices } = await runExplain(target, { project });
      assert.ok(slices.length > 0, target);
      for (const slice of slices) {
        assert.ok(
          status.entries.some(
            (entry) =>
              entry.app === slice.app &&
              entry.path === slice.path &&
              entry.outcome === slice.outcome
          ),
          `${target}: ${JSON.stringify(slice, null, 2)}`
        );
      }
      assert.equal(JSON.stringify(slices).includes('PROJECT-SECRET-123'), false);
    }
    assert.deepEqual(fs.readdirSync(homes.root, { recursive: true }).sort(), before);
  });
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

    // `collision = "error"` is the setting that asks for a failure over a row.
    projectConfig(project, '[rules]\nenabled = ["alpha", "beta"]\n', { collision: 'error' });
    const strict = await runSync({ project });
    assert.equal(strict.exitCode, 1, JSON.stringify(strict.entries, null, 2));
    assert.equal(fs.readFileSync(target, 'utf-8'), '# The repository wrote this\n');
    assert.equal(strict.entries.find((entry) => entry.path === target)?.outcome, 'conflict');

    // And takeover is the one that overwrites, after which the render proves
    // the file again.
    projectConfig(project, '[rules]\nenabled = ["alpha", "beta"]\n', { collision: 'takeover' });
    const taken = await runSync({ project });
    assert.equal(taken.exitCode, 0, JSON.stringify(taken.entries, null, 2));
    assert.equal(fs.readFileSync(target, 'utf-8'), renderedRules('cursor', 'Beta body\n'));
  });
});

/**
 * `asb init` run in the home directory. One tree would be both scopes, so the
 * project phase would read the user phase's fresh writes as renders nothing
 * asks for any more and take them out — the emptier the repository layer, the
 * more it would take. Refusal is a row, not a guess, whichever way the root
 * arrives.
 */
for (const [label, body] of [
  ['a managed project block', '[distribution.project]\nmode = "managed"\n'],
  ['nothing but a comment', '# nothing enabled here yet\n'],
] as const) {
  test(`an agents-home project root carrying ${label} is refused whole`, async () => {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      seedSkill(homes, 'alpha');
      seedRule(homes, 'house.md', '# House rule\n');
      seed(homes.asbHome, 'commands/build.md', 'desired build\n');
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
      const distributed = [
        path.join(skillsParentDir(homes, 'claude-code'), 'alpha', 'SKILL.md'),
        path.join(homes.agentsHome, '.claude', 'CLAUDE.md'),
        path.join(homes.agentsHome, '.claude', 'commands', 'build.md'),
      ];

      // Detected in the invocation directory, and named outright: neither way
      // in gets a project phase.
      for (const run of [
        () => inCwd(homes.agentsHome, () => runSync()),
        () => runSync({ project: homes.agentsHome }),
      ]) {
        const report = await run();

        assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
        for (const target of distributed) {
          assert.ok(fs.existsSync(target), `${target} survives the run that wrote it`);
        }
        assert.equal(report.scope.project, null);
        assert.deepEqual(
          report.entries.filter((entry) => entry.scope === 'project'),
          []
        );
        const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
        assert.equal(refusals.length, 1, JSON.stringify(report.entries, null, 2));
        assert.equal(refusals[0]?.outcome, 'skipped');
        assert.match(refusals[0]?.reason ?? '', new RegExp(homes.agentsHome));
      }
    });
  });
}

test('a repository declaring [plugins.sources] is reported and nothing else', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const vendored = path.join(homes.root, 'vendored');
    fs.mkdirSync(project);
    seed(vendored, 'rules/leak.md', 'Repository-authored body\n');
    installApps(homes, 'claude-code');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["evil:leak"]\n'
    );
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      [
        '[plugins.sources]',
        `evil = ${JSON.stringify(vendored)}`,
        `remote = { url = "file://${path.join(homes.root, 'absent.git')}", type = "clone" }`,
        '',
      ].join('\n')
    );

    const report = await runSync({ project });

    // The machine cache and the network are config.toml's alone: nothing was
    // cloned, and no namespace the repository named resolves.
    assert.equal(fs.existsSync(path.join(homes.cacheHome, 'remote')), false);
    assert.notEqual(report.exitCode, 2, JSON.stringify(report.entries, null, 2));
    const host = path.join(homes.agentsHome, '.claude', 'CLAUDE.md');
    assert.equal(
      fs.existsSync(host) && fs.readFileSync(host, 'utf-8').includes('Repository-authored body'),
      false,
      'no repository-authored body reaches a user-scope target'
    );
    const declarations = report.entries.filter((entry) => entry.detail === 'project-source');
    assert.deepEqual(
      declarations.map((entry) => entry.id).sort(),
      ['evil', 'remote'],
      JSON.stringify(report.entries, null, 2)
    );
    assert.deepEqual(
      declarations.map((entry) => `${entry.scope}/${entry.outcome}`),
      ['project/skipped', 'project/skipped']
    );
    assert.ok(
      report.entries.some((entry) => entry.id === 'evil:leak' && entry.outcome === 'missing'),
      'the selection resolves against the machine library, which has no such id'
    );
  });
});

test('a repository re-pointing a namespace config.toml declares changes no render', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    // Neither directory sits under <asbHome>/plugins, so the declaration is
    // the only thing that can make a namespace resolve.
    const machineSource = path.join(homes.root, 'vendor', 'machine');
    const repoSource = path.join(homes.root, 'vendor', 'repo');
    seed(machineSource, 'rules/base.md', 'Machine body\n');
    seed(repoSource, 'rules/base.md', 'Repository body\n');
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
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      ['[plugins.sources]', `team = ${JSON.stringify(repoSource)}`, ''].join('\n')
    );

    const report = await runSync({ project });
    const host = fs.readFileSync(path.join(homes.agentsHome, '.claude', 'CLAUDE.md'), 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.match(host, /Machine body/);
    assert.equal(
      host.includes('Repository body'),
      false,
      'the namespace resolves where config.toml points it, in every directory'
    );
    const rows = report.entries.filter((entry) => entry.detail === 'project-source');
    assert.equal(rows.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(rows[0]?.id, 'team');
    assert.equal(rows[0]?.scope, 'project');
    assert.equal(rows[0]?.outcome, 'skipped');
  });
});

test('a repository repeating config.toml’s declaration is reported all the same', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    const machineSource = path.join(homes.root, 'vendor', 'machine');
    seed(machineSource, 'rules/base.md', 'Machine body\n');
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
    // A repository copying the machine's declaration verbatim declares a
    // source the project layer still cannot clone: the row is what tells the
    // operator the namespace resolves from config.toml alone.
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      ['[plugins.sources]', `team = ${JSON.stringify(machineSource)}`, ''].join('\n')
    );

    const report = await runSync({ project });
    const rows = report.entries.filter((entry) => entry.detail === 'project-source');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(rows.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(rows[0]?.id, 'team');
    assert.equal(rows[0]?.scope, 'project');
    assert.equal(rows[0]?.outcome, 'skipped');
    assert.match(
      fs.readFileSync(path.join(homes.agentsHome, '.claude', 'CLAUDE.md'), 'utf-8'),
      /Machine body/
    );
  });
});

test('an increment for a cell with no project destination is named, not dropped', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seed(homes.asbHome, 'commands/build.md', 'desired build\n');
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

test('a project leaf symlinked out of the repository is blocked, not written through', async () => {
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
    // A committed link at the project leaf points at the machine's own rules
    // file: the user phase writes the render of `alpha` there, and the
    // increment must not follow the link back out of the repository.
    const userTarget = path.join(homes.agentsHome, '.cursor', 'rules', 'rules.mdc');
    const projectTarget = path.join(project, '.cursor', 'rules', 'rules.mdc');
    fs.mkdirSync(path.dirname(projectTarget), { recursive: true });
    fs.symlinkSync(userTarget, projectTarget);

    const report = await runSync({ project });

    assert.equal(
      fs.readFileSync(userTarget, 'utf-8'),
      renderedRules('cursor', 'Alpha body\n'),
      'the machine keeps what its own phase wrote'
    );
    const row = report.entries.find(
      (entry) => entry.scope === 'project' && entry.path === projectTarget
    );
    assert.equal(row?.outcome, 'blocked', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.detail, 'path-escape');
    assert.equal(report.exitCode, 1);

    // The capture decides it, so a dry run names the identical row.
    const dry = await runSync({ project, dryRun: true });
    const dryRow = dry.entries.find(
      (entry) => entry.scope === 'project' && entry.path === projectTarget
    );
    assert.equal(dryRow?.outcome, 'blocked', JSON.stringify(dry.entries, null, 2));
    assert.equal(dryRow?.detail, 'path-escape');
  });
});

test('a dangling project leaf symlink creates nothing outside the repository', async () => {
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
    const outside = path.join(homes.root, 'outside', 'rules.mdc');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    const projectTarget = path.join(project, '.cursor', 'rules', 'rules.mdc');
    fs.mkdirSync(path.dirname(projectTarget), { recursive: true });
    fs.symlinkSync(outside, projectTarget);

    const report = await runSync({ project });

    assert.equal(fs.existsSync(outside), false, 'the increment creates nothing outside the tree');
    assert.equal(
      fs.lstatSync(projectTarget).isSymbolicLink(),
      true,
      'the link is left alone, not replaced by a real file'
    );
    const row = report.entries.find(
      (entry) => entry.scope === 'project' && entry.path === projectTarget
    );
    assert.equal(row?.outcome, 'blocked', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.detail, 'path-escape');
  });
});

test('an app directory aliased into the project root refuses the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const appDir = path.join(project, '.claude');
    fs.mkdirSync(appDir, { recursive: true });
    // A dotfiles-style link: `~/.claude` and `<project>/.claude` are one
    // physical tree, so the project phase would read the user phase's fresh
    // commands as renders the empty increment no longer wants.
    fs.symlinkSync(appDir, path.join(homes.agentsHome, '.claude'), 'dir');
    seed(homes.asbHome, 'commands/review.md', 'review body\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["review"]\n'
    );
    projectConfig(project);

    const report = await inCwd(project, () => runSync());

    const distributed = path.join(homes.agentsHome, '.claude', 'commands', 'review.md');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(distributed), 'the machine keeps the command it just installed');
    assert.match(fs.readFileSync(distributed, 'utf-8'), /review body/);
    assert.equal(report.scope.project, null);
    assert.deepEqual(
      report.entries.filter((entry) => entry.scope === 'project'),
      []
    );
    const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
    assert.equal(refusals.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(refusals[0]?.outcome, 'skipped');
    // The row names the aliased directory, not just the root that holds it.
    assert.match(refusals[0]?.reason ?? '', /claude-code/);
    assert.match(refusals[0]?.reason ?? '', new RegExp(path.join(homes.agentsHome, '.claude')));
  });
});

test("an app's write root aliased into the project root refuses the project phase", async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const traeDir = path.join(project, '.trae');
    fs.mkdirSync(traeDir, { recursive: true });
    // Trae detects through its vendor data dir but writes under `~/.trae`, so
    // the alias is invisible to detection while the project phase would still
    // read the user phase's fresh skill as a render the empty increment no
    // longer wants.
    fs.symlinkSync(traeDir, path.join(homes.agentsHome, '.trae'), 'dir');
    installApps(homes, 'trae');
    seedSkill(homes, 'review');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["trae"]\n\n[skills]\nenabled = ["review"]\n'
    );
    projectConfig(project);

    const report = await inCwd(project, () => runSync());

    const installed = path.join(homes.agentsHome, '.trae', 'skills', 'review', 'SKILL.md');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(installed), 'the machine keeps the skill it just installed');
    assert.equal(report.scope.project, null);
    assert.deepEqual(
      report.entries.filter((entry) => entry.scope === 'project'),
      []
    );
    const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
    assert.equal(refusals.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(refusals[0]?.outcome, 'skipped');
    assert.match(refusals[0]?.reason ?? '', /trae/);
    assert.match(refusals[0]?.reason ?? '', new RegExp(path.join(homes.agentsHome, '.trae')));
  });
});

test('the shared agents directory aliased into the project root refuses the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const agentsDir = path.join(project, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // The union row writes under `~/.agents`, which belongs to no single
    // app row: the alias must be caught on the shared root itself.
    fs.symlinkSync(agentsDir, path.join(homes.agentsHome, '.agents'), 'dir');
    installApps(homes, 'codex');
    seedSkill(homes, 'review');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[skills]\nenabled = ["review"]\n\n[distribution]\nuse_agents_dir = true\n'
    );
    projectConfig(project);

    const report = await inCwd(project, () => runSync());

    const installed = path.join(homes.agentsHome, '.agents', 'skills', 'review', 'SKILL.md');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(installed), 'the machine keeps the skill it just installed');
    assert.equal(report.scope.project, null);
    assert.deepEqual(
      report.entries.filter((entry) => entry.scope === 'project'),
      []
    );
    const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
    assert.equal(refusals.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(refusals[0]?.outcome, 'skipped');
    assert.match(refusals[0]?.reason ?? '', /shared agents directory/);
    assert.match(refusals[0]?.reason ?? '', new RegExp(path.join(homes.agentsHome, '.agents')));
  });
});

test('a user file aliased onto a project destination refuses the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const cellFile = path.join(project, '.claude', 'commands', 'review.md');
    fs.mkdirSync(path.dirname(cellFile), { recursive: true });
    fs.writeFileSync(cellFile, 'stale\n');
    installApps(homes, 'claude-code');
    seed(homes.asbHome, 'commands/review.md', 'review body\n');
    // A leaf link is written through at user scope, so the command's real
    // bytes would land on the very cell the empty increment then sweeps.
    const userFile = path.join(homes.agentsHome, '.claude', 'commands', 'review.md');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.symlinkSync(cellFile, userFile);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["review"]\n'
    );
    projectConfig(project);

    const report = await inCwd(project, () => runSync());

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(userFile), 'the machine keeps the command it just installed');
    assert.equal(report.scope.project, null);
    assert.deepEqual(
      report.entries.filter((entry) => entry.scope === 'project'),
      []
    );
    const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
    assert.equal(refusals.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(refusals[0]?.outcome, 'skipped');
    assert.match(refusals[0]?.reason ?? '', /claude-code/);
    assert.match(refusals[0]?.reason ?? '', new RegExp(userFile));
  });
});

test('a dangling user link onto a project destination refuses the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seed(homes.asbHome, 'commands/review.md', 'review body\n');
    // The write path follows a dangling link and creates the backing file,
    // so the refusal scan must resolve the same way realpath cannot.
    const userFile = path.join(homes.agentsHome, '.claude', 'commands', 'review.md');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.symlinkSync(path.join(project, '.claude', 'commands', 'review.md'), userFile);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["review"]\n'
    );
    projectConfig(project);

    const report = await inCwd(project, () => runSync());

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(userFile), 'the machine keeps the command it just installed');
    assert.equal(report.scope.project, null);
    const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
    assert.equal(refusals.length, 1, JSON.stringify(report.entries, null, 2));
    assert.match(refusals[0]?.reason ?? '', new RegExp(userFile));
  });
});

test('a project cell reached through a repository alias still refuses the project phase', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const sharedDir = path.join(project, 'shared-commands');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'review.md'), 'stale\n');
    // The repository aliases its own cell directory, so the cell's write
    // location must be resolved the way the writes resolve it.
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.symlinkSync(sharedDir, path.join(project, '.claude', 'commands'), 'dir');
    installApps(homes, 'claude-code');
    seed(homes.asbHome, 'commands/review.md', 'review body\n');
    const userFile = path.join(homes.agentsHome, '.claude', 'commands', 'review.md');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.symlinkSync(path.join(sharedDir, 'review.md'), userFile);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["review"]\n'
    );
    projectConfig(project);

    const report = await inCwd(project, () => runSync());

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(userFile), 'the machine keeps the command it just installed');
    assert.equal(report.scope.project, null);
    const refusals = report.entries.filter((entry) => entry.detail === 'project-refused');
    assert.equal(refusals.length, 1, JSON.stringify(report.entries, null, 2));
    assert.match(refusals[0]?.reason ?? '', new RegExp(userFile));
  });
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
    // parent rule must still call it an escape, as it did before the leaf
    // rule existed, or the round trip reaches files other cells never named.
    fs.symlinkSync(outside, path.join(project, '.claude', 'commands'), 'dir');
    fs.symlinkSync(shared, path.join(outside, 'review.md'));
    installApps(homes, 'claude-code');
    seed(homes.asbHome, 'commands/review.md', 'review body\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    projectConfig(project, '[commands]\nenabled = ["review"]\n', { mode: 'exclusive' });

    const report = await runSync({ project });

    assert.equal(fs.readFileSync(shared, 'utf-8'), 'user bytes\n', 'the loop reaches nothing');
    const row = report.entries.find(
      (entry) => entry.scope === 'project' && entry.type === 'commands'
    );
    assert.equal(row?.outcome, 'blocked', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.detail, 'path-escape');
    assert.equal(report.exitCode, 1);
  });
});

test('a disabled-app cleanup never reaches an aliased user host', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    // The user MCP host lives physically in the repository; the project
    // layer disables every app, so the project phase's disabled-app cleanup
    // is what reaches for the file, not an enabled cell.
    const userHost = path.join(homes.agentsHome, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(userHost), { recursive: true });
    fs.symlinkSync(path.join(project, '.cursor', 'mcp.json'), userHost);
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectConfig(project, '[applications]\nenabled = []\n');

    const report = await runSync({ project });

    assert.match(
      fs.readFileSync(userHost, 'utf-8'),
      /alpha/,
      'the machine keeps the server it just installed'
    );
    const touched = report.entries.filter(
      (entry) => entry.scope === 'project' && ['written', 'removed'].includes(entry.outcome)
    );
    assert.deepEqual(touched, [], JSON.stringify(report.entries, null, 2));
  });
});

test("a project cleanup never reaches a disabled app's dormant aliased config", async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
    installApps(homes, 'cursor', 'claude-code');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    const userHost = path.join(homes.agentsHome, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(userHost), { recursive: true });
    fs.symlinkSync(path.join(project, '.cursor', 'mcp.json'), userHost);
    // Yesterday's run, cursor enabled: the machine wrote alpha through the
    // link. Cursor then left the user selection, and the dormant config kept
    // its render — still the machine's file, not the repository's.
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n');
    await inCwd(homes.root, () => runSync());
    assert.match(fs.readFileSync(userHost, 'utf-8'), /alpha/);
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    projectConfig(project);

    const report = await runSync({ project });

    assert.match(
      fs.readFileSync(userHost, 'utf-8'),
      /alpha/,
      "the machine keeps the disabled app's dormant config"
    );
    const touched = report.entries.filter(
      (entry) => entry.scope === 'project' && ['written', 'removed'].includes(entry.outcome)
    );
    assert.deepEqual(touched, [], JSON.stringify(report.entries, null, 2));
  });
});

test("a dynamic selector keeps a disabled app's dormant aliased config", async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const shared = path.join(project, 'shared', 'opencode.json');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    installApps(homes, 'opencode', 'claude-code');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
    const opencodeRoot = detectDir(homes, 'opencode');
    const userHost = path.join(opencodeRoot, 'opencode.json');
    fs.symlinkSync(shared, userHost);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["opencode"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );
    await inCwd(homes.root, () => runSync());
    assert.match(fs.readFileSync(shared, 'utf-8'), /alpha/);

    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    fs.writeFileSync(path.join(opencodeRoot, 'opencode.jsonc'), '{}');
    fs.mkdirSync(path.join(project, '.opencode'));
    fs.symlinkSync(shared, path.join(project, '.opencode', 'opencode.json'));
    projectConfig(project, '[applications]\nenabled = ["opencode"]\n\n[mcp]\nenabled = ["beta"]\n');

    const report = await runSync({ project });

    assert.match(fs.readFileSync(shared, 'utf-8'), /alpha/);
    assert.doesNotMatch(fs.readFileSync(shared, 'utf-8'), /beta/);
    const touched = report.entries.filter(
      (entry) => entry.scope === 'project' && ['written', 'removed'].includes(entry.outcome)
    );
    assert.deepEqual(touched, [], JSON.stringify(report.entries, null, 2));
  });
});

test('a project cleanup keeps a disabled OpenCode legacy skill linked into the repository', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'opencode', 'claude-code');
    const librarySkill = seedSkill(homes, 'check');
    const sharedSkill = path.join(project, 'shared-skills', 'check');
    fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
    fs.cpSync(librarySkill, sharedSkill, { recursive: true });
    const opencodeRoot = detectDir(homes, 'opencode');
    const legacyDir = path.join(opencodeRoot, 'skill');
    fs.mkdirSync(legacyDir);
    fs.symlinkSync(sharedSkill, path.join(legacyDir, 'check'), 'dir');

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

    const report = await runSync({ project });

    assert.equal(
      fs.readFileSync(path.join(sharedSkill, 'SKILL.md'), 'utf-8'),
      fs.readFileSync(path.join(librarySkill, 'SKILL.md'), 'utf-8'),
      'the machine keeps the dormant skill'
    );
    const touched = report.entries.filter(
      (entry) => entry.scope === 'project' && ['written', 'removed'].includes(entry.outcome)
    );
    assert.deepEqual(touched, [], JSON.stringify(report.entries, null, 2));
  });
});

test('a project cleanup keeps an unreadable disabled OpenCode legacy skill linked into the repository', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'opencode', 'claude-code');
    const librarySkill = seedSkill(homes, 'check');
    const sharedSkill = path.join(project, 'shared-skills', 'check');
    fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
    fs.cpSync(librarySkill, sharedSkill, { recursive: true });
    const opencodeRoot = detectDir(homes, 'opencode');
    const legacyDir = path.join(opencodeRoot, 'skill');
    fs.mkdirSync(legacyDir);
    fs.symlinkSync(sharedSkill, path.join(legacyDir, 'check'), 'dir');

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

    fs.chmodSync(legacyDir, 0o111);
    try {
      const report = await runSync({ project });

      assert.equal(
        fs.readFileSync(path.join(sharedSkill, 'SKILL.md'), 'utf-8'),
        fs.readFileSync(path.join(librarySkill, 'SKILL.md'), 'utf-8'),
        'the machine keeps what it cannot enumerate'
      );
      const touched = report.entries.filter(
        (entry) => entry.scope === 'project' && ['written', 'removed'].includes(entry.outcome)
      );
      assert.deepEqual(touched, [], JSON.stringify(report.entries, null, 2));
    } finally {
      fs.chmodSync(legacyDir, 0o755);
    }
  });
});

test('a project cleanup keeps a disabled OpenCode legacy skill behind an unreadable link chain', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'opencode', 'claude-code');
    const librarySkill = seedSkill(homes, 'check');
    const sharedSkill = path.join(project, 'shared-skills', 'check');
    fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
    fs.cpSync(librarySkill, sharedSkill, { recursive: true });
    const blocked = path.join(homes.root, 'blocked');
    fs.mkdirSync(blocked);
    fs.symlinkSync(path.join(project, 'shared-skills'), path.join(blocked, 'jump'), 'dir');
    const opencodeRoot = detectDir(homes, 'opencode');
    const legacyDir = path.join(opencodeRoot, 'skill');
    fs.mkdirSync(legacyDir);
    fs.symlinkSync(path.join(blocked, 'jump', 'check'), path.join(legacyDir, 'check'), 'dir');

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

    fs.chmodSync(blocked, 0o000);
    try {
      const report = await runSync({ project });

      assert.equal(
        fs.readFileSync(path.join(sharedSkill, 'SKILL.md'), 'utf-8'),
        fs.readFileSync(path.join(librarySkill, 'SKILL.md'), 'utf-8'),
        'the machine keeps what it cannot resolve'
      );
      const touched = report.entries.filter(
        (entry) => entry.scope === 'project' && ['written', 'removed'].includes(entry.outcome)
      );
      assert.deepEqual(touched, [], JSON.stringify(report.entries, null, 2));
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
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
    seed(homes.asbHome, 'commands/review.md', 'review body\n');
    const userRules = path.join(homes.agentsHome, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(userRules), { recursive: true });
    fs.symlinkSync(shared, userRules);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );
    projectConfig(project, '[commands]\nenabled = ["review"]\n', { mode: 'exclusive' });

    const report = await runSync({ project });

    assert.match(
      fs.readFileSync(shared, 'utf-8'),
      /Alpha body/,
      'the machine keeps the rules it just installed'
    );
    assert.doesNotMatch(fs.readFileSync(shared, 'utf-8'), /review body/);
    const row = report.entries.find(
      (entry) => entry.scope === 'project' && entry.type === 'commands'
    );
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
    seed(homes.asbHome, 'commands/repo.md', 'repo command\n');
    // A dotfiles-style link of the rules host to a repo path no project cell
    // manages: write-through and the project phase coexist.
    const repoCopy = path.join(project, 'CLAUDE.md');
    fs.writeFileSync(repoCopy, '');
    const userFile = path.join(homes.agentsHome, '.claude', 'CLAUDE.md');
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

test('a repository [plugins] sub-table adds to the base selection instead of clearing it', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const teamSource = path.join(homes.root, 'team-plugin');
    fs.mkdirSync(project);
    seed(teamSource, 'rules/style.md', 'Team style\n');
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

    // Every other `[plugins]` spelling merges the same way.
    fs.writeFileSync(path.join(project, '.asb.toml'), '[plugins.exclude]\nrules = ["team:none"]\n');
    assert.deepEqual(loadConfig({ project }).selection.plugins, ['team']);
  });
});

test('a source literally named "source" stays a modern sources map', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const teamSource = path.join(homes.root, 'team-plugin');
    fs.mkdirSync(project);
    seed(teamSource, 'rules/style.md', 'Team style\n');
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
    // `source` is a name like any other in the modern map: reading it as a
    // 0.3 plugin sub-table would fabricate an empty `enabled` that clears the
    // inherited selection.
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      [
        '[applications]',
        'enabled = ["claude-code", "cursor"]',
        '',
        '[plugins.sources]',
        'source = "/vendor/x"',
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
  });
});

test('a project-layer plugin ref nothing resolves is a project-scoped gap row', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    projectConfig(project, '[plugins]\nenabled = ["ghost"]\n');

    const report = await runSync({ project });

    const gaps = report.entries.filter((entry) => entry.id === 'ghost');
    assert.equal(gaps.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(gaps[0]?.outcome, 'missing');
    assert.equal(gaps[0]?.scope, 'project');
    assert.equal(report.exitCode, 1);
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
      assert.match(
        fs.readFileSync(path.join(homes.agentsHome, '.claude', 'CLAUDE.md'), 'utf-8'),
        /Alpha body/
      );
      const row = report.entries.find((entry) => entry.detail === 'project-config');
      assert.equal(row?.outcome, 'failed', JSON.stringify(report.entries, null, 2));
      assert.equal(row?.path, path.join(project, '.asb.toml'));
      assert.notEqual(report.exitCode, 0);
      assert.equal(report.scope.project, null);
    });
  }
});
