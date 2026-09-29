import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import { configPath, managedDir, seedHook, seedRunner } from './helpers/hooks.js';
import {
  installApps,
  type ScratchHomes,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  seedSource,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const selection = (apps = ['claude-code', 'codex']) =>
  `[applications]\nenabled = ${JSON.stringify(apps)}\n` +
  ['rules', 'skills', 'commands', 'agents', 'hooks', 'mcp']
    .map((type) => `[${type}]\nenabled = ["alpha"]\n`)
    .join('\n');

function seed(homes: ScratchHomes): void {
  installApps(homes, 'claude-code', 'codex');
  seedRule(homes, 'alpha.md', 'Managed rule.\n');
  seedSkill(homes, 'alpha', { files: { 'extra.txt': 'payload\n' } });
  seedTree(homes.asbHome, {
    'commands/alpha.md': 'Managed command.\n',
    'agents/alpha.md': '---\nextras:\n  codex:\n    model: gpt-5\n---\nManaged agent.\n',
  });
  seedRunner(homes, 'alpha');
  seedMcpLibrary(homes, {
    alpha: { command: 'alpha', env: { SECRET: 'do-not-record-this-secret' } },
  });
  writeUserConfig(homes, selection());
}

function deleteSources(homes: ScratchHomes): void {
  for (const name of ['rules', 'skills', 'commands', 'agents', 'hooks', 'mcp.json']) {
    fs.rmSync(path.join(homes.asbHome, name), { recursive: true, force: true });
  }
}

function stateFiles(homes: ScratchHomes): string[] {
  const dir = path.join(homes.stateHome, 'distribution');
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

for (const retire of ['delete', 'delete-and-deselect', 'disable-applications'] as const) {
  test(`recorded distributions retire after ${retire}, including shared host slices`, async () => {
    await withScratchHomes(async (homes) => {
      seed(homes);
      assert.equal((await runSync()).exitCode, 0);
      const state = stateFiles(homes)
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('');
      assert.ok(!state.includes('do-not-record-this-secret'));
      const claudeSettings = configPath(homes, 'claude-code');
      const host = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
      host.keep = 'foreign';
      host.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'foreign-hook' }] });
      fs.writeFileSync(claudeSettings, JSON.stringify(host));
      const foreign = path.join(homes.agentsHome, '.claude', 'skills', 'foreign');
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'foreign');
      if (retire !== 'disable-applications') deleteSources(homes);
      if (retire !== 'delete')
        writeUserConfig(
          homes,
          retire === 'disable-applications'
            ? selection([])
            : '[applications]\nenabled = ["claude-code", "codex"]\n'
        );
      const before = stateFiles(homes).map((file) => fs.readFileSync(file, 'utf8'));
      const preview = await runSync({ dryRun: true });
      assert.ok(preview.entries.some((entry) => entry.outcome === 'removed'));
      assert.ok(fs.existsSync(managedDir(homes, 'claude-code', 'alpha')));
      assert.deepEqual(
        stateFiles(homes).map((file) => fs.readFileSync(file, 'utf8')),
        before
      );
      const report = await runSync();
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
      for (const app of ['.claude', '.codex']) {
        for (const type of ['skills', 'commands', 'agents']) {
          const parent = path.join(homes.agentsHome, app, type);
          if (fs.existsSync(parent))
            assert.ok(
              !fs.readdirSync(parent).some((name) => name.startsWith('alpha')),
              `${app}/${type}`
            );
        }
      }
      assert.equal(fs.existsSync(managedDir(homes, 'claude-code', 'alpha')), false);
      const remaining = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
      assert.equal(remaining.keep, 'foreign');
      assert.deepEqual(remaining.hooks.UserPromptSubmit, [
        { hooks: [{ type: 'command', command: 'foreign-hook' }] },
      ]);
      assert.equal(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'), 'foreign');
      const codex = fs.readFileSync(path.join(homes.agentsHome, '.codex', 'config.toml'), 'utf8');
      assert.ok(!codex.includes('[agents.alpha]') && !codex.includes('[mcp_servers.alpha]'), codex);
      await runSync();
      writeUserConfig(homes, '[applications]\nenabled = []\n');
      await runSync();
      for (const file of stateFiles(homes)) {
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).slices, []);
      }
    });
  });
}

