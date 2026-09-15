import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { executeAction, runSync } from '../src/engine/cli.js';
import type { Action } from '../src/engine/plan.js';
import { hashContent, mergeProjectRegion } from '../src/engine/shapes.js';
import {
  installApps,
  seedRule,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

test('project plugin rules share one host and canonical Claude link across sync and deselection', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const plugin = path.join(homes.root, 'team');
    seedTree(plugin, { 'rules/style.md': 'Team style\n' });
    seedTree(project, {
      '.asb.toml': '[plugins]\nenabled = ["team"]\n',
      'AGENTS.md': '# Repository instructions\n',
      '.claude/CLAUDE.md': mergeProjectRegion('Keep this note.\n', 'Previous managed rule'),
    });
    installApps(homes, 'claude-code', 'codex');
    writeUserConfig(
      homes,
      `[applications]\nenabled = ["claude-code", "codex"]\n[plugins.sources]\nteam = ${JSON.stringify(plugin)}\n`
    );
    const agents = path.join(project, 'AGENTS.md');
    const link = path.join(project, 'CLAUDE.md');
    const previous = path.join(project, '.claude', 'CLAUDE.md');

    const dry = await runSync({ project, dryRun: true });
    assert.equal(dry.exitCode, 0, JSON.stringify(dry.entries));
    assert.equal(fs.existsSync(link), false);
    assert.match(fs.readFileSync(previous, 'utf-8'), /Previous managed rule/);
    const first = await runSync({ project });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries));
    assert.equal(fs.readlinkSync(link), 'AGENTS.md');
    const content = fs.readFileSync(agents, 'utf-8');
    assert.equal(content.match(/rules:start/g)?.length, 1);
    assert.match(content, /Team style/);
    assert.match(content, /Repository instructions/);
    assert.equal(fs.readFileSync(previous, 'utf-8'), 'Keep this note.\n');
    assert.equal(
      first.entries.filter((entry) => entry.scope === 'project' && entry.path === agents).length,
      1
    );
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.readFileSync(agents, 'utf-8'), content);
    assert.equal(fs.readlinkSync(link), 'AGENTS.md');

    fs.writeFileSync(path.join(project, '.asb.toml'), '[plugins]\nenabled = []\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.readFileSync(agents, 'utf-8'), '# Repository instructions\n');
    assert.equal(fs.readlinkSync(link), 'AGENTS.md');
  });
});

test('Claude link collisions preserve files and foreign links under the default takeover policy', async () => {
  for (const shape of ['file', 'directory', 'internal', 'external', 'dangling'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      const managed = mergeProjectRegion('Personal note.\n', 'Old rule');
      seedTree(project, {
        '.asb.toml': '[rules]\nenabled = ["base"]\n',
        '.claude/CLAUDE.md': managed,
      });
      installApps(homes, 'claude-code');
      seedRule(homes, 'base.md', 'New rule\n');
      writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
      const link = path.join(project, 'CLAUDE.md');
      const other = path.join(shape === 'internal' ? project : homes.root, 'other.md');
      if (shape === 'file') fs.writeFileSync(link, 'Independent instructions\n');
      else if (shape === 'directory') fs.mkdirSync(link);
      else {
        if (shape !== 'dangling') fs.writeFileSync(other, 'Foreign instructions\n');
        fs.symlinkSync(shape === 'internal' ? 'other.md' : other, link);
      }
      for (const dryRun of [true, false]) {
        const report = await runSync({ project, dryRun });
        assert.equal(
          report.entries.find((entry) => entry.path === link)?.outcome,
          'conflict',
          shape
        );
        assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), managed);
      }
      if (shape === 'file')
        assert.equal(fs.readFileSync(link, 'utf-8'), 'Independent instructions\n');
      else if (shape === 'directory') assert.ok(fs.statSync(link).isDirectory());
      else {
        assert.equal(fs.readlinkSync(link), shape === 'internal' ? 'other.md' : other);
        if (shape === 'dangling') assert.equal(fs.existsSync(other), false);
        else assert.equal(fs.readFileSync(other, 'utf-8'), 'Foreign instructions\n');
      }
    });
  }
});

test('shared rule conflicts preserve the previous Claude region and do not create a link', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const previous = mergeProjectRegion('', 'Old rule');
    seedTree(project, {
      '.asb.toml':
        '[applications.claude-code.rules]\nenabled = ["a"]\n[applications.codex.rules]\nenabled = ["b"]\n',
      '.claude/CLAUDE.md': previous,
    });
    installApps(homes, 'claude-code', 'codex');
    seedRule(homes, 'a.md', 'Alpha\n');
    seedRule(homes, 'b.md', 'Beta\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code", "codex"]\n');
    const report = await runSync({ project });
    assert.equal(report.exitCode, 1);
    assert.ok(report.entries.some((entry) => entry.detail === 'shared-writer'));
    assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), false);
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), previous);
  });
});

