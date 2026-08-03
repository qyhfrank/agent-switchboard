import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows, projectAppRows } from '../../src/engine/apps.js';
import { runExplain, runSync } from '../../src/engine/cli.js';
import { effectiveSelection, loadConfig } from '../../src/engine/config.js';
import { loadProjectManifest, peerStatePath, projectManifestPath } from '../../src/engine/peer.js';
import { projectRegion } from '../../src/engine/shapes.js';
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

test('project hooks keep ownership in the scoped hooks v1 state, never the manifest', async () => {
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
    const projectPeer = peerStatePath(homes.asbHome, 'claude-code', project);
    const state = JSON.parse(fs.readFileSync(projectPeer, 'utf-8')) as {
      events: Record<string, unknown[]>;
    };

    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));
    assert.equal(fs.existsSync(globalPeer), false);
    assert.equal(state.events.UserPromptSubmit.length, 1);
    assert.equal(fs.existsSync(projectManifestPath(homes.asbHome, project)), false);

    fs.writeFileSync(path.join(project, '.asb.toml'), '[hooks]\nenabled = []\n');
    const second = await runSync({ project });
    const settings = JSON.parse(
      fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf-8')
    ) as Record<string, unknown>;

    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.equal(Object.hasOwn(settings, 'hooks'), false);
    assert.equal(fs.existsSync(projectPeer), false);
  });
});

test('project hook bundle cleanup follows the scoped 0.4 ownership list', async () => {
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

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.dirname(target)), false);
    assert.equal(fs.existsSync(peerStatePath(homes.asbHome, 'claude-code', project)), false);
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
    const corrupt = '{ "version": 1, "updatedAt": "x", "sections": ';
    fs.writeFileSync(manifestPath, corrupt);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), corrupt);
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    assert.equal(report.entries[0]?.path, manifestPath);
  });
});

test('a live slug collision names both roots and applies no second-project write', async () => {
  await withScratchHomes(async (homes) => {
    const first = path.join(homes.root, 'a--b', 'c');
    const second = path.join(homes.root, 'a', 'b--c');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/build.md', 'desired\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build"]\n'
    );
    projectConfig(first);
    projectConfig(second);

    const firstRun = await runSync({ project: first });
    const secondRun = await runSync({ project: second });
    const reason = secondRun.entries[0]?.reason ?? '';

    assert.equal(firstRun.exitCode, 0, JSON.stringify(firstRun.entries, null, 2));
    assert.equal(secondRun.exitCode, 1);
    assert.match(reason, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(reason, new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.existsSync(path.join(second, '.cursor', 'commands', 'build.md')), false);
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
    ) as { sections: { commands?: Record<string, unknown> } };

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(target, 'utf-8'), 'user edit\n');
    assert.ok(manifest.sections.commands?.['build::cursor']);
  });
});

test('manifest save failure reports unproven writes and the next sync records them', async () => {
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
    const originalRename = fs.renameSync;
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (path.resolve(String(newPath)) === manifestPath) throw new Error('fixture write failure');
      originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    let failed: Awaited<ReturnType<typeof runSync>>;
    try {
      failed = await runSync({ project });
    } finally {
      fs.renameSync = originalRename;
    }

    const target = path.join(project, '.cursor', 'commands', 'build.md');
    const manifestFailure = failed.entries.find((entry) => entry.path === manifestPath);
    assert.equal(failed.exitCode, 1);
    assert.equal(fs.readFileSync(target, 'utf-8'), 'desired\n');
    assert.equal(fs.existsSync(manifestPath), false);
    assert.match(manifestFailure?.reason ?? '', /written without durable peer proof/i);
    assert.match(manifestFailure?.reason ?? '', /next successful sync re-records ownership/i);

    const recovered = await runSync({ project });
    assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.entries, null, 2));
    assert.ok(
      loadProjectManifest(homes.asbHome, project).manifest?.sections.commands?.['build::cursor']
    );
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

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(project, '.cursor', 'commands', 'build.md')), false);
    assert.equal(fs.existsSync(projectManifestPath(homes.asbHome, project)), false);
    // A project-scope run never touches the machine ledger at all.
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'ledger.json')), false);
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
