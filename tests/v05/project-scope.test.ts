import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows, projectAppRows } from '../../src/engine/apps.js';
import { runSync } from '../../src/engine/cli.js';
import { effectiveSelection, loadConfig } from '../../src/engine/config.js';
import { projectManifestPath } from '../../src/engine/peer.js';
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

test('project registry exposes only ratified destinations and keeps Coco global-only', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex", "gemini", "opencode", "cursor", "coco", "trae", "trae-cn", "custom"]',
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
      path.join(project, '.claude', 'CLAUDE.md')
    );
    assert.equal(row('claude-code')?.mcp?.path(config.homes), path.join(project, '.mcp.json'));
    assert.equal(row('codex')?.rules?.path(config.homes), path.join(project, 'AGENTS.md'));
    assert.equal(row('codex')?.commands, undefined);
    assert.equal(row('codex')?.skills?.dir(config.homes), path.join(project, '.agents', 'skills'));
    assert.equal(row('gemini')?.agents, undefined);
    assert.equal(
      row('opencode')?.mcp?.path(config.homes),
      path.join(project, '.opencode', 'opencode.json')
    );
    assert.equal(row('cursor')?.mcp?.path(config.homes), path.join(project, '.cursor', 'mcp.json'));
    assert.equal(row('trae')?.skills?.dir(config.homes), path.join(project, '.trae', 'skills'));
    assert.equal(row('trae-cn')?.mcp?.path(config.homes), path.join(project, '.trae', 'mcp.json'));
    assert.equal(row('coco')?.rules, undefined);
    assert.equal(row('coco')?.commands, undefined);
    assert.equal(row('coco')?.mcp, undefined);
    assert.equal(
      row('custom')?.commands?.dir(config.homes),
      path.join(project, '.custom', 'commands')
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
    assert.equal(fs.existsSync(projectManifestPath(homes.asbHome, project)), false);
  });
});

test('managed takeover overwrites the named foreign project target and records ownership', async () => {
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
    assert.equal(fs.existsSync(projectManifestPath(homes.asbHome, project)), true);
  });
});

test('shared project AGENTS.md has one strict uppercase marker writer', async () => {
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
    assert.equal(content.match(/<!-- ASB:START -->/g)?.length, 1);
    assert.equal(content.match(/<!-- ASB:END -->/g)?.length, 1);
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
    const broken = '<!-- ASB:START -->\nold\n<!-- ASB:START -->\n<!-- ASB:END -->\n';
    const agents = seed(project, 'AGENTS.md', broken);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(agents, 'utf-8'), broken);
    assert.match(report.entries.find((entry) => entry.path === agents)?.reason ?? '', /duplicate/i);
  });
});

test('project hooks keep ownership in the project manifest, never global peer state', async () => {
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
    const globalPeer = path.join(homes.asbHome, 'state', 'hooks', 'claude-code.json');
    const manifest = JSON.parse(
      fs.readFileSync(projectManifestPath(homes.asbHome, project), 'utf-8')
    ) as { files: Record<string, { events?: Record<string, unknown[]> }> };

    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));
    assert.equal(fs.existsSync(globalPeer), false);
    assert.equal(manifest.files['claude-code::hooks']?.events?.UserPromptSubmit.length, 1);

    fs.writeFileSync(path.join(project, '.asb.toml'), '[hooks]\nenabled = []\n');
    const second = await runSync({ project });
    const settings = JSON.parse(
      fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf-8')
    ) as Record<string, unknown>;

    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.equal(Object.hasOwn(settings, 'hooks'), false);
  });
});

test('project hook bundle drift is preserved with manifest proof retained', async () => {
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
    const manifest = JSON.parse(
      fs.readFileSync(projectManifestPath(homes.asbHome, project), 'utf-8')
    ) as { bundles: Record<string, unknown> };

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(target, 'utf-8'), '#!/bin/sh\necho edited\n');
    assert.ok(manifest.bundles['claude-code::hooks::tool']);
  });
});

test('a corrupt project manifest aborts before project writes and remains byte-exact', async () => {
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
    const manifestPath = projectManifestPath(homes.asbHome, project);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const corrupt = '{ "version": 1, "files": ';
    fs.writeFileSync(manifestPath, corrupt);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), corrupt);
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    assert.equal(report.entries[0]?.path, manifestPath);
  });
});

test('managed cleanup keeps modified command proof until the bytes can be reclaimed', async () => {
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
    const manifest = JSON.parse(
      fs.readFileSync(projectManifestPath(homes.asbHome, project), 'utf-8')
    ) as { files: Record<string, unknown> };

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(target, 'utf-8'), 'user edit\n');
    assert.ok(manifest.files['cursor::commands:build:.cursor/commands/build.md']);
  });
});

test('exclusive cleanup removes recognizable files and non-reserved bundles, then retires manifest', async () => {
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
    assert.equal(fs.existsSync(projectManifestPath(homes.asbHome, project)), false);

    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "managed"\n\n[commands]\nenabled = ["build"]\n'
    );
    const managedAgain = await runSync({ project });
    assert.equal(managedAgain.exitCode, 0, JSON.stringify(managedAgain.entries, null, 2));
    assert.equal(fs.existsSync(projectManifestPath(homes.asbHome, project)), true);
  });
});

test('project mode none creates no output, manifest ownership, or project ledger entry', async () => {
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
    const ledger = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8')
    ) as { entries: Array<{ path: string }> };

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    assert.equal(fs.existsSync(projectManifestPath(homes.asbHome, project)), false);
    assert.equal(
      ledger.entries.some((entry) => entry.path.startsWith(project)),
      false
    );
  });
});

test('a failed exclusive cleanup preserves the prior managed manifest byte-exact', async () => {
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
    const manifestPath = projectManifestPath(homes.asbHome, project);
    const before = fs.readFileSync(manifestPath, 'utf-8');
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "exclusive"\n\n[skills]\nenabled = []\n'
    );
    const outside = path.join(homes.root, 'outside-skill');
    fs.mkdirSync(outside);
    const link = path.join(project, '.cursor', 'skills', 'escape');
    fs.symlinkSync(outside, link, 'dir');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), before);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
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
