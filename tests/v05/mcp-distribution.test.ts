import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../../src/engine/cli.js';
import { type Report, type ReportEntry, renderReport } from '../../src/engine/report.js';
import {
  installApps,
  MCP_APPS,
  type McpAppId,
  mcpHostPath,
  readMcpHost,
  ruleFilePath,
  type ScratchHomes,
  seedMcpLibrary,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * MCP distribution on the engine surface: which document each app gets, in
 * which dialect, and what the run refuses to create.
 *
 * Adapted from 0.4.35 integration cases for per-app paths, name sanitization,
 * and JSON hosts (other top-level keys preserved, a parse error modifies
 * nothing, a non-object root is refused).
 *
 * One expectation is deliberately inverted: 0.4.35 created every host it could
 * reach and wrote an empty server map into it. Reproduced on the 0.4.35 binary
 * with no `[mcp]` section at all, it wrote `{"mcpServers": {}}` into
 * ~/.cursor/mcp.json, ~/.claude.json and ~/.gemini/settings.json and left
 * ~/.codex/config.toml holding a single newline. The design forbids it:
 * "Zero selected MCP servers plan no MCP file anywhere".
 */

const ALPHA = { command: 'npx', args: ['-y', 'alpha'] };

function rowsFor(report: Report, app: string): ReportEntry[] {
  return report.entries.filter((entry) => entry.app === app);
}

function enableAll(homes: ScratchHomes, servers: string[], apps: readonly string[] = MCP_APPS) {
  writeUserConfig(
    homes,
    [
      '[applications]',
      `enabled = [${apps.map((app) => `"${app}"`).join(', ')}]`,
      '',
      '[mcp]',
      `enabled = [${servers.map((id) => `"${id}"`).join(', ')}]`,
      '',
    ].join('\n')
  );
}

test('zero selected servers plan no MCP file anywhere', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, ...MCP_APPS);
    // A definition exists and none of it is selected: 0.4 still created and
    // emptied every host, which is the divergence M8 has to migrate.
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, []);

    const report = await runSync({});

    for (const app of MCP_APPS) {
      assert.equal(
        fs.existsSync(mcpHostPath(homes, app)),
        false,
        `${app} host must not be created`
      );
    }
    assert.deepEqual(
      report.entries.filter((entry) => entry.type === 'mcp'),
      [],
      'an empty desired set produces no MCP rows at all'
    );
  });
});

test('a deselected library still leaves an app-owned host alone once it exists', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    const hostPath = mcpHostPath(homes, 'cursor');
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, '{\n  "mcpServers": {}\n}\n', 'utf-8');
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, [], ['cursor']);

    await runSync({});

    assert.equal(fs.readFileSync(hostPath, 'utf-8'), '{\n  "mcpServers": {}\n}\n');
  });
});

test('one selected server reaches every app in its own dialect', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, ...MCP_APPS);
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { TOKEN_NAME: 'ALPHA_TOKEN' } },
    });
    enableAll(homes, ['alpha']);

    const report = await runSync({});
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));

    // Verbatim apps write the definition as authored, inferred type included.
    for (const app of ['claude-code', 'claude-desktop', 'cursor'] as McpAppId[]) {
      assert.deepEqual(readMcpHost(homes, app)?.alpha, {
        command: 'npx',
        args: ['-y', 'alpha'],
        env: { TOKEN_NAME: 'ALPHA_TOKEN' },
        type: 'stdio',
      });
    }
    assert.deepEqual(readMcpHost(homes, 'gemini')?.alpha, {
      command: 'npx',
      args: ['-y', 'alpha'],
      env: { TOKEN_NAME: 'ALPHA_TOKEN' },
    });
    assert.deepEqual(readMcpHost(homes, 'opencode')?.alpha, {
      type: 'local',
      command: ['npx', '-y', 'alpha'],
      environment: { TOKEN_NAME: 'ALPHA_TOKEN' },
      enabled: true,
    });
    for (const app of ['trae', 'trae-cn'] as McpAppId[]) {
      assert.deepEqual(readMcpHost(homes, app)?.alpha, {
        command: 'npx',
        args: ['-y', 'alpha'],
        env: { TOKEN_NAME: 'ALPHA_TOKEN' },
      });
    }
    assert.deepEqual(readMcpHost(homes, 'codex')?.alpha, {
      command: 'npx',
      args: ['-y', 'alpha'],
      env: { TOKEN_NAME: 'ALPHA_TOKEN' },
    });
    assert.match(
      fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'),
      /\[mcp_servers\.alpha\]\ncommand = "npx"\nargs = \[ "-y", "alpha" \]\nenv\.TOKEN_NAME = "ALPHA_TOKEN"\n/
    );
  });
});

