import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { runSync } from '../src/engine/cli.js';
import {
  entryFor,
  installApps,
  type ScratchHomes,
  seedMcpLibrary,
  seedSkill,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/** A user config enabling `apps` and the listed ids of each component type. */
function selectionConfig(
  homes: ScratchHomes,
  apps: readonly string[],
  selection: Record<string, readonly string[]>
): void {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  writeUserConfig(
    homes,
    [
      `[applications]\nenabled = [${list(apps)}]\n`,
      ...Object.entries(selection).map(([type, ids]) => `[${type}]\nenabled = [${list(ids)}]\n`),
    ].join('\n')
  );
}

/** A library agent Codex is willing to run as a role. */
function codexRole(id: string): string {
  return `---\nextras:\n  codex:\n    model: gpt-5\n---\n${id}\n`;
}

function codexConfig(homes: ScratchHomes): string {
  return path.join(homes.agentsHome, '.codex', 'config.toml');
}

function opencodeRoot(homes: ScratchHomes): string {
  return path.join(homes.agentsHome, '.config', 'opencode');
}

test('commands and agents use own-file ownership through write, update, and removal', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, {
      'commands/build.md': 'Build it.\n',
      'agents/reviewer.md': 'Review it.\n',
    });
    selectionConfig(homes, ['claude-code'], { commands: ['build'], agents: ['reviewer'] });

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

    selectionConfig(homes, ['claude-code'], { commands: [], agents: [] });
    const retired = await runSync();
    assert.equal(retired.exitCode, 0, JSON.stringify(retired.entries, null, 2));
    assert.equal(entryFor(retired, { type: 'commands', id: 'build' })?.outcome, 'removed');
    assert.equal(entryFor(retired, { type: 'agents', id: 'reviewer' })?.outcome, 'removed');
    assert.equal(fs.existsSync(commandPath), false);
    assert.equal(fs.existsSync(agentPath), false);

    const later = await runSync();
    assert.equal(entryFor(later, { type: 'commands', id: 'build' }), undefined);
    assert.equal(entryFor(later, { type: 'agents', id: 'reviewer' }), undefined);
  });
});

test('encoded filename collisions fail closed before either component writes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, {
      'commands/pack:ship.md': 'Colon.\n',
      'commands/pack@ship.md': 'At.\n',
    });
    selectionConfig(homes, ['claude-code'], { commands: ['pack:ship', 'pack@ship'] });

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

test('a deselected command edited by hand is reported once and left in place', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, { 'commands/foo.md': '---\ndescription: Foo\n---\nFoo body.\n' });
    selectionConfig(homes, ['claude-code'], { commands: ['foo'] });
    await runSync();

    const target = path.join(homes.agentsHome, '.claude', 'commands', 'foo.md');
    const mine = '---\ndescription: Foo\n---\nMy own wording.\n';
    fs.writeFileSync(target, mine, 'utf-8');

    selectionConfig(homes, ['claude-code'], { commands: [] });
    const report = await runSync();

    const entry = entryFor(report, { type: 'commands', id: 'foo' });
    assert.equal(entry?.outcome, 'left-behind');
    assert.equal(entry?.detail, 'unproven');
    assert.equal(fs.readFileSync(target, 'utf-8'), mine);
    assert.equal(report.exitCode, 0);
  });
});

test('a file whose name matches no library component is never touched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, { 'commands/foo.md': '---\ndescription: Foo\n---\nFoo body.\n' });
    selectionConfig(homes, ['claude-code'], { commands: ['foo'] });
    seedTree(path.join(homes.agentsHome, '.claude', 'commands'), { 'mine.md': 'my own command\n' });

    const report = await runSync();

    const stranger = path.join(homes.agentsHome, '.claude', 'commands', 'mine.md');
    assert.equal(fs.readFileSync(stranger, 'utf-8'), 'my own command\n');
    assert.equal(
      report.entries.some((row) => row.path === stranger),
      false,
      'a name asb does not define is not asb to discuss'
    );
  });
});

