import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../../src/engine/apps.js';
import { runSync } from '../../src/engine/cli.js';
import { loadLedger } from '../../src/engine/ledger.js';
import type { Component } from '../../src/engine/library.js';
import { loadProjectManifest } from '../../src/engine/peer.js';
import {
  installApps,
  seedMcpLibrary,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function entry(type: 'commands' | 'agents', metadata: Record<string, unknown>): Component {
  return {
    type,
    id: 'reviewer',
    source: 'library',
    path: `/library/${type}/reviewer.md`,
    content: 'Review.\n',
    metadata: { tags: [], requires: [], ...metadata },
  };
}

test('traecli is one builtin data row with the snapshot paths and dialects', async () => {
  await withScratchHomes(async (homes) => {
    const row = APP_ROWS.find((candidate) => candidate.id === 'traecli');
    assert.ok(row);
    assert.equal(row.detectDir(homes), path.join(homes.agentsHome, '.trae', 'cli'));
    assert.equal(row.rules?.path(homes), path.join(homes.agentsHome, '.trae', 'AGENTS.md'));
    assert.equal(row.rules?.projectPath?.('/repo'), path.join('/repo', 'AGENTS.md'));
    assert.equal(row.rules?.render('Body.\n'), 'Body.\n');
    assert.equal(row.commands?.dir(homes), path.join(homes.agentsHome, '.trae', 'commands'));
    assert.equal(row.agents?.dir(homes), path.join(homes.agentsHome, '.trae', 'agents'));
    assert.equal(row.mcp?.path(homes), path.join(homes.agentsHome, '.trae', 'traecli.toml'));
    assert.equal(row.mcp?.format, 'toml');
    assert.equal(row.mcp?.rootKey, 'mcp_servers');
    assert.equal(row.mcp?.create, true);
    assert.equal(row.skills, undefined, 'the trae row owns ~/.trae/skills, never traecli');
    assert.equal(row.hooks, undefined);

    assert.match(
      row.commands?.render(
        entry('commands', {
          description: 'Review',
          extras: { traecli: { allowed_tools: ['read', 'write'], argument_hint: '<path>' } },
        })
      ) ?? '',
      /allowed-tools: read,write[\s\S]*argument-hint: <path>/
    );
    const agent = row.agents?.render(
      entry('agents', { extras: { traecli: { allowed_tools: ['read', 'write'] } } })
    );
    assert.match(agent ?? '', /name: reviewer/);
    assert.match(agent ?? '', /allowed_tools/);
  });
});

test('traecli rules sync writes the shared ~/.trae/AGENTS.md without frontmatter', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    seedRule(homes, 'base.md', 'Baseline rules.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["traecli"]\n\n[rules]\nenabled = ["base"]\n'
    );
    await runSync();

    const body = fs.readFileSync(path.join(homes.agentsHome, '.trae', 'AGENTS.md'), 'utf-8');
    assert.match(body, /Baseline rules\./);
    assert.equal(body.startsWith('---'), false, 'rawBody render adds no frontmatter');
  });
});

test('traecli MCP keeps foreign TOML content and records identity keys', async () => {
  await withScratchHomes(async (homes) => {
    const traeDir = path.join(homes.agentsHome, '.trae');
    fs.mkdirSync(path.join(traeDir, 'cli'), { recursive: true });
    const host = path.join(traeDir, 'traecli.toml');
    fs.writeFileSync(
      host,
      '# traecli settings\nmodel = "gpt-5.1"\n\n[mcp_servers.foreign]\ncommand = "theirs"\n'
    );
    seedMcpLibrary(homes, { alpha: { command: 'run' } });
    writeUserConfig(homes, '[applications]\nenabled = ["traecli"]\n\n[mcp]\nenabled = ["alpha"]\n');
    await runSync();

    const raw = fs.readFileSync(host, 'utf-8');
    assert.match(raw, /# traecli settings/);
    const parsed = parseToml(raw) as {
      model?: string;
      mcp_servers?: Record<string, { command?: string }>;
    };
    assert.equal(parsed.model, 'gpt-5.1');
    assert.equal(parsed.mcp_servers?.foreign?.command, 'theirs');
    assert.equal(parsed.mcp_servers?.alpha?.command, 'run');
    const ledger = loadLedger(homes.stateHome);
    assert.deepEqual(ledger.entries.find((record) => record.app === 'traecli')?.keys, [
      'mcp_servers',
      'alpha',
    ]);
  });
});

test('without ~/.trae/cli the traecli row is inert even when ~/.trae exists', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'user_rules'), { recursive: true });
    seedRule(homes, 'base.md', 'Baseline rules.\n');
    seedMcpLibrary(homes, { alpha: { command: 'run' } });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["traecli"]\n\n[rules]\nenabled = ["base"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );
    await runSync();

    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.trae', 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.trae', 'traecli.toml')), false);
  });
});

test('project AGENTS.md keeps one marker writer with codex, gemini, opencode, and traecli', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    const projectReal = fs.realpathSync(project);
    installApps(homes, 'codex', 'gemini', 'opencode');
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    seedRule(homes, 'project.md', '# Shared rule\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "gemini", "opencode", "traecli"]\n\n[rules]\nenabled = ["project"]\n'
    );
    fs.writeFileSync(
      path.join(projectReal, '.asb.toml'),
      '[distribution.project]\nmode = "managed"\ncollision = "warn-skip"\n'
    );
    const agents = path.join(projectReal, 'AGENTS.md');
    fs.writeFileSync(agents, '# User instructions\n');

    const report = await runSync({ project: projectReal });
    const content = fs.readFileSync(agents, 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(content.match(/<!-- asb:rules:start -->/g)?.length, 1);
    assert.equal(content.match(/<!-- asb:rules:end -->/g)?.length, 1);
    assert.match(content, /# Shared rule/);
    assert.match(content, /# User instructions/);
    assert.equal(
      report.entries.filter((entry) => entry.type === 'rules' && entry.path === agents).length,
      1
    );
    const loaded = loadProjectManifest(homes.asbHome, projectReal);
    assert.deepEqual(loaded.manifest.sections.rules['AGENTS.md']?.targetIds, [
      'codex',
      'gemini',
      'opencode',
      'traecli',
    ]);
  });
});