test('a dry run predicts the apply, row for row and byte for byte', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'codex', 'gemini');
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { url: 'https://example.com/mcp' } });
    enableAll(homes, ['alpha', 'beta'], ['cursor', 'codex', 'gemini']);

    const preview = await runSync({ dryRun: true });
    for (const app of ['cursor', 'codex', 'gemini'] as McpAppId[]) {
      assert.equal(fs.existsSync(mcpHostPath(homes, app)), false, 'a preview writes nothing');
    }

    const applied = await runSync({});

    const shape = (report: Report) =>
      report.entries
        .filter((entry) => entry.type === 'mcp')
        .map((entry) => `${entry.app}|${entry.id}|${entry.outcome}|${entry.detail}|${entry.reason}`)
        .sort();
    assert.deepEqual(shape(applied), shape(preview));
    assert.equal(applied.exitCode, preview.exitCode);

    // The preview's own predicted bytes are the bytes that landed.
    for (const app of ['cursor', 'codex', 'gemini'] as McpAppId[]) {
      assert.ok(fs.existsSync(mcpHostPath(homes, app)), `${app} host written`);
    }
  });
});

test('an app that is not installed is skipped and its host is never made', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha'], ['cursor', 'gemini']);

    const report = await runSync({});

    assert.ok(readMcpHost(homes, 'cursor')?.alpha);
    assert.equal(fs.existsSync(mcpHostPath(homes, 'gemini')), false);
    assert.equal(
      rowsFor(report, 'gemini').some((entry) => entry.detail === 'app-not-installed'),
      true
    );
  });
});

test('a shared settings host keeps its other keys, indentation, and comments', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'gemini', 'opencode');
    const gemini = mcpHostPath(homes, 'gemini');
    fs.mkdirSync(path.dirname(gemini), { recursive: true });
    fs.writeFileSync(
      gemini,
      '{\n    "theme": "dark",\n    "telemetry": {\n        "enabled": false\n    }\n}\n',
      'utf-8'
    );
    // 0.4 parsed opencode.jsonc with a comment-aware parser and then wrote it
    // back as plain JSON, losing every comment (quarry R-10).
    const opencode = path.join(homes.agentsHome, '.config', 'opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(opencode), { recursive: true });
    fs.writeFileSync(opencode, '{\n  // my model\n  "model": "anthropic/claude"\n}\n', 'utf-8');

    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha'], ['gemini', 'opencode']);

    await runSync({});

    const geminiContent = fs.readFileSync(gemini, 'utf-8');
    assert.match(geminiContent, /^ {4}"theme": "dark",$/m);
    assert.match(geminiContent, /^ {8}"enabled": false$/m);
    assert.match(geminiContent, /^ {4}"mcpServers"/m, 'the new slice adopts the file indentation');

    const opencodeContent = fs.readFileSync(opencode, 'utf-8');
    assert.match(opencodeContent, /\/\/ my model/);
    assert.match(opencodeContent, /"model": "anthropic\/claude"/);
    assert.deepEqual(readMcpHost(homes, 'opencode')?.alpha, {
      type: 'local',
      command: ['npx', '-y', 'alpha'],
      enabled: true,
    });
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.config', 'opencode', 'opencode.json')),
      false,
      'the jsonc host is the one that is written'
    );
  });
});

test('a host asb cannot parse is reported and left exactly as it is', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'codex');
    const cursor = mcpHostPath(homes, 'cursor');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, '{ "mcpServers": }\n', 'utf-8');
    const codex = mcpHostPath(homes, 'codex');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    fs.writeFileSync(codex, 'this is not = = toml\n', 'utf-8');

    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha'], ['cursor', 'codex']);

    const report = await runSync({});

    assert.equal(fs.readFileSync(cursor, 'utf-8'), '{ "mcpServers": }\n');
    assert.equal(fs.readFileSync(codex, 'utf-8'), 'this is not = = toml\n');
    for (const app of ['cursor', 'codex']) {
      const row = rowsFor(report, app).find((entry) => entry.type === 'mcp');
      assert.equal(row?.outcome, 'failed');
      assert.equal(row?.detail, 'parse-error');
    }
    assert.equal(report.exitCode, 1);
  });
});

