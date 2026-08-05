import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import { loadConfig } from '../src/engine/config.js';
import { type LibraryInventory, scanLibrary } from '../src/engine/library.js';
import { readSourceCatalog } from '../src/engine/sources.js';
import {
  installApps,
  readMcpHost,
  type ScratchHomes,
  seedMarketplace,
  seedSource,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Where MCP servers come from. A server is a key inside a document rather than
 * a file, so the scan has to name the document that defines each id, keep one
 * bad definition from taking the rest of the document with it, and give plugin
 * servers ids that cannot collide with the user's own.
 */

function scan(): LibraryInventory {
  return scanLibrary({ plugins: readSourceCatalog(loadConfig()).plugins });
}

/** The library document written as text, so a fixture may be JSONC or broken. */
function writeLibraryDocument(homes: ScratchHomes, content: string): string {
  const filePath = path.join(homes.asbHome, 'mcp.json');
  fs.mkdirSync(homes.asbHome, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function serversOf(inventory: LibraryInventory): string[] {
  return inventory.components.filter((component) => component.type === 'mcp').map((c) => c.id);
}

function selectFor(homes: ScratchHomes, app: string, servers: string[]): void {
  writeUserConfig(
    homes,
    `[applications]\nenabled = ["${app}"]\n\n[mcp]\nenabled = [${servers
      .map((id) => `"${id}"`)
      .join(', ')}]\n`
  );
}

test('the library document is JSONC, and each server names the document that defines it', async () => {
  await withScratchHomes(async (homes) => {
    const document = writeLibraryDocument(
      homes,
      [
        '{',
        '  // the servers this machine offers',
        '  "mcpServers": {',
        '    "alpha": { "command": "npx", "args": ["-y", "alpha"] },',
        '    "beta": { "url": "https://example.com/mcp" }, // trailing comma next',
        '  }',
        '}',
        '',
      ].join('\n')
    );

    const inventory = scan();

    assert.deepEqual(serversOf(inventory), ['alpha', 'beta']);
    assert.deepEqual(inventory.failed, []);
    for (const component of inventory.components) {
      assert.equal(component.path, document);
      assert.equal(component.source, 'library');
    }
  });
});

test('the transport type is inferred once, at load, from the definition', async () => {
  await withScratchHomes(async (homes) => {
    writeLibraryDocument(
      homes,
      JSON.stringify({
        mcpServers: {
          local: { command: 'npx' },
          remote: { url: 'https://example.com/mcp' },
          declared: { url: 'https://example.com/sse', type: 'sse' },
          neither: { note: 'no command and no url' },
        },
      })
    );

    const byId = new Map(scan().components.map((component) => [component.id, component.server]));

    assert.equal(byId.get('local')?.type, 'stdio');
    assert.equal(byId.get('remote')?.type, 'http');
    assert.equal(byId.get('declared')?.type, 'sse', 'a declared type is never overridden');
    assert.equal(byId.get('neither')?.type, undefined, 'nothing to infer from, nothing invented');
  });
});

test('one malformed server fails alone and its neighbours still load', async () => {
  await withScratchHomes(async (homes) => {
    writeLibraryDocument(
      homes,
      JSON.stringify({
        mcpServers: {
          good: { command: 'npx' },
          bad: { command: 'npx', args: 'not-an-array' },
          alsoGood: { command: 'other' },
        },
      })
    );

    const inventory = scan();

    assert.deepEqual(serversOf(inventory), ['alsoGood', 'good']);
    assert.equal(inventory.failed.length, 1);
    assert.equal(inventory.failed[0].id, 'bad');
    assert.match(inventory.failed[0].error, /Failed to parse MCP server "bad"/);
  });
});

/** Document-level outcomes: a reason under the document's own name, or silence. */
const DOCUMENTS: readonly [label: string, content: string, reason: RegExp | null][] = [
  ['unparsable', '{ "mcpServers": }\n', /Failed to parse mcp\.json: invalid JSON at offset/],
  [
    'no server map',
    JSON.stringify({ servers: { alpha: { command: 'npx' } } }),
    /no "mcpServers" object/,
  ],
  ['an empty server map', JSON.stringify({ mcpServers: {} }), null],
];

test('an unreadable document fails once, under its own name', async () => {
  for (const [label, content, reason] of DOCUMENTS) {
    await withScratchHomes(async (homes) => {
      const document = writeLibraryDocument(homes, content);

      const inventory = scan();

      assert.deepEqual(serversOf(inventory), [], label);
      if (reason === null) {
        assert.deepEqual(inventory.failed, [], label);
        return;
      }
      assert.equal(inventory.failed.length, 1, label);
      assert.deepEqual(
        {
          id: inventory.failed[0].id,
          path: inventory.failed[0].path,
          type: inventory.failed[0].type,
        },
        { id: 'mcp.json', path: document, type: 'mcp' },
        label
      );
      assert.match(inventory.failed[0].error, reason, label);
    });
  }
});

test('a plugin contributes its .mcp.json under its own id, wrapped or flat', async () => {
  await withScratchHomes(async (homes) => {
    // Neither source carries a manifest: the servers are the whole plugin.
    seedSource(homes, 'wrapped', {
      '.mcp.json': JSON.stringify({ mcpServers: { alpha: { command: 'npx' } } }),
    });
    seedSource(homes, 'flat', {
      '.mcp.json': JSON.stringify({ beta: { command: 'npx' } }),
    });

    const inventory = scan();

    assert.deepEqual(serversOf(inventory).sort(), ['flat:beta', 'wrapped:alpha']);
    const alpha = inventory.components.find((component) => component.id === 'wrapped:alpha');
    assert.equal(alpha?.source, 'wrapped');
    assert.equal(alpha?.path, path.join(homes.asbHome, 'plugins', 'wrapped', '.mcp.json'));
  });
});

test('the plugin file wins over the manifest field, which only adds new names', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'pack', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'pack',
        mcpServers: {
          alpha: { command: 'from-manifest' },
          gamma: { command: 'manifest-only' },
        },
      }),
      '.mcp.json': JSON.stringify({ mcpServers: { alpha: { command: 'from-file' } } }),
    });
    // A plugin whose servers live in the manifest alone points at that file.
    seedSource(homes, 'solo', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'solo',
        mcpServers: { delta: { command: 'npx' } },
      }),
    });

    const inventory = scan();
    const byId = new Map(inventory.components.map((component) => [component.id, component]));

    assert.deepEqual(serversOf(inventory).sort(), ['pack:alpha', 'pack:gamma', 'solo:delta']);
    assert.equal(byId.get('pack:alpha')?.server?.command, 'from-file');
    assert.equal(byId.get('pack:gamma')?.server?.command, 'manifest-only');
    assert.equal(
      byId.get('solo:delta')?.path,
      path.join(homes.asbHome, 'plugins', 'solo', '.claude-plugin', 'plugin.json')
    );
  });
});

