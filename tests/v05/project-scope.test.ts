import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows, projectAppRows } from '../../src/engine/apps.js';
import { runExplain, runSync } from '../../src/engine/cli.js';
import { effectiveSelection, loadConfig } from '../../src/engine/config.js';
import { mergeProjectRegion, projectRegion } from '../../src/engine/shapes.js';
import {
  installApps,
  seedRule,
  seedSkill,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function seed(root: string, relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function projectConfig(project: string, mode = 'managed', collision = 'warn-skip'): void {
  fs.writeFileSync(
    path.join(project, '.asb.toml'),
    `[distribution.project]\nmode = "${mode}"\ncollision = "${collision}"\n`
  );
}

test('project root canonicalizes once and merged selection remains the planner input', async () => {
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

    const config = loadConfig({ project: alias });

    assert.equal(config.project, fs.realpathSync(project));
    assert.deepEqual(effectiveSelection(config, 'cursor', 'commands'), ['project']);
    assert.deepEqual(effectiveSelection(config, 'cursor', 'skills'), ['inherited', 'added']);
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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build", "ship"]\n'
    );
    projectConfig(project);
    const occupied = seed(project, '.cursor/commands/build.md', 'foreign\n');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(occupied, 'utf-8'), 'foreign\n');
    assert.equal(
      fs.readFileSync(path.join(project, '.cursor', 'commands', 'ship.md'), 'utf-8'),
      'desired ship\n'
    );
  });
});

test('managed collision error preflights the whole project before any write', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/build.md', 'desired build\n');
    seed(homes.asbHome, 'commands/ship.md', 'desired ship\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build", "ship"]\n'
    );
    projectConfig(project, 'managed', 'error');
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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build"]\n'
    );
    projectConfig(project, 'managed', 'takeover');
    const occupied = seed(project, '.cursor/commands/build.md', 'foreign\n');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.readFileSync(occupied, 'utf-8'), 'desired\n');

    // The takeover leaves the render on the target, and that is the whole
    // proof it is asb's: deselecting the command reclaims those bytes.
    fs.writeFileSync(path.join(project, '.asb.toml'), '[commands]\nenabled = []\n');
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
    seedRule(homes, 'project.md', '# Shared rule\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "gemini", "opencode"]\n\n[rules]\nenabled = ["project"]\n'
    );
    projectConfig(project);
    const agents = seed(project, 'AGENTS.md', '# User instructions\n');

    const report = await runSync({ project });
    const content = fs.readFileSync(agents, 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(content.match(/<!-- rules:start -->/g)?.length, 1);
    assert.equal(content.match(/<!-- rules:end -->/g)?.length, 1);
    assert.ok(!/asb/i.test(content), 'the written project region never names asb');
    assert.match(content, /# Shared rule/);
    assert.match(content, /# User instructions/);
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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["project"]\n'
    );
    projectConfig(project);
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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[rules]\nenabled = ["project"]\n'
    );
    projectConfig(project);
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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["lint"]\n'
    );
    projectConfig(project);

    const first = await runSync({ project });
    const projectSettings = path.join(project, '.claude', 'settings.local.json');
    const landed = JSON.parse(fs.readFileSync(projectSettings, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };

    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));
    assert.equal(landed.hooks.UserPromptSubmit.length, 1);
    // A project run touches the repository and nothing else: no global config,
    // and no machine state of its own.
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.claude', 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(homes.asbHome, 'state', 'hooks')), false);
    assert.deepEqual(fs.readdirSync(homes.stateHome), []);

    fs.writeFileSync(path.join(project, '.asb.toml'), '[hooks]\nenabled = []\n');
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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["tool"]\n'
    );
    projectConfig(project);
    await runSync({ project });
    const target = path.join(project, '.claude', 'hooks', 'managed', 'tool', 'run.sh');
    fs.writeFileSync(target, '#!/bin/sh\necho edited\n');
    fs.writeFileSync(path.join(project, '.asb.toml'), '[hooks]\nenabled = []\n');

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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build"]\n'
    );
    projectConfig(project);
    await runSync({ project });
    const target = path.join(project, '.cursor', 'commands', 'build.md');
    fs.writeFileSync(target, 'user edit\n');
    fs.writeFileSync(path.join(project, '.asb.toml'), '[commands]\nenabled = []\n');

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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build"]\n\n[skills]\nenabled = ["kept-before"]\n'
    );
    projectConfig(project);
    const first = await runSync({ project });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));

    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "exclusive"\n\n[commands]\nenabled = []\n\n[skills]\nenabled = []\n'
    );
    const orphan = seed(project, '.cursor/skills/orphan/SKILL.md', 'foreign\n');
    const reserved = seed(project, '.cursor/skills/.system/KEEP', 'reserved\n');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    assert.equal(fs.existsSync(path.dirname(orphan)), false);
    assert.equal(fs.existsSync(reserved), true);

    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "managed"\n\n[commands]\nenabled = ["build"]\n'
    );
    const managedAgain = await runSync({ project });
    assert.equal(managedAgain.exitCode, 0, JSON.stringify(managedAgain.entries, null, 2));
    assert.equal(
      fs.readFileSync(path.join(project, '.cursor', 'commands', 'build.md'), 'utf-8'),
      'desired\n'
    );
  });
});

test('project mode none writes nothing to the project or the machine', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/build.md', 'desired\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build"]\n'
    );
    projectConfig(project, 'none');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    // A project-scope run leaves the machine's state dir empty.
    assert.deepEqual(fs.readdirSync(homes.stateHome), []);
  });
});

test('a failed exclusive cleanup fails the run and preserves the escaping link', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedSkill(homes, 'managed');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[skills]\nenabled = ["managed"]\n'
    );
    projectConfig(project);
    await runSync({ project });
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "exclusive"\n\n[skills]\nenabled = []\n'
    );
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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[hooks]\nenabled = ["notify"]\n'
    );
    projectConfig(project);

    const report = await runSync({ project });
    const globalConfig = path.join(homes.agentsHome, '.codex', 'config.toml');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.codex', 'hooks.json')), true);
    assert.equal(fs.existsSync(globalConfig), false);
  });
});

test('shared Trae project skills plan one physical writer from both app selections', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'trae', 'trae-cn');
    seedSkill(homes, 'shared');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["trae", "trae-cn"]\n\n[skills]\nenabled = ["shared"]\n'
    );
    projectConfig(project);

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
    projectConfig(project);

    const before = fs.readdirSync(homes.root, { recursive: true }).sort();
    const status = await runSync({ project, dryRun: true });
    for (const target of ['project-rule', 'notify', 'alpha']) {
      const slices = await runExplain(target, { project });
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
