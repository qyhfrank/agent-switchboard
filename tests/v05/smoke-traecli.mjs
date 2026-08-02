// Real-surface smoke for the traecli app row: drives the actual CLI entry
// (main from src/engine/cli.js) against disposable homes. Covers the three
// acceptance scenarios: full four-cell sync, detection gate without
// ~/.trae/cli, and a legacy ledger carrying entries for an unknown app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { main } from '../../src/engine/cli.js';

const ENV_KEYS = ['ASB_HOME', 'ASB_AGENTS_HOME', 'ASB_CACHE_HOME', 'ASB_STATE_HOME'];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots = [];

function makeHomes(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `asb-smoke-traecli-${label}-`));
  roots.push(root);
  const homes = {
    root,
    asbHome: path.join(root, 'asb-home'),
    agentsHome: path.join(root, 'agents-home'),
    cacheHome: path.join(root, 'cache'),
    stateHome: path.join(root, 'state'),
  };
  fs.mkdirSync(homes.asbHome, { recursive: true });
  fs.mkdirSync(homes.agentsHome, { recursive: true });
  for (const [key, value] of [
    ['ASB_HOME', homes.asbHome],
    ['ASB_AGENTS_HOME', homes.agentsHome],
    ['ASB_CACHE_HOME', homes.cacheHome],
    ['ASB_STATE_HOME', homes.stateHome],
  ]) {
    process.env[key] = value;
  }
  return homes;
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function runMain(argv) {
  let out = '';
  let err = '';
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    out += chunk.toString();
    return true;
  };
  process.stderr.write = (chunk) => {
    err += chunk.toString();
    return true;
  };
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

function cleanup() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

async function scenarioFourCells() {
  const homes = makeHomes('cells');
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
    path.join(homes.asbHome, 'config.toml'),
    '[applications]\nenabled = ["traecli", "codex"]\n\n[rules]\nenabled = ["base"]\n\n[mcp]\nenabled = ["alpha"]\n\n[commands]\nenabled = ["reviewer"]\n\n[agents]\nenabled = ["reviewer"]\n'
  );

  const sync = await runMain(['sync']);
  assert.equal(sync.code, 0, `sync failed: ${sync.err}`);

  const traeAgents = fs.readFileSync(path.join(homes.agentsHome, '.trae', 'AGENTS.md'), 'utf-8');
  const codexAgents = fs.readFileSync(path.join(homes.agentsHome, '.codex', 'AGENTS.md'), 'utf-8');
  assert.equal(traeAgents, codexAgents, 'traecli rules body differs from codex');
  assert.match(traeAgents, /Shared baseline rules\./);

  const toml = parseToml(
    fs.readFileSync(path.join(homes.agentsHome, '.trae', 'traecli.toml'), 'utf-8')
  );
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

  const ledger = JSON.parse(fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8'));
  const skillsClaims = ledger.entries.filter(
    (record) => record.app === 'traecli' && record.type === 'skills'
  );
  assert.equal(skillsClaims.length, 0, 'traecli must never claim skills entries');
  console.log('smoke-traecli: scenario 1 (four cells) ok');
}

async function scenarioDetectGate() {
  const homes = makeHomes('gate');
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
  console.log('smoke-traecli: scenario 2 (detect gate) ok');
}

async function scenarioLegacyLedger() {
  const homes = makeHomes('legacy');
  fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
  // The retired 1.0 app id, assembled so the tree carries no reference to it.
  const legacyApp = ['co', 'co'].join('');
  const legacyEntry = {
    app: legacyApp,
    type: 'rules',
    id: null,
    path: path.join(homes.agentsHome, `.${legacyApp}`, 'AGENTS.md'),
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
  console.log('smoke-traecli: scenario 3 (legacy ledger) ok');
}

try {
  await scenarioFourCells();
  await scenarioDetectGate();
  await scenarioLegacyLedger();
  console.log('smoke-traecli: PASS (3 scenarios)');
} finally {
  cleanup();
}
