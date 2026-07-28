import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import { loadConfig } from '../../src/engine/config.js';
import { type LibraryInventory, scanLibrary } from '../../src/engine/library.js';
import { readSourceCatalog } from '../../src/engine/sources.js';
import {
  installApps,
  readMcpHost,
  type ScratchHomes,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Where MCP servers come from. Unlike every other component type a server is a
 * key inside a document rather than a file, so the library scan has to say
 * which document defines each id, keep one bad definition from taking the rest
 * of the document with it, and give plugin servers ids that cannot collide
 * with the user's own.
 */

function scan(): LibraryInventory {
  return scanLibrary({ plugins: readSourceCatalog(loadConfig()).plugins });
}

function seedTree(root: string, files: Record<string, string>): string {
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return root;
}

function seedSource(homes: ScratchHomes, namespace: string, files: Record<string, string>): string {
  return seedTree(path.join(homes.asbHome, 'plugins', namespace), files);
}

function writeLibraryDocument(homes: ScratchHomes, content: string): string {
  const filePath = path.join(homes.asbHome, 'mcp.json');
  fs.mkdirSync(homes.asbHome, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function serversOf(inventory: LibraryInventory): string[] {
  return inventory.components.filter((c) => c.type === 'mcp').map((c) => c.id);
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
        },
      })
    );

    const byId = new Map(scan().components.map((c) => [c.id, c.server]));

    assert.equal(byId.get('local')?.type, 'stdio');
    assert.equal(byId.get('remote')?.type, 'http');
    assert.equal(byId.get('declared')?.type, 'sse', 'a declared type is never overridden');
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

test('an unreadable document fails once, under its own name', async () => {
  await withScratchHomes(async (homes) => {
    const document = writeLibraryDocument(homes, '{ "mcpServers": { "alpha": }\n');

    const inventory = scan();

    assert.deepEqual(serversOf(inventory), []);
    assert.equal(inventory.failed.length, 1);
    assert.deepEqual(
      {
        id: inventory.failed[0].id,
        path: inventory.failed[0].path,
        type: inventory.failed[0].type,
      },
      { id: 'mcp.json', path: document, type: 'mcp' }
    );
    assert.match(inventory.failed[0].error, /Failed to parse mcp\.json: invalid JSON at offset/);
  });
});

test('a document without an mcpServers object says so instead of loading nothing', async () => {
  await withScratchHomes(async (homes) => {
    writeLibraryDocument(homes, JSON.stringify({ servers: { alpha: { command: 'npx' } } }));

    const inventory = scan();

    assert.deepEqual(serversOf(inventory), []);
    assert.match(inventory.failed[0]?.error ?? '', /no "mcpServers" object/);
  });
});

test('an empty server map is a valid document, not a failure', async () => {
  await withScratchHomes(async (homes) => {
    writeLibraryDocument(homes, JSON.stringify({ mcpServers: {} }));

    const inventory = scan();

    assert.deepEqual(serversOf(inventory), []);
    assert.deepEqual(inventory.failed, []);
  });
});

test('a plugin contributes its .mcp.json under its own id, wrapped or flat', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'wrapped', {
      '.mcp.json': JSON.stringify({ mcpServers: { alpha: { command: 'npx' } } }),
    });
    seedSource(homes, 'flat', {
      '.mcp.json': JSON.stringify({ beta: { command: 'npx' } }),
    });

    const inventory = scan();

    assert.deepEqual(serversOf(inventory).sort(), ['flat:beta', 'wrapped:alpha']);
    const alpha = inventory.components.find((c) => c.id === 'wrapped:alpha');
    assert.equal(alpha?.source, 'wrapped');
    assert.equal(alpha?.path, path.join(homes.asbHome, 'plugins', 'wrapped', '.mcp.json'));
  });
});

test('a bare source with no manifest still contributes its .mcp.json', async () => {
  await withScratchHomes(async (homes) => {
    // 0.4 read the file only for plugins that had a manifest, so a source that
    // was nothing but servers contributed none of them.
    seedSource(homes, 'servers-only', {
      '.mcp.json': JSON.stringify({ mcpServers: { alpha: { command: 'npx' } } }),
    });

    assert.deepEqual(serversOf(scan()), ['servers-only:alpha']);
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

    const inventory = scan();
    const byId = new Map(inventory.components.map((c) => [c.id, c]));

    assert.deepEqual(serversOf(inventory).sort(), ['pack:alpha', 'pack:gamma']);
    assert.equal(byId.get('pack:alpha')?.server?.command, 'from-file');
    assert.equal(byId.get('pack:gamma')?.server?.command, 'manifest-only');
  });
});

test('a manifest-only plugin points its servers at the manifest that defines them', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'pack', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'pack',
        mcpServers: { alpha: { command: 'npx' } },
      }),
    });

    const [alpha] = scan().components;

    assert.equal(alpha.id, 'pack:alpha');
    assert.equal(
      alpha.path,
      path.join(homes.asbHome, 'plugins', 'pack', '.claude-plugin', 'plugin.json')
    );
  });
});

test('a catalogued plugin keeps the name@namespace:server grammar', async () => {
  await withScratchHomes(async (homes) => {
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'shop',
        plugins: [{ name: 'alpha', source: './alpha' }],
      }),
      'alpha/.mcp.json': JSON.stringify({ mcpServers: { search: { command: 'npx' } } }),
    });

    assert.deepEqual(serversOf(scan()), ['alpha@shop:search']);
  });
});

test('a plugin server and a library server of the same name are separate ids', async () => {
  await withScratchHomes(async (homes) => {
    writeLibraryDocument(
      homes,
      JSON.stringify({ mcpServers: { alpha: { command: 'from-library' } } })
    );
    seedSource(homes, 'pack', {
      '.mcp.json': JSON.stringify({ mcpServers: { alpha: { command: 'from-plugin' } } }),
    });

    const inventory = scan();

    assert.deepEqual(serversOf(inventory).sort(), ['alpha', 'pack:alpha']);
    assert.deepEqual(inventory.duplicates, []);
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
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n');

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
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["pack:alpha"]\n'
    );

    await runSync({});

    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}), ['pack-alpha']);
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.cursor', 'rules', 'asb-rules.mdc')),
      false,
      'nothing else from the plugin comes along'
    );
  });
});

test('an enabled id no library or plugin defines is reported missing, once', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'gemini');
    writeLibraryDocument(homes, JSON.stringify({ mcpServers: {} }));
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["cursor", "gemini"]\n\n[mcp]\nenabled = ["ghost"]\n'
    );

    const report = await runSync({});

    const missing = report.entries.filter((entry) => entry.outcome === 'missing');
    assert.equal(missing.length, 1, 'one row for the id, not one per app');
    assert.equal(missing[0].id, 'ghost');
    assert.match(missing[0].reason ?? '', /mcp\.json/);
    assert.equal(report.exitCode, 1);
  });
});

test('a server that fails to load is reported, not silently dropped', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    writeLibraryDocument(
      homes,
      JSON.stringify({ mcpServers: { bad: { command: 'npx', args: 'not-an-array' } } })
    );
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["bad"]\n');

    const report = await runSync({});

    const failed = report.entries.find((entry) => entry.type === 'mcp' && entry.id === 'bad');
    assert.equal(failed?.outcome, 'failed');
    assert.equal(fs.existsSync(path.join(homes.agentsHome, '.cursor', 'mcp.json')), false);
    assert.equal(report.exitCode, 1);
  });
});
