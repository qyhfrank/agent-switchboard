import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import type { Report } from '../src/engine/report.js';
import {
  installApps,
  runMain,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

test('dsh preserves global instructions and receives skills through the shared directory', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'dsh');
    const root = path.join(homes.agentsHome, '.dsh');
    seedTree(root, { 'AGENTS.md': '# Personal instructions\n' });
    seedRule(homes, 'policy.md', 'Check the result.\n');
    seedSkill(homes, 'review');
    seedTree(homes.asbHome, {
      'commands/review.md': 'Review.\n',
      'agents/reviewer.md': 'Review.\n',
      'hooks/review.json':
        '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo review"}]}]}}\n',
    });
    seedMcpLibrary(homes, { local: { command: 'server' } });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["dsh"]\n[rules]\nenabled = ["policy"]\n[skills]\nenabled = ["review"]\n[commands]\nenabled = ["review"]\n[agents]\nenabled = ["reviewer"]\n[hooks]\nenabled = ["review"]\n[mcp]\nenabled = ["local"]\n'
    );
    const sync = await runMain(['sync', '--json']);
    assert.equal(sync.code, 0, sync.err);
    const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(rules, /# Personal instructions/);
    assert.match(rules, /<!-- rules:start -->\nCheck the result\./);
    assert.ok(
      fs.existsSync(path.join(homes.agentsHome, '.agents', 'skills', 'review', 'SKILL.md'))
    );
    assert.deepEqual(fs.readdirSync(root), ['AGENTS.md']);
    assert.equal(fs.existsSync(path.join(root, 'cordis.patch.yml')), false);
    const status = await runMain(['status', '--all', '--json']);
    assert.equal(status.code, 0, status.err);
    const report = JSON.parse(status.out) as Report;
    assert.deepEqual(
      report.entries
        .filter((entry) => entry.app === 'dsh' && entry.detail === 'app-lacks-type')
        .map((entry) => entry.type)
        .sort(),
      ['agents', 'commands', 'hooks', 'mcp', 'native_plugins']
    );
  });
});

test('dsh own skills destinations work in user and project scope', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'dsh');
    seedSkill(homes, 'global');
    seedSkill(homes, 'local');
    const project = path.join(homes.root, 'project');
    seedTree(project, { '.asb.toml': '[skills]\nenabled = ["global", "local"]\n' });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["dsh"]\n[skills]\nenabled = ["global"]\n[applications.dsh.skills]\ndestination = "own"\n'
    );
    const report = await runSync({ project });
    assert.equal(report.exitCode, 0);
    assert.ok(fs.existsSync(path.join(homes.agentsHome, '.dsh', 'skills', 'global', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(project, '.dsh', 'skills', 'local', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(project, '.dsh', 'skills', 'global')), false);
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.agents', 'skills')), false);
  });
});

test('status --all derives shared skills support and missing command support from application rows', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    seedSkill(homes, 'review');
    seedTree(homes.asbHome, { 'commands/review.md': 'Review.\n' });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "traecli"]\n[skills]\nenabled = ["review"]\n[commands]\nenabled = ["review"]\n'
    );
    const status = await runMain(['status', '--all', '--json']);
    assert.equal(status.code, 0, status.err);
    const report = JSON.parse(status.out) as Report;
    assert.ok(
      report.entries.some(
        (entry) =>
          entry.app === 'codex' && entry.type === 'commands' && entry.detail === 'app-lacks-type'
      )
    );
    assert.equal(
      report.entries.some(
        (entry) =>
          entry.app === 'traecli' && entry.type === 'skills' && entry.detail === 'app-lacks-type'
      ),
      false
    );
    assert.ok(
      report.entries.some(
        (entry) => entry.app === 'agents' && entry.type === 'skills' && entry.id === 'review'
      )
    );
  });
});
