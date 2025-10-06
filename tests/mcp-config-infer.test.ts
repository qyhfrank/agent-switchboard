import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadMcpConfig, saveMcpConfig } from '../src/config/mcp-config.js';
import { getMcpConfigPath } from '../src/config/paths.js';

test('loadMcpConfig infers enabled and type for missing fields', () => {
  const prevHome = process.env.ASB_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-tests-'));
  process.env.ASB_HOME = tmp; // redirect ~/.agent-switchboard to temp dir
  try {
    const cfgPath = getMcpConfigPath();
    const initial = {
      mcpServers: {
        localS: { command: 'bunx', args: ['pkg'] },
        remoteS: { url: 'http://localhost:1234/mcp' },
      },
    };
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(initial, null, 2));

    const loaded = loadMcpConfig();
    // After load, file should be saved with inferred fields
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

    assert.equal(saved.mcpServers.localS.enabled, true);
    assert.equal(saved.mcpServers.remoteS.enabled, true);
    assert.equal(saved.mcpServers.localS.type, 'stdio');
    assert.equal(saved.mcpServers.remoteS.type, 'http');

    // Round-trip consistency
    saveMcpConfig(loaded);
  } finally {
    process.env.ASB_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
