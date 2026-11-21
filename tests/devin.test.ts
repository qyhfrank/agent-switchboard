import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { runSync } from '../src/engine/cli.js';
import { renderReport } from '../src/engine/report.js';
import {
  type ScratchHomes,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const agent =
  '---\ndescription: Reviews changes\nmodel: opus\ntools: Read, Bash\nextras:\n  devin:\n    model: sonnet\n    allowed-tools: [read, grep]\n---\nReview carefully.\n';

const hook = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash|Write|Edit|MultiEdit|mcp__cc__Bash',
        hooks: [{ type: 'command', command: 'guard', timeout: 5, statusMessage: 'x' }],
      },
      { matcher: '^Bash$', hooks: [{ type: 'command', command: 'strict' }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'remind' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }],
  },
});

function devinRoot(home: string): string {
  return process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'devin')
    : path.join(home, '.config', 'devin');
}

function seedLibrary(homes: ScratchHomes): void {
  seedTree(homes.asbHome, { 'agents/reviewer.md': agent, 'hooks/guard.json': `${hook}\n` });
  seedMcpLibrary(homes, {
    local: { command: 'server', args: ['--stdio'] },
    'team:remote': { type: 'http', url: 'https://example.com/mcp' },
    events: { type: 'sse', url: 'https://example.com/events' },
  });
}

test('devin receives its own rules, agents, hooks and MCP and stops importing Claude Code files', async () => {
  await withScratchHomes(async (homes) => {
    const root = devinRoot(homes.agentsHome);
    seedTree(root, {
      'AGENTS.md': '# Personal instructions\n',
      'config.json': '{\n  // personal\n  "theme_mode": "dark"\n}\n',
    });
    seedRule(homes, 'policy.md', 'Check the result.\n');
    seedSkill(homes, 'review');
    seedLibrary(homes);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["devin"]\n[rules]\nenabled = ["policy"]\n[skills]\nenabled = ["review"]\n[agents]\nenabled = ["reviewer"]\n[hooks]\nenabled = ["guard"]\n[mcp]\nenabled = ["local", "team:remote", "events"]\n'
    );
    const report = await runSync();
    assert.equal(report.exitCode, 0, renderReport(report));

    const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(rules, /# Personal instructions/);
    assert.match(rules, /<!-- rules:start -->\nCheck the result\./);
    assert.ok(
      fs.existsSync(path.join(homes.agentsHome, '.agents', 'skills', 'review', 'SKILL.md'))
    );
    assert.equal(fs.existsSync(path.join(root, 'skills')), false);

    const profile = fs.readFileSync(path.join(root, 'agents', 'reviewer.md'), 'utf8');
    assert.deepEqual(parseYaml(profile.split('---')[1]), {
      name: 'reviewer',
      description: 'Reviews changes',
      model: 'sonnet',
      'allowed-tools': ['read', 'grep'],
    });
    assert.match(profile, /Review carefully\./);

    const configText = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    assert.match(configText, /\/\/ personal/);
    const config = parseJsonc(configText);
    assert.equal(config.theme_mode, 'dark');
    assert.deepEqual(config.read_config_from, { claude: false });
    assert.deepEqual(Object.keys(config.hooks).sort(), ['PreToolUse', 'UserPromptSubmit']);
    assert.deepEqual(config.hooks.PreToolUse, [
      {
        matcher: 'exec|write|edit|apply_patch|mcp__cc__Bash',
        hooks: [{ type: 'command', command: 'guard', timeout: 5 }],
      },
      { matcher: '^exec$', hooks: [{ type: 'command', command: 'strict' }] },
    ]);

    const mcp = JSON.parse(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.local, {
      command: 'server',
      args: ['--stdio'],
      type: 'stdio',
    });
    assert.equal(mcp.mcpServers['team:remote'].transport, 'http');
    assert.equal(mcp.mcpServers.events.transport, 'sse');

    const again = await runSync();
    assert.equal(again.exitCode, 0, renderReport(again));
    assert.equal(
      again.entries.some((entry) => entry.outcome === 'written'),
      false,
      renderReport(again)
    );
  });
});

test('devin keeps a Claude import the user turned on and reports it', async () => {
  await withScratchHomes(async (homes) => {
    const root = devinRoot(homes.agentsHome);
    const original = '{ "read_config_from": { "claude": true } }\n';
    seedTree(root, { 'config.json': original });
    writeUserConfig(homes, '[applications]\nenabled = ["devin"]\n');
    const report = await runSync();
    assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), original);
    const entry = report.entries.find(
      (candidate) => candidate.app === 'devin' && candidate.outcome === 'conflict'
    );
    assert.match(entry?.reason ?? '', /read_config_from\.claude.*Claude Code/);
  });
});

test('devin project cells stay inside the project while the import setting stays at user scope', async () => {
  await withScratchHomes(async (homes) => {
    const root = devinRoot(homes.agentsHome);
    fs.mkdirSync(root, { recursive: true });
    const project = path.join(homes.root, 'project');
    seedTree(project, {
      '.asb.toml':
        '[rules]\nenabled = ["policy"]\n[agents]\nenabled = ["reviewer"]\n[hooks]\nenabled = ["guard"]\n[mcp]\nenabled = ["local"]\n[skills]\nenabled = ["review"]\n[applications.devin.skills]\ndestination = "own"\n',
    });
    seedRule(homes, 'policy.md', 'Check the result.\n');
    seedSkill(homes, 'review');
    seedLibrary(homes);
    writeUserConfig(homes, '[applications]\nenabled = ["devin"]\n');
    const report = await runSync({ project });
    assert.equal(report.exitCode, 0, renderReport(report));
    assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /Check the result\./);
    assert.ok(fs.existsSync(path.join(project, '.devin', 'agents', 'reviewer.md')));
    assert.ok(fs.existsSync(path.join(project, '.devin', 'skills', 'review', 'SKILL.md')));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(project, '.devin', 'mcp_config.json'), 'utf8'))
        .mcpServers.local.command,
      'server'
    );
    const local = JSON.parse(
      fs.readFileSync(path.join(project, '.devin', 'config.local.json'), 'utf8')
    );
    assert.equal(local.hooks.PreToolUse[1].matcher, '^exec$');
    assert.equal(local.read_config_from, undefined);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).read_config_from,
      { claude: false }
    );
  });
});
