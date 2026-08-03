import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { runSync } from '../../src/engine/cli.js';
import {
  installApps,
  seedMcpLibrary,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function seed(root: string, relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

test('commands and agents use own-file ownership through write, update, and removal', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seed(homes.asbHome, 'commands/build.md', 'Build it.\n');
    seed(homes.asbHome, 'agents/reviewer.md', 'Review it.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["build"]\n\n[agents]\nenabled = ["reviewer"]\n'
    );

    const first = await runSync();
    const commandPath = path.join(homes.agentsHome, '.claude', 'commands', 'build.md');
    const agentPath = path.join(homes.agentsHome, '.claude', 'agents', 'reviewer.md');
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));
    assert.equal(fs.readFileSync(commandPath, 'utf-8'), '---\n{}\n---\n\nBuild it.\n');
    assert.match(fs.readFileSync(agentPath, 'utf-8'), /name: reviewer[\s\S]*Review it\./);

    const second = await runSync();
    assert.equal(
      second.entries
        .filter((row) => row.type === 'commands' || row.type === 'agents')
        .every((row) => row.outcome === 'unchanged'),
      true
    );

    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = []\n\n[agents]\nenabled = []\n'
    );
    const retired = await runSync();
    assert.equal(retired.exitCode, 0, JSON.stringify(retired.entries, null, 2));
    assert.equal(fs.existsSync(commandPath), false);
    assert.equal(fs.existsSync(agentPath), false);
  });
});

test('encoded filename collisions fail closed before either component writes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seed(homes.asbHome, 'commands/pack:ship.md', 'Colon.\n');
    seed(homes.asbHome, 'commands/pack@ship.md', 'At.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["pack:ship", "pack@ship"]\n'
    );

    const report = await runSync();
    const rows = report.entries.filter(
      (row) => row.app === 'claude-code' && row.type === 'commands'
    );
    assert.equal(report.exitCode, 1);
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ['conflict', 'conflict']
    );
    assert.match(rows[0].reason ?? '', /both map to pack-ship\.md/);
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.claude', 'commands', 'pack-ship.md')),
      false
    );
  });
});

test('codex agents skip ineligible roles and merge eligible role keys with MCP', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seed(homes.asbHome, 'agents/plain.md', 'Generic.\n');
    seed(
      homes.asbHome,
      'agents/reviewer.md',
      '---\ndescription: Reviews changes\nextras:\n  codex:\n    model: gpt-5\n---\nReview carefully.\n'
    );
    seedMcpLibrary(homes, { alpha: { command: 'npx', args: ['alpha'] } });
    const configPath = path.join(homes.agentsHome, '.codex', 'config.toml');
    seed(homes.agentsHome, '.codex/config.toml', '# keep\nmodel = "gpt-5"\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = ["plain", "reviewer"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const plain = report.entries.find(
      (row) => row.app === 'codex' && row.type === 'agents' && row.id === 'plain'
    );
    assert.equal(plain?.outcome, 'skipped');
    assert.equal(plain?.detail, 'no-codex-role');
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.codex', 'agents', 'plain.toml')),
      false
    );
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.codex', 'agents', 'reviewer.toml')),
      true
    );
    const text = fs.readFileSync(configPath, 'utf-8');
    assert.match(text, /^# keep/m);
    const parsed = parseToml(text) as {
      features: { multi_agent: boolean };
      agents: { reviewer: { config_file: string } };
      mcp_servers: { alpha: { command: string } };
    };
    assert.equal(parsed.features.multi_agent, true);
    assert.equal(parsed.agents.reviewer.config_file, 'agents/reviewer.toml');
    assert.equal(parsed.mcp_servers.alpha.command, 'npx');
  });
});

test('an occupied target is overwritten in the sync that selects it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seed(homes.asbHome, 'commands/build.md', 'Desired.\n');
    const target = seed(homes.agentsHome, '.cursor/commands/build.md', 'Mine.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[commands]\nenabled = ["build"]\n'
    );

    // Selecting `build` asks for the library's build command at the app's
    // command path, so the render lands in one pass rather than after a round
    // of adoption. Editing a distributed copy is not supported; edit the
    // library entry.
    const first = await runSync();
    assert.equal(
      first.entries.find((row) => row.app === 'cursor' && row.type === 'commands')?.outcome,
      'written'
    );
    assert.equal(fs.readFileSync(target, 'utf-8'), 'Desired.\n');

    const second = await runSync();
    assert.equal(
      second.entries.find((row) => row.app === 'cursor' && row.type === 'commands')?.outcome,
      'unchanged'
    );
  });
});

test('Codex writes an occupied role file and activates it in the same sync', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seed(
      homes.asbHome,
      'agents/reviewer.md',
      '---\nextras:\n  codex:\n    model: gpt-5\n---\nReview.\n'
    );
    const rolePath = seed(homes.agentsHome, '.codex/agents/reviewer.toml', 'model = "foreign"\n');
    const configPath = seed(homes.agentsHome, '.codex/config.toml', '# keep\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = ["reviewer"]\n'
    );

    const first = await runSync();
    assert.equal(
      first.entries.find((row) => row.app === 'codex' && row.type === 'agents' && row.id !== null)
        ?.outcome,
      'written'
    );
    assert.match(fs.readFileSync(rolePath, 'utf-8'), /gpt-5/);
    const parsed = parseToml(fs.readFileSync(configPath, 'utf-8')) as {
      agents?: Record<string, unknown>;
    };
    assert.ok(parsed.agents, 'the role asb just wrote is activated');
  });
});