test('a host whose root is not an object is refused rather than rebuilt', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    const cursor = mcpHostPath(homes, 'cursor');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, '[1, 2, 3]\n', 'utf-8');
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha'], ['cursor']);

    const report = await runSync({});

    assert.equal(fs.readFileSync(cursor, 'utf-8'), '[1, 2, 3]\n');
    const row = rowsFor(report, 'cursor').find((entry) => entry.type === 'mcp');
    assert.equal(row?.outcome, 'failed');
    assert.match(row?.reason ?? '', /root must be an object/);
  });
});

test('a missing parent directory is created for a host asb may materialize', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'trae');
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha'], ['trae']);

    await runSync({});

    // The Trae host is two levels below its data dir; nothing pre-creates it.
    assert.ok(readMcpHost(homes, 'trae')?.alpha);
  });
});

test('server names are sanitized only for the apps that require it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, ...MCP_APPS);
    seedMcpLibrary(homes, { 'my.server:one': ALPHA });
    enableAll(homes, ['my.server:one']);

    await runSync({});

    for (const app of ['cursor', 'codex', 'trae', 'trae-cn'] as McpAppId[]) {
      assert.deepEqual(Object.keys(readMcpHost(homes, app) ?? {}), ['my-server-one'], app);
    }
    for (const app of ['claude-code', 'claude-desktop', 'gemini', 'opencode'] as McpAppId[]) {
      assert.deepEqual(Object.keys(readMcpHost(homes, app) ?? {}), ['my.server:one'], app);
    }
  });
});

test('an sse server is skipped for codex by name and written everywhere else', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'gemini');
    seedMcpLibrary(homes, { streamer: { type: 'sse', url: 'https://example.com/sse' } });
    enableAll(homes, ['streamer'], ['codex', 'gemini']);

    const report = await runSync({});

    assert.equal(fs.existsSync(mcpHostPath(homes, 'codex')), false, 'nothing to write, no host');
    const skipped = rowsFor(report, 'codex').find((entry) => entry.id === 'streamer');
    assert.equal(skipped?.outcome, 'skipped');
    assert.equal(skipped?.detail, 'unsupported');
    assert.deepEqual(readMcpHost(homes, 'gemini')?.streamer, { url: 'https://example.com/sse' });
  });
});

test('a per-app add enables a server the global selection never listed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'gemini');
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { command: 'beta' } });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["cursor", "gemini"]',
        '',
        '[mcp]',
        'enabled = ["alpha"]',
        '',
        '[applications.cursor.mcp]',
        'add = ["beta"]',
        '',
        '[applications.gemini.mcp]',
        'remove = ["alpha"]',
        '',
      ].join('\n')
    );

    await runSync({});

    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}).sort(), ['alpha', 'beta']);
    assert.equal(fs.existsSync(mcpHostPath(homes, 'gemini')), false);
  });
});

test('a selected server the library does not define reports missing once', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'gemini');
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha', 'ghost'], ['cursor', 'gemini']);

    const report = await runSync({});

    const missing = report.entries.filter(
      (entry) => entry.type === 'mcp' && entry.outcome === 'missing'
    );
    assert.equal(missing.length, 1);
    assert.equal(missing[0].id, 'ghost');
    assert.equal(missing[0].app, null);
    assert.ok(readMcpHost(homes, 'cursor')?.alpha, 'the resolvable server still lands');
  });
});

test('several slices of one host land in a single write', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { command: 'beta' }, gamma: { command: 'gamma' } });
    enableAll(homes, ['alpha', 'beta', 'gamma'], ['cursor']);

    const report = await runSync({});

    const writes = rowsFor(report, 'cursor').filter((entry) => entry.outcome === 'written');
    assert.equal(writes.length, 1, 'one host, one write');
    assert.equal(writes[0].path, mcpHostPath(homes, 'cursor'));
    assert.match(writes[0].reason ?? '', /wrote alpha, beta, gamma/);
    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}), ['alpha', 'beta', 'gamma']);
  });
});