test('a catalogued plugin keeps the plugin@marketplace:server grammar', async () => {
  await withScratchHomes(async (homes) => {
    seedMarketplace(homes, 'shop', 'shop', 'alpha', {
      '.mcp.json': JSON.stringify({ mcpServers: { search: { command: 'npx' } } }),
    });

    assert.deepEqual(serversOf(scan()), ['alpha@shop:search']);
  });
});

test('selecting the bare id takes the user definition, never the plugin one', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    writeLibraryDocument(
      homes,
      JSON.stringify({ mcpServers: { alpha: { command: 'from-library' } } })
    );
    seedSource(homes, 'pack', {
      '.mcp.json': JSON.stringify({ mcpServers: { alpha: { command: 'from-plugin' } } }),
    });
    selectFor(homes, 'cursor', ['alpha']);

    const inventory = scan();
    assert.deepEqual(serversOf(inventory).sort(), ['alpha', 'pack:alpha'], 'two ids, not a clash');
    assert.deepEqual(inventory.duplicates, []);

    await runSync({});

    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}), ['alpha']);
    assert.equal(readMcpHost(homes, 'cursor')?.alpha.command, 'from-library');
  });
});

test('a plugin server is selectable on its own, without installing the plugin', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedSource(homes, 'pack', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'pack' }),
      '.mcp.json': JSON.stringify({ mcpServers: { alpha: { command: 'npx' } } }),
      'rules/style.md': '# Style\n',
    });
    selectFor(homes, 'cursor', ['pack:alpha']);

    await runSync({});

    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}), ['pack-alpha']);
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.cursor', 'rules', 'rules.mdc')),
      false,
      'nothing else from the plugin comes along'
    );
  });
});
