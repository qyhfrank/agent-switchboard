import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { OpencodeAgent } from '../src/agents/opencode.js';

test('opencode adapter writes local and remote servers', () => {
  const prevAgentsHome = process.env.ASB_AGENTS_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-agents-'));
  process.env.ASB_AGENTS_HOME = tmp; // redirect agents home to temp dir
  try {
    const agent = new OpencodeAgent();
    const outPath = agent.configPath();
    const outDir = path.dirname(outPath);
    fs.mkdirSync(outDir, { recursive: true });
    // Seed with unrelated keys to ensure preservation
    fs.writeFileSync(
      outPath,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', agent: { foo: true } }, null, 2)
    );

    agent.applyConfig({
      mcpServers: {
        localS: { command: 'bunx', args: ['pkg'], env: { A: '1' } },
        remoteS: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer X' },
          type: 'http',
        },
      },
    });

    const saved = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    assert.equal(saved.agent.foo, true, 'preserve unrelated sections');
    assert.ok(saved.mcp, 'mcp section exists');

    const local = saved.mcp.localS;
    assert.equal(local.type, 'local');
    assert.deepEqual(local.command, ['bunx', 'pkg']);
    assert.equal(local.enabled, true);
    assert.deepEqual(local.environment, { A: '1' });
    assert.equal(local.url, undefined);

    const remote = saved.mcp.remoteS;
    assert.equal(remote.type, 'remote');
    assert.equal(remote.url, 'https://example.com/mcp');
    assert.equal(remote.enabled, true);
    assert.deepEqual(remote.headers, { Authorization: 'Bearer X' });
    assert.equal(remote.command, undefined);
  } finally {
    process.env.ASB_AGENTS_HOME = prevAgentsHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
