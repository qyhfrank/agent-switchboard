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

test('project plugin rules share one AGENTS.md region with Claude Code across sync and deselection', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const plugin = path.join(homes.root, 'team');
    seedTree(plugin, { 'rules/style.md': 'Team style\n' });
    seedTree(project, {
      '.asb.toml': '[plugins]\nenabled = ["team"]\n',
      'AGENTS.md': '# Repository instructions\n',
      '.claude/CLAUDE.md': mergeProjectRegion('', 'Previous managed rule'),
    });
    installApps(homes, 'claude-code', 'codex');
    writeUserConfig(
      homes,
      `[applications]\nenabled = ["claude-code", "codex"]\n[plugins.sources]\nteam = ${JSON.stringify(plugin)}\n`
    );
    const agents = path.join(project, 'AGENTS.md');
    const previous = path.join(project, '.claude', 'CLAUDE.md');

    const dry = await runSync({ project, dryRun: true });
    assert.equal(dry.exitCode, 0, JSON.stringify(dry.entries));
    assert.equal(dry.entries.find((entry) => entry.path === previous)?.outcome, 'removed');
    assert.match(fs.readFileSync(previous, 'utf-8'), /Previous managed rule/);
    const first = await runSync({ project });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries));
    const content = fs.readFileSync(agents, 'utf-8');
    assert.equal(content.match(/rules:start/g)?.length, 1);
    assert.match(content, /Team style/);
    assert.match(content, /Repository instructions/);
    assert.equal(fs.existsSync(previous), false);
    assert.equal(
      fs.lstatSync(path.join(project, 'CLAUDE.md'), { throwIfNoEntry: false }),
      undefined
    );
    assert.equal(
      first.entries.filter((entry) => entry.scope === 'project' && entry.path === agents).length,
      1
    );
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.readFileSync(agents, 'utf-8'), content);

    fs.writeFileSync(path.join(project, '.asb.toml'), '[plugins]\nenabled = []\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.readFileSync(agents, 'utf-8'), '# Repository instructions\n');
    assert.equal(
      fs.lstatSync(path.join(project, 'CLAUDE.md'), { throwIfNoEntry: false }),
      undefined
    );
  });
});

test('a Claude sync removes the legacy CLAUDE.md link to AGENTS.md and dry runs report it', async () => {
  for (const selected of [true, false]) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      seedTree(project, {
        '.asb.toml': selected ? '[rules]\nenabled = ["base"]\n' : '[rules]\nenabled = []\n',
        'AGENTS.md': mergeProjectRegion('# Repository instructions\n', 'Old rule'),
      });
      const link = path.join(project, 'CLAUDE.md');
      fs.symlinkSync('AGENTS.md', link);
      installApps(homes, 'claude-code');
      seedRule(homes, 'base.md', 'New rule\n');
      writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');

      const dry = await runSync({ project, dryRun: true });
      const row = dry.entries.find((entry) => entry.path === link);
      assert.equal(row?.outcome, 'removed', JSON.stringify(dry.entries));
      assert.equal(row?.detail, 'legacy-link');
      assert.equal(fs.readlinkSync(link), 'AGENTS.md');

      const report = await runSync({ project });
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
      assert.equal(report.entries.find((entry) => entry.path === link)?.outcome, 'removed');
      assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
      const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8');
      assert.match(agents, /Repository instructions/);
      if (selected) assert.match(agents, /New rule/);
      else assert.doesNotMatch(agents, /rule/);
    });
  }
});

test('emptying AGENTS.md without Claude Code keeps the host behind a legacy CLAUDE.md link', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    seedTree(project, {
      '.asb.toml': '[rules]\nenabled = []\n',
      'AGENTS.md': mergeProjectRegion('', 'Old rule'),
    });
    const link = path.join(project, 'CLAUDE.md');
    fs.symlinkSync('AGENTS.md', link);
    installApps(homes, 'codex');
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');

    const report = await runSync({ project });
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), '');
    assert.equal(fs.readlinkSync(link), 'AGENTS.md');
  });
});

test('deselecting Claude project rules removes a region-only .claude/CLAUDE.md whatever the root CLAUDE.md is', async () => {
  for (const root of ['none', 'legacy-link', 'independent'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      seedTree(project, {
        '.asb.toml': '[rules]\nenabled = []\n',
        'AGENTS.md': '# Repository instructions\n',
        '.claude/CLAUDE.md': mergeProjectRegion('', 'Old rule'),
      });
      const rootFile = path.join(project, 'CLAUDE.md');
      if (root === 'legacy-link') fs.symlinkSync('AGENTS.md', rootFile);
      if (root === 'independent') fs.writeFileSync(rootFile, 'Mine\n');
      installApps(homes, 'claude-code');
      writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');

      const report = await runSync({ project });
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
      assert.equal(fs.existsSync(path.join(project, '.claude', 'CLAUDE.md')), false);
      assert.equal(
        fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'),
        '# Repository instructions\n'
      );
      if (root === 'independent') assert.equal(fs.readFileSync(rootFile, 'utf-8'), 'Mine\n');
      const again = await runSync({ project });
      assert.equal(
        again.entries.filter((entry) => entry.scope === 'project' && entry.outcome !== 'unchanged')
          .length,
        0,
        JSON.stringify(again.entries)
      );
    });
  }
});