test('Claude cleanup preserves unmarked, malformed, linked and escaping previous hosts', async () => {
  for (const shape of ['unmarked', 'malformed', 'linked', 'escaping'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      const outside = path.join(homes.root, 'outside');
      const content =
        shape === 'unmarked'
          ? 'Personal instructions\n'
          : shape === 'malformed'
            ? '<!-- rules:start -->\nIncomplete\n'
            : mergeProjectRegion('Personal note.\n', 'Old rule');
      seedTree(project, { '.asb.toml': '[rules]\nenabled = ["base"]\n' });
      seedTree(outside, { 'CLAUDE.md': content });
      const previous = path.join(project, '.claude', 'CLAUDE.md');
      if (shape === 'escaping') fs.symlinkSync(outside, path.dirname(previous));
      else {
        fs.mkdirSync(path.dirname(previous));
        if (shape === 'linked') fs.symlinkSync(path.join(outside, 'CLAUDE.md'), previous);
        else fs.writeFileSync(previous, content);
      }
      installApps(homes, 'claude-code');
      seedRule(homes, 'base.md', 'New rule\n');
      writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
      await runSync({ project });
      assert.equal(fs.readlinkSync(path.join(project, 'CLAUDE.md')), 'AGENTS.md');
      assert.equal(fs.readFileSync(previous, 'utf-8'), content);
      assert.equal(fs.readFileSync(path.join(outside, 'CLAUDE.md'), 'utf-8'), content);
    });
  }
});

test('deselection keeps the canonical link target present and removes only the managed region', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    seedTree(project, {
      '.asb.toml': '[rules]\nenabled = ["base"]\n',
      '.claude/CLAUDE.md': mergeProjectRegion('', 'Old rule'),
    });
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'New rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.existsSync(path.join(project, '.claude', 'CLAUDE.md')), false);
    fs.writeFileSync(path.join(project, '.asb.toml'), '[rules]\nenabled = []\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.readlinkSync(path.join(project, 'CLAUDE.md')), 'AGENTS.md');
    assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), '');
    assert.equal((await runSync({ project })).exitCode, 0);
  });
});

test('Claude link apply refuses occupied drift, host drift and cleanup symlink drift', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    seedTree(project, { 'AGENTS.md': 'Rules\n' });
    const link = path.join(project, 'CLAUDE.md');
    const action: Action = {
      app: 'claude-code',
      type: 'rules',
      id: null,
      path: link,
      root: project,
      op: 'write',
      outcome: 'written',
      symlink: { target: 'AGENTS.md', expectedTarget: null, hostHash: hashContent('Rules\n') },
    };
    fs.symlinkSync('missing.md', link);
    assert.equal(executeAction(action).outcome, 'conflict');
    assert.equal(fs.readlinkSync(link), 'missing.md');
    fs.unlinkSync(link);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Edited\n');
    assert.equal(executeAction(action).outcome, 'conflict');
    assert.equal(fs.existsSync(link), false);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Rules\n');
    assert.equal(executeAction(action).outcome, 'written');
    assert.equal(fs.readlinkSync(link), 'AGENTS.md');
    const cleanup: Action = {
      app: 'claude-code',
      type: 'rules',
      id: null,
      path: link,
      root: project,
      op: 'remove',
      outcome: 'removed',
      expectedHash: hashContent('Rules\n'),
      expectedLinkTarget: null,
    };
    assert.equal(executeAction(cleanup).outcome, 'conflict');
    assert.equal(fs.readlinkSync(link), 'AGENTS.md');
  });
});

test('a failed Claude link apply preserves the previous managed region', async (context) => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const previous = mergeProjectRegion('Personal note.\n', 'Old rule');
    seedTree(project, {
      '.asb.toml': '[rules]\nenabled = ["base"]\n',
      '.claude/CLAUDE.md': previous,
    });
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'New rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    const link = path.join(project, 'CLAUDE.md');
    const symlink = fs.symlinkSync;
    context.mock.method(fs, 'symlinkSync', (...args: Parameters<typeof fs.symlinkSync>) => {
      if (args[1] === link) throw new Error('simulated link failure');
      return symlink(...args);
    });
    const report = await runSync({ project });
    assert.equal(report.exitCode, 1);
    assert.equal(report.entries.find((entry) => entry.path === link)?.outcome, 'failed');
    assert.equal(
      report.entries.find((entry) => entry.path === path.join(project, '.claude', 'CLAUDE.md'))
        ?.detail,
      'replacement-failed'
    );
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), previous);
  });
});