test('an occupied target is overwritten in the sync that selects it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedTree(homes.asbHome, { 'commands/build.md': 'Desired.\n' });
    const target = path.join(homes.agentsHome, '.cursor', 'commands', 'build.md');
    seedTree(path.dirname(target), { 'build.md': 'Mine.\n' });
    selectionConfig(homes, ['cursor'], { commands: ['build'] });

    // Selecting `build` asks for the library's build command at the app's
    // command path, so the render lands in one pass rather than after a round
    // of adoption. Editing a distributed copy is not supported; edit the
    // library entry.
    const first = await runSync();
    const written = entryFor(first, { app: 'cursor', type: 'commands' });
    assert.equal(written?.outcome, 'written');
    assert.equal(written?.detail, 'updated');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'Desired.\n');

    const second = await runSync();
    assert.equal(entryFor(second, { app: 'cursor', type: 'commands' })?.outcome, 'unchanged');
  });
});

test('codex agents skip ineligible roles and merge eligible role keys with MCP', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedTree(homes.asbHome, {
      'agents/plain.md': 'Generic.\n',
      'agents/reviewer.md':
        '---\ndescription: Reviews changes\nextras:\n  codex:\n    model: gpt-5\n---\nReview carefully.\n',
    });
    seedMcpLibrary(homes, { alpha: { command: 'npx', args: ['alpha'] } });
    seedTree(homes.agentsHome, {
      '.codex/config.toml': '# keep\nmodel = "gpt-5"\n',
      '.codex/agents/reviewer.toml': 'model = "foreign"\n',
    });
    selectionConfig(homes, ['codex'], { agents: ['plain', 'reviewer'], mcp: ['alpha'] });

    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const plain = entryFor(report, { app: 'codex', type: 'agents', id: 'plain' });
    assert.equal(plain?.outcome, 'skipped');
    assert.equal(plain?.detail, 'no-codex-role');
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.codex', 'agents', 'plain.toml')),
      false
    );
    const role = fs.readFileSync(
      path.join(homes.agentsHome, '.codex', 'agents', 'reviewer.toml'),
      'utf-8'
    );
    assert.match(role, /gpt-5/);
    assert.doesNotMatch(role, /foreign/);

    const text = fs.readFileSync(codexConfig(homes), 'utf-8');
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

test('codex retains owned activation while a selected role cannot be written', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedTree(homes.asbHome, { 'agents/reviewer.md': codexRole('reviewer') });
    selectionConfig(homes, ['codex'], { agents: ['reviewer'] });
    await runSync();

    // A directory in the role file's place: the target exists but cannot be
    // read, so asb refuses to touch it and the role never becomes ready.
    const rolePath = path.join(homes.agentsHome, '.codex', 'agents', 'reviewer.toml');
    fs.rmSync(rolePath);
    fs.mkdirSync(rolePath);

    const report = await runSync();

    assert.equal(entryFor(report, { app: 'codex', id: 'reviewer' })?.outcome, 'blocked');
    const parsed = parseToml(fs.readFileSync(codexConfig(homes), 'utf-8')) as {
      features: { multi_agent: boolean };
    };
    assert.equal(parsed.features.multi_agent, true);
  });
});

test('codex takes its role keys back on deselection and leaves the feature flag', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedTree(homes.asbHome, { 'agents/reviewer.md': codexRole('reviewer') });
    seedTree(homes.agentsHome, { '.codex/config.toml': '# keep\n' });
    selectionConfig(homes, ['codex'], { agents: ['reviewer'] });
    await runSync();

    selectionConfig(homes, ['codex'], { agents: [] });
    await runSync();

    const content = fs.readFileSync(codexConfig(homes), 'utf-8');
    assert.match(content, /^# keep$/m);
    assert.doesNotMatch(content, /\[agents\.reviewer\]/);
    // `multi_agent = true` is what a Codex user running their own roles writes
    // too, so there is nothing in it that says asb put it there.
    assert.match(content, /multi_agent = true/);
  });
});

