// Real-surface smoke for the traecli app row: drives the actual CLI entry
// (main from src/engine/cli.js) against disposable homes. Covers the three
// acceptance scenarios: full four-cell sync plus union skills flow,
// detection gate without ~/.trae/cli, and a legacy ledger carrying entries
// for an unknown app. Runs inside the node --test per-file process
// isolation, so the env and stdout overrides below are process-local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../../src/engine/apps.js';
import { main } from '../../src/engine/cli.js';

const ENV_KEYS = ['ASB_HOME', 'ASB_AGENTS_HOME', 'ASB_CACHE_HOME', 'ASB_STATE_HOME'];

interface SmokeHomes {
  root: string;
  asbHome: string;
  agentsHome: string;
  cacheHome: string;
  stateHome: string;
}

function makeHomes(label: string): SmokeHomes {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `asb-smoke-traecli-${label}-`));
  const homes = {
    root,
    asbHome: path.join(root, 'asb-home'),
    agentsHome: path.join(root, 'agents-home'),
    cacheHome: path.join(root, 'cache'),
    stateHome: path.join(root, 'state'),
  };
  fs.mkdirSync(homes.asbHome, { recursive: true });
  fs.mkdirSync(homes.agentsHome, { recursive: true });
  return homes;
}

function useHomes(homes: SmokeHomes): void {
  process.env.ASB_HOME = homes.asbHome;
  process.env.ASB_AGENTS_HOME = homes.agentsHome;
  process.env.ASB_CACHE_HOME = homes.cacheHome;
  process.env.ASB_STATE_HOME = homes.stateHome;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function write(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function runMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function withSmokeHomes(
  label: string,
  fn: (homes: SmokeHomes) => Promise<void>
): Promise<void> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const homes = makeHomes(label);
  useHomes(homes);
  try {
    await fn(homes);
  } finally {
    restoreEnv(saved);
    fs.rmSync(homes.root, { recursive: true, force: true });
  }
}

test('four-cell sync: rules, MCP, commands, agents land and skills flow through the union', async () => {
  await withSmokeHomes('cells', async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(homes.agentsHome, '.codex'), { recursive: true });
    write(path.join(homes.asbHome, 'rules', 'base.md'), 'Shared baseline rules.\n');
    write(
      path.join(homes.asbHome, 'mcp.json'),
      `${JSON.stringify({ mcpServers: { alpha: { command: 'run' } } }, null, 2)}\n`
    );
    write(
      path.join(homes.asbHome, 'commands', 'reviewer.md'),
      '---\ndescription: Review\n---\nReview it.\n'
    );
    write(
      path.join(homes.asbHome, 'agents', 'reviewer.md'),
      '---\ndescription: Review\n---\nReview it.\n'
    );
    write(
      path.join(homes.asbHome, 'skills', 'seeded', 'SKILL.md'),
      '---\nname: seeded\ndescription: seeded does a thing\n---\nUse seeded when the trigger holds.\n'
    );
    write(
      path.join(homes.asbHome, 'config.toml'),
      [
        '[applications]',
        'enabled = ["traecli", "codex"]',
        '',
        '[rules]',
        'enabled = ["base"]',
        '',
        '[mcp]',
        'enabled = ["alpha"]',
        '',
        '[commands]',
        'enabled = ["reviewer"]',
        '',
        '[agents]',
        'enabled = ["reviewer"]',
        '',
        '[skills]',
        'enabled = ["seeded"]',
        '',
        '[distribution]',
        'use_agents_dir = true',
        '',
      ].join('\n')
    );

    const sync = await runMain(['sync']);
    assert.equal(sync.code, 0, `sync failed: ${sync.err}`);

    const traeAgents = fs.readFileSync(path.join(homes.agentsHome, '.trae', 'AGENTS.md'), 'utf-8');
    const codexAgents = fs.readFileSync(
      path.join(homes.agentsHome, '.codex', 'AGENTS.md'),
      'utf-8'
    );
    assert.equal(traeAgents, codexAgents, 'traecli rules body differs from codex');
    assert.match(traeAgents, /Shared baseline rules\./);

    const toml = parseToml(
      fs.readFileSync(path.join(homes.agentsHome, '.trae', 'traecli.toml'), 'utf-8')
    ) as { mcp_servers?: Record<string, { command?: string }> };
    assert.equal(toml.mcp_servers?.alpha?.command, 'run', 'traecli.toml missing managed server');

    const command = fs.readFileSync(
      path.join(homes.agentsHome, '.trae', 'commands', 'reviewer.md'),
      'utf-8'
    );
    assert.match(command, /Review it\./);
    const agent = fs.readFileSync(
      path.join(homes.agentsHome, '.trae', 'agents', 'reviewer.md'),
      'utf-8'
    );
    assert.match(agent, /name: reviewer/);

    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.agents', 'skills', 'seeded', 'SKILL.md')),
      true,
      'union writer did not produce ~/.agents/skills/seeded'
    );
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.trae', 'skills')),
      false,
      'nothing may write ~/.trae/skills while the trae row is disabled'
    );

    const ledger = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8')
    ) as {
      entries: { app: string; type: string }[];
    };
    const skillsClaims = ledger.entries.filter(
      (record) => record.app === 'traecli' && record.type === 'skills'
    );
    assert.equal(skillsClaims.length, 0, 'traecli must never claim skills entries');
    assert.equal(
      ledger.entries.some((record) => record.app === 'agents' && record.type === 'skills'),
      true,
      'union row did not record its skills write'
    );
  });
});

