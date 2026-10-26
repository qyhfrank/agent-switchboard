import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { runSync } from '../src/engine/cli.js';
import {
  installApps,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const prompt =
  '---\ndescription: Review changes\nargument-hint: <path>\n---\nReview $ARGUMENTS using $1 and $@.\n';

test('pi preserves global instructions and renders prompts and supported MCP transports', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'pi');
    const root = path.join(homes.agentsHome, '.pi', 'agent');
    seedTree(root, {
      'AGENTS.md': '# Personal instructions\n',
      'mcp.json': '{"mcpServers":{"personal":{"command":"keep"}},"other":true}\n',
    });
    seedRule(homes, 'policy.md', 'Check the result.\n');
    seedSkill(homes, 'review');
    seedTree(homes.asbHome, { 'commands/review.md': prompt });
    seedMcpLibrary(homes, {
      local: { command: 'server', args: ['--stdio'], env: { MODE: 'review' }, cwd: '/workspace' },
      'team:remote': {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Accept: 'application/json' },
      },
      events: { type: 'sse', url: 'https://example.com/events' },
    });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["pi"]\n[rules]\nenabled = ["policy"]\n[skills]\nenabled = ["review"]\n[commands]\nenabled = ["review"]\n[mcp]\nenabled = ["local", "team:remote", "events"]\n'
    );
    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(rules, /# Personal instructions/);
    assert.match(rules, /<!-- rules:start -->\nCheck the result\./);
    const command = fs.readFileSync(path.join(root, 'prompts', 'review.md'), 'utf8');
    assert.deepEqual(parseYaml(command.split('---')[1]), {
      description: 'Review changes',
      'argument-hint': '<path>',
    });
    assert.match(command, /Review \$ARGUMENTS using \$1 and \$@\./);
    assert.equal(fs.existsSync(path.join(root, 'commands')), false);
    assert.equal(fs.existsSync(path.join(root, 'skills')), false);
    assert.ok(
      fs.existsSync(path.join(homes.agentsHome, '.agents', 'skills', 'review', 'SKILL.md'))
    );
    const host = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'), 'utf8'));
    assert.deepEqual(host.mcpServers.local, {
      type: 'stdio',
      command: 'server',
      args: ['--stdio'],
      env: { MODE: 'review' },
      cwd: '/workspace',
    });
    assert.deepEqual(host.mcpServers['team-remote'], {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Accept: 'application/json' },
    });
    assert.equal(host.mcpServers.events, undefined);
    assert.deepEqual(host.mcpServers.personal, { command: 'keep' });
    assert.equal(host.other, true);
    assert.ok(
      report.entries.some(
        (entry) =>
          entry.app === 'pi' &&
          entry.id === 'events' &&
          entry.outcome === 'skipped' &&
          entry.detail === 'unsupported'
      )
    );
    assert.equal(
      (await runSync()).entries.some((entry) => entry.outcome === 'written'),
      false
    );
  });
});

test('pi project prompts and MCP stay inside the project while skills can use its own directory', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'pi');
    const project = path.join(homes.root, 'project');
    seedTree(project, {
      '.asb.toml':
        '[commands]\nenabled = ["review"]\n[skills]\nenabled = ["review"]\n[applications.pi.skills]\ndestination = "own"\n[mcp]\nenabled = ["local"]\n',
    });
    seedTree(homes.asbHome, { 'commands/review.md': prompt });
    seedSkill(homes, 'review');
    seedMcpLibrary(homes, { local: { command: 'server' } });
    writeUserConfig(homes, '[applications]\nenabled = ["pi"]\n');
    const report = await runSync({ project });
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries));
    assert.match(
      fs.readFileSync(path.join(project, '.pi', 'prompts', 'review.md'), 'utf8'),
      /\$ARGUMENTS/
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(project, '.pi', 'mcp.json'), 'utf8')).mcpServers.local
        .command,
      'server'
    );
    assert.ok(fs.existsSync(path.join(project, '.pi', 'skills', 'review', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.pi', 'agent', 'prompts')), false);
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.pi', 'agent', 'commands')), false);
  });
});

test('a builtin region replaces whole-file ownership at the same path without retiring its host', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'pi');
    seedRule(homes, 'policy.md', 'Check the result.\n');
    const target = path.join(homes.agentsHome, '.pi', 'agent', 'AGENTS.md');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["custom-reader"]\n[rules]\nenabled = ["policy"]\n[targets.custom-reader]\ndetect = "~/.pi/agent"\n[targets.custom-reader.rules]\nfile_path = "~/.pi/agent/AGENTS.md"\n'
    );
    assert.equal((await runSync()).exitCode, 0);
    writeUserConfig(homes, '[applications]\nenabled = ["pi"]\n[rules]\nenabled = ["policy"]\n');
    assert.equal((await runSync()).exitCode, 0);
    fs.appendFileSync(target, '\n# Personal instructions\n');
    const expected = fs.readFileSync(target, 'utf8');
    for (let run = 0; run < 2; run++) {
      const report = await runSync();
      assert.equal(report.exitCode, 0);
      assert.equal(fs.readFileSync(target, 'utf8'), expected);
      assert.equal(
        report.entries.some((entry) => entry.outcome === 'removed'),
        false
      );
    }
    const stateDir = path.join(homes.stateHome, 'distribution');
    const slices = fs
      .readdirSync(stateDir)
      .flatMap((file) => JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8')).slices);
    assert.deepEqual(
      slices.filter((slice) => slice.path === target).map((slice) => [slice.app, slice.shape]),
      [['pi', 'region']]
    );
    writeUserConfig(homes, '[applications]\nenabled = ["pi"]\n');
    assert.equal((await runSync()).exitCode, 0);
    assert.match(fs.readFileSync(target, 'utf8'), /# Personal instructions/);
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /Check the result/);
  });
});