test('Codex never adopts a user activation key and leaves it on deselection', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seed(
      homes.asbHome,
      'agents/reviewer.md',
      '---\nextras:\n  codex:\n    model: gpt-5\n---\nReview.\n'
    );
    const configPath = seed(
      homes.agentsHome,
      '.codex/config.toml',
      '# user setting\n[features]\nmulti_agent = true\n'
    );
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = ["reviewer"]\n'
    );

    const first = await runSync();
    assert.equal(
      first.entries.find((row) => row.app === 'codex' && row.type === 'agents' && row.id === null)
        ?.outcome,
      'unchanged'
    );
    const ledger = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8')
    ) as { entries: { app: string; type: string; id: string | null }[] };
    assert.equal(
      ledger.entries.some(
        (entry) => entry.app === 'codex' && entry.type === 'agents' && entry.id === null
      ),
      false
    );

    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = []\n');
    await runSync();
    assert.equal(
      (parseToml(fs.readFileSync(configPath, 'utf-8')) as { features: { multi_agent: boolean } })
        .features.multi_agent,
      true
    );
  });
});

test('Codex retains owned activation while a selected role cannot be written', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seed(
      homes.asbHome,
      'agents/reviewer.md',
      '---\nextras:\n  codex:\n    model: gpt-5\n---\nReview.\n'
    );
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = ["reviewer"]\n'
    );
    await runSync();

    // A directory in the role file's place: the target exists but cannot be
    // read, so asb refuses to touch it and the role never becomes ready.
    const rolePath = path.join(homes.agentsHome, '.codex', 'agents', 'reviewer.toml');
    fs.rmSync(rolePath);
    fs.mkdirSync(rolePath);

    const report = await runSync();
    assert.equal(
      report.entries.find((row) => row.app === 'codex' && row.id === 'reviewer')?.outcome,
      'blocked'
    );
    const parsed = parseToml(
      fs.readFileSync(path.join(homes.agentsHome, '.codex', 'config.toml'), 'utf-8')
    ) as { features: { multi_agent: boolean } };
    assert.equal(parsed.features.multi_agent, true);
  });
});

test('Codex removes its activation scalar and the empty table on true deselection', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seed(
      homes.asbHome,
      'agents/reviewer.md',
      '---\nextras:\n  codex:\n    model: gpt-5\n---\nReview.\n'
    );
    const configPath = seed(homes.agentsHome, '.codex/config.toml', '# keep\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = ["reviewer"]\n'
    );
    await runSync();

    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = []\n');
    await runSync();
    const content = fs.readFileSync(configPath, 'utf-8');
    assert.match(content, /^# keep$/m);
    assert.doesNotMatch(content, /\[features\]|multi_agent/);
  });
});

test('opencode singular cleanup requires rendered identity and stays scan-fatal', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'opencode');
    seed(homes.asbHome, 'commands/build.md', 'Build.\n');
    seed(homes.asbHome, 'agents/reviewer.md', 'Review.\n');
    seed(
      homes.asbHome,
      'skills/check/SKILL.md',
      '---\nname: Check\ndescription: Check\n---\nCheck.\n'
    );
    seed(
      homes.asbHome,
      'skills/notes/SKILL.md',
      '---\nname: Notes\ndescription: Notes\n---\nNotes.\n'
    );
    const root = path.join(homes.agentsHome, '.config', 'opencode');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["opencode"]\n\n[commands]\nenabled = ["build"]\n\n[agents]\nenabled = ["reviewer"]\n\n[skills]\nenabled = ["check", "notes"]\n'
    );
    await runSync();
    const oldCommand = seed(
      root,
      'command/build.md',
      fs.readFileSync(path.join(root, 'commands', 'build.md'), 'utf-8')
    );
    const oldSkill = path.join(root, 'skill', 'check');
    fs.mkdirSync(path.dirname(oldSkill), { recursive: true });
    fs.cpSync(path.join(root, 'skills', 'check'), oldSkill, { recursive: true });

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(oldCommand), false);
    assert.equal(fs.existsSync(oldSkill), false);

    const oldAgent = seed(root, 'agent/reviewer.md', 'User-edited review.\n');
    const dirtySkill = path.join(root, 'skill', 'notes');
    fs.cpSync(path.join(root, 'skills', 'notes'), dirtySkill, { recursive: true });
    seed(dirtySkill, 'data.txt', 'user data\n');
    const unproven = await runSync();
    assert.equal(unproven.exitCode, 0, JSON.stringify(unproven.entries, null, 2));
    assert.equal(fs.existsSync(oldAgent), true);
    assert.equal(fs.existsSync(path.join(dirtySkill, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(dirtySkill, 'data.txt')), true);
    assert.equal(
      unproven.entries.filter((row) => row.detail === 'unproven').length,
      2,
      JSON.stringify(unproven.entries, null, 2)
    );

    fs.rmSync(path.join(root, 'command'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'command'), 'not a directory', 'utf-8');
    const failed = await runSync({ dryRun: true });
    const scan = failed.entries.find(
      (row) => row.app === 'opencode' && row.detail === 'scan-error'
    );
    assert.equal(scan?.outcome, 'failed');
    assert.match(scan?.reason ?? '', /cannot scan legacy command directory/);
  });
});