test('inline hooks retire after their definitions disappear, without removing their foreign neighbors', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const file = seedHook(homes, 'inline', {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'inline-command' }] }],
    });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n[hooks]\nenabled = ["inline"]\n'
    );
    await runSync();
    fs.unlinkSync(file);
    assert.equal((await runSync()).exitCode, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(configPath(homes, 'claude-code'), 'utf8')).hooks,
      undefined
    );
  });
});

test('edited recorded files and bundles are removed during retirement', async () => {
  await withScratchHomes(async (homes) => {
    seed(homes);
    await runSync();
    const command = path.join(homes.agentsHome, '.claude', 'commands', 'alpha.md');
    const skill = path.join(homes.agentsHome, '.claude', 'skills', 'alpha', 'SKILL.md');
    fs.writeFileSync(command, 'local command');
    fs.writeFileSync(skill, 'local skill');
    deleteSources(homes);
    const report = await runSync();
    for (const target of [command, path.dirname(skill)]) {
      assert.ok(
        report.entries.some((entry) => entry.path === target && entry.outcome === 'removed')
      );
    }
    assert.equal(fs.existsSync(command), false);
    assert.equal(fs.existsSync(path.dirname(skill)), false);
  });
});

test('type and application filters leave excluded ownership available for a later run', async () => {
  await withScratchHomes(async (homes) => {
    seed(homes);
    await runSync();
    deleteSources(homes);
    await runSync({ apps: ['claude-code'], types: ['skills'] });
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.claude', 'skills', 'alpha')), false);
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.codex', 'skills', 'alpha')), true);
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.claude', 'commands', 'alpha.md')),
      true
    );
    await runSync();
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.codex', 'skills', 'alpha')), false);
  });
});

test('a partial bundle removal remains retryable after its source is gone', async () => {
  await withScratchHomes(async (homes) => {
    seed(homes);
    await runSync();
    deleteSources(homes);
    const target = path.join(homes.agentsHome, '.claude', 'skills', 'alpha', 'extra.txt');
    const unlink = fs.unlinkSync;
    fs.unlinkSync = ((file: fs.PathLike) => {
      if (String(file) === target) throw new Error('busy');
      return unlink(file);
    }) as typeof fs.unlinkSync;
    try {
      assert.ok((await runSync()).entries.some((entry) => entry.detail === 'remove-failed'));
    } finally {
      fs.unlinkSync = unlink;
    }
    const retry = await runSync();
    assert.equal(retry.exitCode, 0, JSON.stringify(retry.entries));
    assert.equal(fs.existsSync(path.dirname(target)), false);
  });
});

test('invalid ownership fails closed before distribution writes', async () => {
  await withScratchHomes(async (homes) => {
    seed(homes);
    await runSync();
    fs.writeFileSync(stateFiles(homes)[0], '{ broken');
    deleteSources(homes);
    await assert.rejects(runSync(), /Invalid distribution ownership/);
    assert.ok(fs.existsSync(managedDir(homes, 'claude-code', 'alpha')));
  });
});

test('unrecorded same-name content survives a missing library entry', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(homes, selection(['claude-code']));
    const foreign = path.join(homes.agentsHome, '.claude', 'skills', 'alpha', 'SKILL.md');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, 'foreign');
    await runSync();
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign');
  });
});

test('project ownership retires deleted components without touching another project', async () => {
  await withScratchHomes(async (homes) => {
    seed(homes);
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code", "codex"]\n');
    const projects = ['one', 'two'].map((name) => path.join(homes.root, name));
    for (const project of projects) {
      fs.mkdirSync(project);
      fs.writeFileSync(
        path.join(project, '.asb.toml'),
        `${selection()}\n[distribution.project]\nmode = "managed"\n`
      );
      const report = await runSync({ project });
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    }
    deleteSources(homes);
    const report = await runSync({ project: projects[0] });
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    assert.equal(fs.existsSync(path.join(projects[0], '.claude', 'skills', 'alpha')), false);
    assert.equal(fs.existsSync(path.join(projects[1], '.claude', 'skills', 'alpha')), true);
  });
});