test('an independent root CLAUDE.md or foreign link is preserved and reported as a conflict', async () => {
  for (const shape of ['file', 'directory', 'internal', 'external', 'dangling'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      const managed = mergeProjectRegion('', 'Old rule');
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
        const row = report.entries.find((entry) => entry.path === link);
        assert.equal(row?.outcome, 'conflict', shape);
        assert.match(row?.reason ?? '', /Claude Code reads it instead of AGENTS\.md/);
        assert.equal(report.exitCode, 1);
        assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), managed);
      }
      assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), /New rule/);
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

test('shared rule conflicts preserve the previous Claude region', async () => {
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
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), previous);
  });
});

test('previous Claude hosts that cannot be removed as a managed region are preserved', async () => {
  for (const shape of ['annotated', 'unmarked', 'malformed', 'linked', 'escaping'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      const outside = path.join(homes.root, 'outside');
      const content =
        shape === 'unmarked'
          ? 'Personal instructions\n'
          : shape === 'malformed'
            ? '<!-- rules:start -->\nIncomplete\n'
            : shape === 'annotated'
              ? mergeProjectRegion('Personal note.\n', 'Old rule')
              : mergeProjectRegion('', 'Old rule');
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
      const report = await runSync({ project });
      assert.equal(report.exitCode, 1, shape);
      assert.ok(
        report.entries.some(
          (entry) =>
            entry.path === previous && ['conflict', 'blocked'].includes(entry.outcome ?? '')
        ),
        shape
      );
      assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), /New rule/);
      assert.equal(fs.readFileSync(previous, 'utf-8'), content);
      assert.equal(fs.readFileSync(path.join(outside, 'CLAUDE.md'), 'utf-8'), content);
      assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), false);
    });
  }
});

test('deselection removes only the managed region', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    seedTree(project, { '.asb.toml': '[rules]\nenabled = ["base"]\n' });
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'New rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), /New rule/);
    fs.writeFileSync(path.join(project, '.asb.toml'), '[rules]\nenabled = []\n');
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), false);
    assert.equal((await runSync({ project })).exitCode, 0);
  });
});

test('legacy link removal and previous-host cleanup refuse leaf identity drift', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    seedTree(project, { 'AGENTS.md': 'Rules\n', 'other.md': 'Rules\n' });
    const link = path.join(project, 'CLAUDE.md');
    const removal: Action = {
      app: 'claude-code',
      type: 'rules',
      id: null,
      path: link,
      root: project,
      op: 'remove',
      outcome: 'removed',
      expectedHash: hashContent('Rules\n'),
      expectedLinkTarget: 'AGENTS.md',
    };
    fs.symlinkSync('other.md', link);
    assert.equal(executeAction(removal).outcome, 'conflict');
    assert.equal(fs.readlinkSync(link), 'other.md');
    fs.unlinkSync(link);
    fs.symlinkSync('AGENTS.md', link);
    assert.equal(executeAction(removal).outcome, 'removed');
    assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), 'Rules\n');

    fs.symlinkSync('AGENTS.md', link);
    const cleanup: Action = { ...removal, expectedLinkTarget: null };
    assert.equal(executeAction(cleanup).outcome, 'conflict');
    assert.equal(fs.readlinkSync(link), 'AGENTS.md');
  });
});

test('a failed AGENTS.md write preserves the previous Claude region', async (context) => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    const previous = mergeProjectRegion('', 'Old rule');
    seedTree(project, {
      '.asb.toml': '[rules]\nenabled = ["base"]\n',
      '.claude/CLAUDE.md': previous,
    });
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'New rule\n');
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    const rename = fs.renameSync;
    context.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      if (path.basename(String(args[1])) === 'AGENTS.md') throw new Error('simulated failure');
      return rename(...args);
    });
    const report = await runSync({ project });
    assert.equal(report.exitCode, 1);
    assert.equal(
      report.entries.find((entry) => entry.path === path.join(project, 'AGENTS.md'))?.outcome,
      'failed'
    );
    assert.equal(
      report.entries.find((entry) => entry.path === path.join(project, '.claude', 'CLAUDE.md'))
        ?.detail,
      'replacement-failed'
    );
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), previous);
  });
});

test('an escaping shared host blocks previous-host cleanup', async () => {
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
        const report = await runSync({ project, dryRun });
        assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
        assert.equal(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8'), content);
        assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8'), content);
        assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), false);
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
      expectedPaths: [{ path: agents, resolvedPath: agents }],
    };
    fs.unlinkSync(agents);
    fs.symlinkSync('CLAUDE.md', agents);
    const result = executeAction(action);
    assert.equal(result.outcome, 'conflict');
    assert.equal(result.detail, 'path-changed');
    assert.equal(fs.readFileSync(claude, 'utf-8'), content);
  });
});

test('cleanup refuses a shared host retargeted to the previous host after its write', async (context) => {
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
    const previous = path.join(project, '.claude', 'CLAUDE.md');
    const rename = fs.renameSync;
    context.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      rename(...args);
      if (path.basename(String(args[1])) === 'AGENTS.md') {
        fs.unlinkSync(agents);
        fs.symlinkSync('.claude/CLAUDE.md', agents);
      }
    });
    const report = await runSync({ project });
    assert.equal(report.exitCode, 1);
    assert.equal(report.entries.find((entry) => entry.path === previous)?.detail, 'path-changed');
    assert.equal(fs.readFileSync(previous, 'utf-8'), content);
  });
});
