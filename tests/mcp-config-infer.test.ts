import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadMcpConfig } from '../src/config/mcp-config.js';
import { getMcpConfigPath } from '../src/config/paths.js';
import { withTempAsbHome } from './helpers/tmp.js';

test('loadMcpConfig infers type for servers', () => {
  withTempAsbHome(() => {
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

    // Type should be inferred from command/url
    assert.equal(loaded.mcpServers.localS.type, 'stdio');
    assert.equal(loaded.mcpServers.remoteS.type, 'http');
  });
});