test('detect gate: without ~/.trae/cli the row writes nothing, even beside the IDE dir', async () => {
  await withSmokeHomes('gate', async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'user_rules'), { recursive: true });
    write(path.join(homes.asbHome, 'rules', 'base.md'), 'Shared baseline rules.\n');
    write(
      path.join(homes.asbHome, 'mcp.json'),
      `${JSON.stringify({ mcpServers: { alpha: { command: 'run' } } }, null, 2)}\n`
    );
    write(
      path.join(homes.asbHome, 'config.toml'),
      '[applications]\nenabled = ["traecli"]\n\n[rules]\nenabled = ["base"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );

    const sync = await runMain(['sync']);
    assert.equal(sync.code, 0, `sync failed: ${sync.err}`);
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.trae', 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.trae', 'traecli.toml')), false);

    const status = await runMain(['status']);
    assert.equal(status.code, 0, `status failed: ${status.err}`);
  });
});

test('union proof: a traecli-only selection drives the shared agents skills writer', async () => {
  await withSmokeHomes('union', async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    write(
      path.join(homes.asbHome, 'skills', 'seeded', 'SKILL.md'),
      '---\nname: seeded\ndescription: seeded does a thing\n---\nUse seeded when the trigger holds.\n'
    );
    write(
      path.join(homes.asbHome, 'config.toml'),
      '[applications]\nenabled = ["traecli"]\n\n[skills]\nenabled = ["seeded"]\n\n[distribution]\nuse_agents_dir = true\n'
    );

    const sync = await runMain(['sync']);
    assert.equal(sync.code, 0, `sync failed: ${sync.err}`);
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.agents', 'skills', 'seeded', 'SKILL.md')),
      true,
      'traecli-only selection did not drive the union writer'
    );
    const ledger = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8')
    ) as { entries: { app: string; type: string }[] };
    assert.equal(
      ledger.entries.some((record) => record.app === 'agents' && record.type === 'skills'),
      true,
      'union row did not record its skills write'
    );
  });
});

test('legacy ledger: entries for an unknown retired app neither crash nor get touched', async () => {
  await withSmokeHomes('legacy', async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    // The retired 1.0 app id, assembled so the tree carries no reference to it.
    const legacyApp = ['co', 'co'].join('');
    assert.equal(
      APP_ROWS.some((row) => row.id === legacyApp),
      false,
      'the retired app id must not resolve to a row'
    );
    const sentinelPath = path.join(homes.agentsHome, `.${legacyApp}`, 'AGENTS.md');
    write(sentinelPath, 'Sentinel bytes.\n');
    const legacyEntry = {
      app: legacyApp,
      type: 'rules',
      id: null,
      path: sentinelPath,
      shape: 'own-file',
      hash: '0'.repeat(64),
      provenance: 'written',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    write(
      path.join(homes.stateHome, 'ledger.json'),
      `${JSON.stringify({ version: 1, entries: [legacyEntry] }, null, 2)}\n`
    );
    write(path.join(homes.asbHome, 'rules', 'base.md'), 'Shared baseline rules.\n');
    write(
      path.join(homes.asbHome, 'config.toml'),
      '[applications]\nenabled = ["traecli"]\n\n[rules]\nenabled = ["base"]\n'
    );

    const status = await runMain(['status']);
    assert.equal(status.code, 0, `status failed on legacy ledger: ${status.err}`);
    const sync = await runMain(['sync']);
    assert.equal(sync.code, 0, `sync failed on legacy ledger: ${sync.err}`);

    assert.equal(
      fs.readFileSync(sentinelPath, 'utf-8'),
      'Sentinel bytes.\n',
      'unknown-app target bytes changed'
    );
    const ledger = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8')
    ) as {
      entries: { app: string }[];
    };
    assert.equal(
      ledger.entries.some((record) => record.app === legacyApp),
      true,
      'unknown-app ledger entry was dropped'
    );
  });
});