test('a second run with nothing to change writes nothing and says so', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha'], ['cursor', 'codex']);

    await runSync({});
    const before = MCP_APPS.filter((app) => fs.existsSync(mcpHostPath(homes, app))).map((app) => [
      app,
      fs.readFileSync(mcpHostPath(homes, app), 'utf-8'),
      fs.statSync(mcpHostPath(homes, app)).mtimeMs,
    ]);

    const report = await runSync({});

    for (const [app, content] of before as [McpAppId, string][]) {
      assert.equal(fs.readFileSync(mcpHostPath(homes, app), 'utf-8'), content, app);
    }
    assert.equal(
      report.entries.filter((entry) => entry.type === 'mcp' && entry.outcome === 'written').length,
      0
    );
    assert.ok((report.summary.unchanged ?? 0) > 0);
  });
});

test('a server secret never reaches a report line, on any path through the run', async () => {
  await withScratchHomes(async (homes) => {
    const secret = 'invented-placeholder-token-9f3a';
    installApps(homes, 'cursor', 'codex', 'gemini');
    seedMcpLibrary(homes, {
      owned: { command: 'npx', env: { TOKEN: secret } },
      foreign: { command: 'npx', env: { TOKEN: secret } },
    });
    enableAll(homes, ['owned', 'foreign'], ['cursor', 'codex', 'gemini']);
    // A key asb never wrote, holding a different secret: the blocked reason
    // has to describe the collision without quoting either side.
    fs.mkdirSync(path.dirname(mcpHostPath(homes, 'cursor')), { recursive: true });
    fs.writeFileSync(
      mcpHostPath(homes, 'cursor'),
      JSON.stringify({ mcpServers: { foreign: { command: 'theirs', env: { TOKEN: 'theirs' } } } }),
      'utf-8'
    );

    await runSync({});
    // Then drift the owned slice so the conflict reason is generated too.
    const gemini = mcpHostPath(homes, 'gemini');
    const root = JSON.parse(fs.readFileSync(gemini, 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    root.mcpServers.owned.env = { TOKEN: 'edited' };
    fs.writeFileSync(gemini, JSON.stringify(root), 'utf-8');
    const report = await runSync({});

    const outcomes = new Set(report.entries.map((entry) => entry.outcome));
    assert.ok(outcomes.has('blocked') && outcomes.has('conflict'), 'both reason paths ran');
    const text = report.entries
      .map((entry) => `${entry.reason ?? ''} ${entry.detail ?? ''} ${entry.id ?? ''}`)
      .join('\n');
    assert.equal(text.includes(secret), false, 'no reason quotes a server env value');
    assert.equal(renderReport(report).includes(secret), false, 'nor does the rendered report');
    // The value still reaches the target it was meant for.
    assert.deepEqual(readMcpHost(homes, 'codex')?.owned.env, { TOKEN: secret });
  });
});

/**
 * A container key holding something that is not a map of servers. The value
 * asb reads at the server key is `undefined` either way, so without a check
 * the planner takes the create branch and hands an unindexable parent to the
 * JSON writer — one malformed key in a file asb does not own then aborts the
 * whole run. It is the one input class the fail-closed contract missed.
 */
const CONTAINER_CLASSES: readonly [string, string, RegExp][] = [
  ['array', '[ "one", "two" ]', /array/],
  ['empty array', '[]', /array/],
  ['number', '12345', /number/],
  ['null', 'null', /null/],
  ['boolean', 'false', /boolean/],
  ['string', '"nope"', /string/],
];

test('a container key that is not a table of servers fails that host alone', async () => {
  for (const [label, literal, typeName] of CONTAINER_CLASSES) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'cursor', 'gemini');
      seedMcpLibrary(homes, { alpha: ALPHA });
      enableAll(homes, ['alpha'], ['cursor', 'gemini']);
      const host = `{\n  "mcpServers": ${literal}\n}\n`;
      const filePath = mcpHostPath(homes, 'cursor');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, host, 'utf-8');

      const report = await runSync({});

      assert.equal(fs.readFileSync(filePath, 'utf-8'), host, label);
      const [failed] = rowsFor(report, 'cursor');
      assert.equal(failed?.outcome, 'failed', label);
      assert.equal(failed?.detail, 'parse-error', label);
      assert.match(failed?.reason ?? '', /mcpServers/, label);
      assert.match(failed?.reason ?? '', typeName, label);
      // The rest of the run is untouched by one poisoned host.
      assert.deepEqual(readMcpHost(homes, 'gemini')?.alpha, {
        command: 'npx',
        args: ['-y', 'alpha'],
      });
      assert.equal(report.exitCode, 1, label);
    });
  }
});