test('a hand-edited codex role key survives deselection and its neighbour is removed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedTree(homes.asbHome, {
      'agents/reviewer.md': codexRole('reviewer'),
      'agents/planner.md': codexRole('planner'),
    });
    selectionConfig(homes, ['codex'], { agents: ['reviewer', 'planner'] });
    await runSync();

    const configPath = codexConfig(homes);
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, 'utf-8')
        .replace('[agents.reviewer]', '[agents.reviewer]\nmine = true'),
      'utf-8'
    );

    selectionConfig(homes, ['codex'], { agents: [] });
    const report = await runSync();

    const parsed = parseToml(fs.readFileSync(configPath, 'utf-8')) as {
      agents?: Record<string, unknown>;
    };
    assert.ok(parsed.agents?.reviewer, 'the edited role key is the user’s now');
    assert.equal(parsed.agents?.planner, undefined, 'the untouched one is provably asb’s');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
  });
});

test('legacy opencode singular copies are removed only while they still hold the render', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'opencode');
    seedTree(homes.asbHome, {
      'commands/build.md': 'Build.\n',
      'agents/reviewer.md': 'Review.\n',
    });
    seedSkill(homes, 'check');
    seedSkill(homes, 'notes');
    selectionConfig(homes, ['opencode'], {
      commands: ['build'],
      agents: ['reviewer'],
      skills: ['check', 'notes'],
    });
    await runSync();

    const root = opencodeRoot(homes);
    const legacyCommand = path.join(root, 'command', 'build.md');
    seedTree(root, {
      'command/build.md': fs.readFileSync(path.join(root, 'commands', 'build.md'), 'utf-8'),
    });
    const legacySkill = path.join(root, 'skill', 'check');
    fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
    fs.cpSync(path.join(root, 'skills', 'check'), legacySkill, { recursive: true });

    const cleaned = await runSync();
    assert.equal(cleaned.exitCode, 0, JSON.stringify(cleaned.entries, null, 2));
    assert.equal(fs.existsSync(legacyCommand), false);
    assert.equal(fs.existsSync(legacySkill), false);

    const legacyAgent = path.join(root, 'agent', 'reviewer.md');
    seedTree(root, { 'agent/reviewer.md': 'User-edited review.\n' });
    const dirtySkill = path.join(root, 'skill', 'notes');
    fs.cpSync(path.join(root, 'skills', 'notes'), dirtySkill, { recursive: true });
    seedTree(dirtySkill, { 'data.txt': 'user data\n' });

    const unproven = await runSync();
    assert.equal(unproven.exitCode, 0, JSON.stringify(unproven.entries, null, 2));
    assert.equal(fs.existsSync(legacyAgent), true);
    assert.equal(fs.existsSync(path.join(dirtySkill, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(dirtySkill, 'data.txt')), true);
    assert.equal(
      unproven.entries.filter((row) => row.detail === 'unproven').length,
      2,
      JSON.stringify(unproven.entries, null, 2)
    );
  });
});

test('an unscannable legacy opencode directory fails its app', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'opencode');
    seedTree(homes.asbHome, { 'commands/build.md': 'Build.\n' });
    selectionConfig(homes, ['opencode'], { commands: ['build'] });
    seedTree(opencodeRoot(homes), { command: 'not a directory' });

    const report = await runSync({ dryRun: true });

    const scan = report.entries.find(
      (row) => row.app === 'opencode' && row.detail === 'scan-error'
    );
    assert.equal(scan?.outcome, 'failed');
    assert.match(scan?.reason ?? '', /cannot scan legacy command directory/);
    assert.equal(report.exitCode, 1);
  });
});
