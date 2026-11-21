import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows } from '../src/engine/apps.js';
import { runSync } from '../src/engine/cli.js';
import { loadConfig } from '../src/engine/config.js';
import {
  seedMcpLibrary,
  seedSkill,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const selection =
  '[applications]\nenabled = ["workbuddy"]\n[skills]\nenabled = ["desktop"]\n[mcp]\nenabled = ["cua-driver:cua-driver"]\n';

test('WorkBuddy syncs user skills and MCP while preserving personal configuration', async () => {
  await withScratchHomes(async (homes) => {
    const root = path.join(homes.agentsHome, '.workbuddy');
    seedTree(root, {
      'mcp.json': '{"mcpServers":{"personal":{"command":"keep"}},"other":true}\n',
      'CODEBUDDY.md': 'Personal rules.\n',
      'settings.json': '{"model":"personal-model"}\n',
    });
    seedSkill(homes, 'desktop');
    const server = { type: 'stdio', command: 'cua-driver', args: ['mcp'] };
    seedMcpLibrary(homes, { 'cua-driver:cua-driver': server });
    writeUserConfig(homes, selection);
    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    assert.ok(fs.existsSync(path.join(root, 'skills/desktop/SKILL.md')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'), 'utf8')), {
      mcpServers: { personal: { command: 'keep' }, 'cua-driver:cua-driver': server },
      other: true,
    });
    assert.equal(fs.readFileSync(path.join(root, 'CODEBUDDY.md'), 'utf8'), 'Personal rules.\n');
    assert.equal(
      fs.readFileSync(path.join(root, 'settings.json'), 'utf8'),
      '{"model":"personal-model"}\n'
    );
    assert.ok((await runSync()).entries.every((entry) => entry.outcome === 'unchanged'));
    const row = appRows(loadConfig()).find((candidate) => candidate.id === 'workbuddy');
    assert.ok(row);
    for (const type of ['rules', 'commands', 'agents', 'hooks'] as const)
      assert.equal(row[type], undefined);
    const project = path.join(homes.root, 'project');
    seedTree(project, { '.asb.toml': '[skills]\nenabled = ["desktop"]\n' });
    const projectReport = await runSync({ project });
    assert.equal(projectReport.exitCode, 0);
    assert.equal(fs.existsSync(path.join(project, '.workbuddy')), false);
    assert.equal(fs.existsSync(path.join(project, '.agents')), false);
  });
});

test('WorkBuddy does not create configuration until its user directory exists', async () => {
  await withScratchHomes(async (homes) => {
    seedSkill(homes, 'desktop');
    seedMcpLibrary(homes, { 'cua-driver:cua-driver': { command: 'cua-driver', args: ['mcp'] } });
    writeUserConfig(homes, selection);
    assert.equal((await runSync()).exitCode, 0);
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.workbuddy')), false);
  });
});

test('an explicit WorkBuddy target retains its paths and can adopt identical built-in destinations', async () => {
  await withScratchHomes(async (homes) => {
    seedSkill(homes, 'desktop');
    seedMcpLibrary(homes, { 'cua-driver:cua-driver': { command: 'cua-driver', args: ['mcp'] } });
    const custom = (dir: string) =>
      `${selection}[targets.workbuddy]\ndetect = "~/${dir}"\n[targets.workbuddy.skills]\nparent_dir = "~/${dir}/skills"\n[targets.workbuddy.mcp]\nformat = "json"\nconfig_path = "~/${dir}/mcp.json"\nroot_key = "mcpServers"\n`;
    fs.mkdirSync(path.join(homes.agentsHome, '.custom-workbuddy'));
    writeUserConfig(homes, custom('.custom-workbuddy'));
    assert.equal(appRows(loadConfig()).filter((row) => row.id === 'workbuddy').length, 1);
    assert.equal((await runSync()).exitCode, 0);
    assert.ok(
      fs.existsSync(path.join(homes.agentsHome, '.custom-workbuddy/skills/desktop/SKILL.md'))
    );
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.workbuddy')), false);

    fs.mkdirSync(path.join(homes.agentsHome, '.workbuddy'));
    writeUserConfig(homes, custom('.workbuddy'));
    assert.equal((await runSync()).exitCode, 0);
    writeUserConfig(homes, selection);
    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    assert.ok(
      report.entries
        .filter((entry) => entry.path?.startsWith(path.join(homes.agentsHome, '.workbuddy')))
        .every((entry) => entry.outcome === 'unchanged')
    );
    assert.ok((await runSync()).entries.every((entry) => entry.outcome === 'unchanged'));
  });
});