test("opencode's own container key is checked the same way, on a preview too", async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'opencode');
    seedMcpLibrary(homes, { alpha: ALPHA });
    enableAll(homes, ['alpha'], ['opencode']);
    const host = '{\n  "mcp": [],\n  "theme": "dark"\n}\n';
    const filePath = mcpHostPath(homes, 'opencode');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, host, 'utf-8');

    const preview = await runSync({ dryRun: true });
    assert.equal(rowsFor(preview, 'opencode')[0]?.outcome, 'failed');
    assert.match(rowsFor(preview, 'opencode')[0]?.reason ?? '', /mcp\b/);

    const report = await runSync({});
    assert.equal(fs.readFileSync(filePath, 'utf-8'), host);
    assert.equal(rowsFor(report, 'opencode')[0]?.detail, 'parse-error');
  });
});

test('one poisoned host does not take sync, status and explain down with it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor', 'codex');
    seedRule(homes, 'house.md', '# House rules\nBe kind.\n');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "cursor", "codex"]',
        '',
        '[rules]',
        'enabled = ["house"]',
        '',
        '[mcp]',
        'enabled = ["alpha"]',
        '',
      ].join('\n')
    );
    seedMcpLibrary(homes, { alpha: ALPHA });
    const poisoned = mcpHostPath(homes, 'cursor');
    fs.mkdirSync(path.dirname(poisoned), { recursive: true });
    fs.writeFileSync(poisoned, '{\n  "mcpServers": []\n}\n', 'utf-8');

    const report = await runSync({});

    assert.ok(fs.existsSync(ruleFilePath(homes, 'claude-code')), 'rules still land');
    assert.deepEqual(readMcpHost(homes, 'codex')?.alpha, { command: 'npx', args: ['-y', 'alpha'] });
    assert.ok(readMcpHost(homes, 'claude-code')?.alpha, 'the other JSON host is written');
    const poisonedRow = rowsFor(report, 'cursor').find((entry) => entry.type === 'mcp');
    assert.equal(poisonedRow?.outcome, 'failed');

    // The read-only surfaces answer for every other app instead of aborting.
    const preview = await runSync({ dryRun: true });
    assert.equal(
      preview.entries.some((entry) => entry.app === 'codex'),
      true
    );
    const slices = await runExplain('alpha');
    assert.equal(
      slices.some((slice) => slice.app === 'codex'),
      true
    );
  });
});

test('a corrupt host asb has no MCP work on is never probed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    // Nothing defined, nothing selected, nothing claimed: asb has no business
    // in this document, so it has nothing to say about it either.
    enableAll(homes, [], ['cursor']);
    const filePath = mcpHostPath(homes, 'cursor');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ "mcpServers": {\n', 'utf-8');

    const report = await runSync({});

    assert.deepEqual(
      report.entries.filter((entry) => entry.type === 'mcp'),
      []
    );
    assert.equal(report.exitCode, 0);
  });
});

test('a host that will not parse reports where it broke, never what it holds', async () => {
  const placeholder = 'INVENTED-PLACEHOLDER-9f3a';
  const fixtures: readonly [string, string][] = [
    [
      'syntax error beside an env line',
      [
        '[mcp_servers.private]',
        'command = "my-server"',
        `env.API_TOKEN = "${placeholder}"`,
        'broken here',
        '',
      ].join('\n'),
    ],
    [
      'a key defined twice, once as a sub-table',
      [
        '[mcp_servers.alpha]',
        'command = "npx"',
        `env.API_TOKEN = "${placeholder}"`,
        '',
        '[mcp_servers.alpha.env]',
        `API_TOKEN = "${placeholder}"`,
        '',
      ].join('\n'),
    ],
  ];

  for (const [label, host] of fixtures) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'codex');
      seedMcpLibrary(homes, { alpha: { command: 'npx' } });
      enableAll(homes, ['alpha'], ['codex']);
      const filePath = mcpHostPath(homes, 'codex');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, host, 'utf-8');

      const report = await runSync({});

      const failed = rowsFor(report, 'codex')[0];
      assert.equal(failed?.detail, 'parse-error', label);
      assert.match(failed?.reason ?? '', /row \d+/, label);
      assert.equal(renderReport(report).includes(placeholder), false, label);
      assert.equal(JSON.stringify(report).includes(placeholder), false, `${label} (json)`);
    });
  }
});