test('an escaping shared host blocks the Claude link and previous-host cleanup', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const previous = mergeProjectRegion('', 'Old rule');
    seedTree(project, {
      '.asb.toml': '[rules]\nenabled = ["base"]\n',
      '.claude/CLAUDE.md': previous,
    });
    const outside = path.join(homes.root, 'outside.md');
    fs.writeFileSync(outside, 'Outside instructions\n');
    fs.symlinkSync(outside, path.join(project, 'AGENTS.md'));
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'New rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    for (const dryRun of [true, false]) {
      const report = await runSync({ project, dryRun });
      assert.equal(report.exitCode, 1);
      assert.ok(
        report.entries.some((entry) => entry.scope === 'project' && entry.detail === 'path-escape')
      );
      assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), false);
      assert.equal(fs.readFileSync(outside, 'utf-8'), 'Outside instructions\n');
      assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), previous);
    }
  });
});

test('a previous Claude host that backs AGENTS.md retains its active rules', async () => {
  for (const userText of ['', 'Personal instructions\n']) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      const content = mergeProjectRegion(userText, 'Selected rule\n');
      seedTree(project, {
        '.asb.toml': '[rules]\nenabled = ["base"]\n',
        '.claude/CLAUDE.md': content,
      });
      fs.symlinkSync('.claude/CLAUDE.md', path.join(project, 'AGENTS.md'));
      installApps(homes, 'claude-code');
      seedRule(homes, 'base.md', 'Selected rule\n');
      writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
      for (const dryRun of [true, false, false]) {
        await runSync({ project, dryRun });
        assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), content);
        assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), content);
        if (!dryRun) {
          assert.equal(fs.readlinkSync(path.join(project, 'CLAUDE.md')), 'AGENTS.md');
          assert.equal(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8'), content);
        }
      }
    });
  }
});

test('a shared host linked to an independent root Claude file preserves that file', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const independent = 'Independent instructions\n';
    seedTree(project, {
      '.asb.toml': '[rules]\nenabled = ["base"]\n',
      'CLAUDE.md': independent,
    });
    fs.symlinkSync('CLAUDE.md', path.join(project, 'AGENTS.md'));
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'Selected rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    for (const dryRun of [true, false]) {
      const report = await runSync({ project, dryRun });
      assert.equal(report.exitCode, 1);
      assert.ok(report.entries.some((entry) => entry.outcome === 'conflict'));
      assert.equal(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8'), independent);
      assert.equal(fs.readlinkSync(path.join(project, 'AGENTS.md')), 'CLAUDE.md');
    }
  });
});

test('deselection retains the canonical link target after Claude leaves enabled applications', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    seedTree(project, { '.asb.toml': '[rules]\nenabled = ["base"]\n' });
    installApps(homes, 'claude-code', 'codex');
    seedRule(homes, 'base.md', 'Selected rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code", "codex"]\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    fs.writeFileSync(path.join(project, '.asb.toml'), '[rules]\nenabled = []\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.readlinkSync(path.join(project, 'CLAUDE.md')), 'AGENTS.md');
    assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), '');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8'), '');
  });
});

test('shared host apply refuses a same-content alias change into a protected file', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const content = 'Independent instructions\n';
    seedTree(project, { 'AGENTS.md': content, 'CLAUDE.md': content });
    const agents = path.join(project, 'AGENTS.md');
    const claude = path.join(project, 'CLAUDE.md');
    const action: Action = {
      app: 'project',
      type: 'rules',
      id: null,
      path: agents,
      root: project,
      op: 'write',
      outcome: 'written',
      content: mergeProjectRegion(content, 'New rule'),
      expectedHash: hashContent(content),
      expectedPaths: [
        { path: agents, resolvedPath: agents },
        { path: claude, resolvedPath: claude },
      ],
    };
    fs.unlinkSync(agents);
    fs.symlinkSync('CLAUDE.md', agents);
    const result = executeAction(action);
    assert.equal(result.outcome, 'conflict');
    assert.equal(result.detail, 'path-changed');
    assert.equal(fs.readFileSync(claude, 'utf-8'), content);
  });
});

test('cleanup refuses a shared host retargeted to the previous host after link creation', async (context) => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const content = mergeProjectRegion('', 'Selected rule\n');
    seedTree(project, {
      '.asb.toml': '[rules]\nenabled = ["base"]\n',
      '.claude/CLAUDE.md': content,
    });
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'Selected rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    const agents = path.join(project, 'AGENTS.md');
    const claude = path.join(project, 'CLAUDE.md');
    const previous = path.join(project, '.claude', 'CLAUDE.md');
    const symlink = fs.symlinkSync;
    context.mock.method(fs, 'symlinkSync', (...args: Parameters<typeof fs.symlinkSync>) => {
      symlink(...args);
      if (args[1] === claude) {
        fs.unlinkSync(agents);
        symlink('.claude/CLAUDE.md', agents);
      }
    });
    const report = await runSync({ project });
    assert.equal(report.exitCode, 1);
    assert.equal(report.entries.find((entry) => entry.path === previous)?.detail, 'path-changed');
    assert.equal(fs.readFileSync(previous, 'utf-8'), content);
    assert.equal(fs.readFileSync(claude, 'utf-8'), content);
  });
});