test('an unavailable plugin source preserves its recorded rule region and bundle', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSource(
      homes,
      'team',
      {
        'rules/base.md': 'Keep this rule.\n',
        'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha\n---\nKeep this skill.\n',
      },
      path.join(homes.root, 'team')
    );
    writeUserConfig(
      homes,
      `[applications]\nenabled = ["claude-code"]\n[plugins]\nenabled = ["team"]\n[plugins.sources]\nteam = ${JSON.stringify(source)}\n`
    );
    await runSync();
    const target = path.join(homes.agentsHome, '.claude', 'CLAUDE.md');
    const before = fs.readFileSync(target, 'utf8');
    fs.renameSync(source, `${source}-offline`);
    await runSync();
    assert.equal(fs.readFileSync(target, 'utf8'), before);
    assert.ok(fs.existsSync(path.join(homes.agentsHome, '.claude', 'skills', 'team:alpha')));
  });
});

test('a remaining rule keeps updating after another selected rule is deleted', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'First.\n');
    seedRule(homes, 'beta.md', 'Second.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n[rules]\nenabled = ["alpha", "beta"]\n'
    );
    await runSync();
    fs.unlinkSync(path.join(homes.asbHome, 'rules', 'alpha.md'));
    assert.equal((await runSync()).exitCode, 0);
    seedRule(homes, 'beta.md', 'Updated.\n');
    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    const content = fs.readFileSync(path.join(homes.agentsHome, '.claude', 'CLAUDE.md'), 'utf8');
    assert.match(content, /Updated/);
    assert.doesNotMatch(content, /First/);
  });
});

test('ownership persistence failure prevents distribution and a later run can retry', async () => {
  await withScratchHomes(async (homes) => {
    seed(homes);
    fs.mkdirSync(homes.stateHome, { recursive: true });
    const obstacle = path.join(homes.stateHome, 'distribution');
    fs.writeFileSync(obstacle, 'not a directory');
    await assert.rejects(runSync());
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.claude', 'skills', 'alpha')), false);
    fs.unlinkSync(obstacle);
    assert.equal((await runSync()).exitCode, 0);
  });
});

test('source filters also restrict cleanup after components disappear from the catalog', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    for (const source of ['one', 'two'])
      seedSource(homes, source, {
        'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha\n---\nPayload.\n',
      });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n[plugins]\nenabled = ["one", "two"]\n'
    );
    await runSync();
    for (const source of ['one', 'two'])
      fs.rmSync(path.join(homes.asbHome, 'plugins', source), { recursive: true });
    await runSync({ sources: ['one'] });
    const parent = path.join(homes.agentsHome, '.claude', 'skills');
    assert.equal(fs.existsSync(path.join(parent, 'one:alpha')), false);
    assert.equal(fs.existsSync(path.join(parent, 'two:alpha')), true);
    await runSync();
    assert.equal(fs.existsSync(path.join(parent, 'two:alpha')), false);
  });
});

test('recorded project cleanup blocks a leaf retargeted outside the repository in previews too', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, { 'commands/alpha.md': 'Payload.\n' });
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[commands]\nenabled = ["alpha"]\n[distribution.project]\nmode = "managed"\n'
    );
    await runSync({ project });
    const target = path.join(project, '.claude', 'commands', 'alpha.md');
    const outside = path.join(homes.root, 'outside.md');
    fs.renameSync(target, outside);
    fs.symlinkSync(outside, target);
    fs.unlinkSync(path.join(homes.asbHome, 'commands', 'alpha.md'));
    const before = fs.readFileSync(outside, 'utf8');
    for (const dryRun of [true, false]) {
      const report = await runSync({ project, dryRun });
      assert.equal(report.entries.find((entry) => entry.path === target)?.outcome, 'blocked');
      assert.equal(fs.readFileSync(outside, 'utf8'), before);
    }
  });
});

test('a failed update can retire the last successful output after its source disappears', async () => {
  await withScratchHomes(async (homes) => {
    seed(homes);
    await runSync();
    seedTree(homes.asbHome, { 'commands/alpha.md': 'Updated payload.\n' });
    const target = path.join(homes.agentsHome, '.claude', 'commands', 'alpha.md');
    const rename = fs.renameSync;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === target) throw new Error('busy');
      return rename(from, to);
    }) as typeof fs.renameSync;
    try {
      assert.equal((await runSync()).exitCode, 1);
    } finally {
      fs.renameSync = rename;
    }
    deleteSources(homes);
    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    assert.equal(fs.existsSync(target), false);
  });
});
