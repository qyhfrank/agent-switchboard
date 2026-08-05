import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../src/engine/apps.js';
import { runExplain, runSync } from '../src/engine/cli.js';
import { type Action, groupKeyActions } from '../src/engine/plan.js';
import {
  type Report,
  type ReportEntry,
  renderExplain,
  renderReport,
} from '../src/engine/report.js';
import { applyKeysEdits } from '../src/engine/shapes.js';
import {
  detectDir,
  entryFor,
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
 * MCP on disk: which document each app gets, in which dialect, what the run
 * refuses to create, and what it may overwrite or reclaim once a key is there.
 *
 * A managed key holds asb's whole render, so a write replaces the value
 * wholesale and safety comes from identity: a key whose value is not the
 * render belongs to whoever wrote it, and asb leaves it alone rather than
 * merging around it or resetting the container it lives in.
 */

const ALPHA = { command: 'npx', args: ['-y', 'alpha'] };

function selection(homes: ScratchHomes, apps: readonly string[], servers: readonly string[]): void {
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

function seedHost(homes: ScratchHomes, app: McpAppId, content: string): string {
  const filePath = mcpHostPath(homes, app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function mcpRows(report: Report, app?: string): ReportEntry[] {
  return report.entries.filter(
    (entry) => entry.type === 'mcp' && (app === undefined || entry.app === app)
  );
}

test('zero selected servers plan no MCP file anywhere', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, ...MCP_APPS);
    // A definition exists and none of it is selected.
    seedMcpLibrary(homes, { alpha: ALPHA });
    const existing = '{\n  "mcpServers": {}\n}\n';
    seedHost(homes, 'cursor', existing);
    selection(homes, MCP_APPS, []);

    const report = await runSync({});

    for (const app of MCP_APPS.filter((candidate) => candidate !== 'cursor')) {
      assert.equal(
        fs.existsSync(mcpHostPath(homes, app)),
        false,
        `${app} host must not be created`
      );
    }
    assert.equal(fs.readFileSync(mcpHostPath(homes, 'cursor'), 'utf-8'), existing);
    assert.deepEqual(mcpRows(report), [], 'an empty desired set produces no MCP rows at all');
    assert.equal(report.exitCode, 0);
  });

  await withScratchHomes(async (homes) => {
    // Nothing defined, nothing selected, nothing claimed: asb has no business
    // in this document, so it has nothing to say about it either.
    installApps(homes, 'cursor');
    selection(homes, ['cursor'], []);
    const corrupt = '{ "mcpServers": {\n';
    seedHost(homes, 'cursor', corrupt);

    const report = await runSync({});

    assert.deepEqual(mcpRows(report), []);
    assert.equal(report.exitCode, 0);
    assert.equal(fs.readFileSync(mcpHostPath(homes, 'cursor'), 'utf-8'), corrupt);
  });
});

test('one selected server reaches every app in its own dialect', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, ...MCP_APPS);
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { TOKEN_NAME: 'ALPHA_TOKEN' } },
    });
    selection(homes, MCP_APPS, ['alpha']);

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
    // Trae carries no type at all, and its host is two levels below the data
    // directory: nothing pre-creates that parent.
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
    const apps: McpAppId[] = ['cursor', 'codex', 'gemini'];
    installApps(homes, ...apps);
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { url: 'https://example.com/mcp' } });
    selection(homes, apps, ['alpha', 'beta']);

    const preview = await runSync({ dryRun: true });
    for (const app of apps) {
      assert.equal(fs.existsSync(mcpHostPath(homes, app)), false, 'a preview writes nothing');
    }

    const applied = await runSync({});

    const shape = (report: Report): string[] =>
      mcpRows(report)
        .map((entry) => `${entry.app}|${entry.id}|${entry.outcome}|${entry.detail}|${entry.reason}`)
        .sort();
    assert.deepEqual(shape(applied), shape(preview));
    assert.equal(applied.exitCode, preview.exitCode);

    // What the preview planned is what the bytes now hold: the next preview
    // compares its own render against the file and finds nothing to do.
    const bytes = apps.map((app) => fs.readFileSync(mcpHostPath(homes, app), 'utf-8'));
    const repeat = await runSync({ dryRun: true });
    assert.deepEqual(
      [...new Set(mcpRows(repeat).map((entry) => entry.outcome))],
      ['unchanged'],
      JSON.stringify(repeat.entries, null, 2)
    );
    assert.equal(mcpRows(repeat).length, apps.length * 2, 'one row per server per app');
    apps.forEach((app, index) => {
      assert.equal(fs.readFileSync(mcpHostPath(homes, app), 'utf-8'), bytes[index], app);
    });
  });
});

test('an app that is not installed is skipped and its host is never made', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    selection(homes, ['cursor', 'gemini'], ['alpha']);

    const report = await runSync({});

    assert.ok(readMcpHost(homes, 'cursor')?.alpha);
    assert.equal(fs.existsSync(mcpHostPath(homes, 'gemini')), false);
    assert.equal(
      report.entries
        .filter((entry) => entry.app === 'gemini')
        .some((entry) => entry.detail === 'app-not-installed'),
      true
    );
  });
});

test('a shared settings host keeps its other keys, indentation, and comments', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'gemini', 'opencode');
    const gemini = seedHost(
      homes,
      'gemini',
      '{\n    "theme": "dark",\n    "telemetry": {\n        "enabled": false\n    }\n}\n'
    );
    // A comment-aware read that writes back plain JSON loses every comment.
    const opencode = path.join(homes.agentsHome, '.config', 'opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(opencode), { recursive: true });
    fs.writeFileSync(opencode, '{\n  // my model\n  "model": "anthropic/claude"\n}\n', 'utf-8');

    seedMcpLibrary(homes, { alpha: ALPHA });
    selection(homes, ['gemini', 'opencode'], ['alpha']);

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
    installApps(homes, 'cursor', 'codex', 'claude-code', 'gemini');
    const malformed: [McpAppId, string][] = [
      ['cursor', '{ "mcpServers": }\n'],
      ['codex', 'this is not = = toml\n'],
      ['claude-code', '[1, 2, 3]\n'],
    ];
    for (const [app, content] of malformed) seedHost(homes, app, content);
    // An empty document is not malformed: there is simply nothing in it yet.
    seedHost(homes, 'gemini', '');

    seedMcpLibrary(homes, { alpha: ALPHA });
    selection(homes, ['cursor', 'codex', 'claude-code', 'gemini'], ['alpha']);

    const report = await runSync({});

    for (const [app, content] of malformed) {
      assert.equal(fs.readFileSync(mcpHostPath(homes, app), 'utf-8'), content, app);
      const row = entryFor(report, { app, type: 'mcp' });
      assert.equal(row?.outcome, 'failed', app);
    }
    assert.equal(entryFor(report, { app: 'cursor', type: 'mcp' })?.detail, 'parse-error');
    assert.equal(entryFor(report, { app: 'codex', type: 'mcp' })?.detail, 'parse-error');
    assert.match(
      entryFor(report, { app: 'claude-code', type: 'mcp' })?.reason ?? '',
      /root must be an object/
    );
    assert.ok(readMcpHost(homes, 'gemini')?.alpha, 'the empty document takes the server');
    assert.equal(report.exitCode, 1);
  });
});

test('server names are sanitized only for the apps that require it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, ...MCP_APPS);
    seedMcpLibrary(homes, { 'my.server:one/two': ALPHA, plain: { command: 'plain' } });
    selection(homes, MCP_APPS, ['my.server:one/two', 'plain']);

    await runSync({});

    for (const app of ['cursor', 'codex', 'trae', 'trae-cn'] as McpAppId[]) {
      assert.deepEqual(
        Object.keys(readMcpHost(homes, app) ?? {}).sort(),
        ['my-server-one-two', 'plain'],
        app
      );
    }
    for (const app of ['claude-code', 'claude-desktop', 'gemini', 'opencode'] as McpAppId[]) {
      assert.deepEqual(
        Object.keys(readMcpHost(homes, app) ?? {}).sort(),
        ['my.server:one/two', 'plain'],
        app
      );
    }
  });
});

test('an sse server is skipped for codex by name and written everywhere else', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'gemini');
    seedMcpLibrary(homes, { streamer: { type: 'sse', url: 'https://example.com/sse' } });
    selection(homes, ['codex', 'gemini'], ['streamer']);

    const report = await runSync({});

    assert.equal(fs.existsSync(mcpHostPath(homes, 'codex')), false, 'nothing to write, no host');
    const skipped = entryFor(report, { app: 'codex', id: 'streamer' });
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
    selection(homes, ['cursor', 'gemini'], ['alpha', 'ghost']);

    const report = await runSync({});

    const missing = mcpRows(report).filter((entry) => entry.outcome === 'missing');
    assert.equal(missing.length, 1, 'one row for the id, not one per app');
    assert.equal(missing[0].id, 'ghost');
    assert.equal(missing[0].app, null);
    assert.match(missing[0].reason ?? '', /mcp\.json/);
    assert.equal(report.exitCode, 1);
    assert.ok(readMcpHost(homes, 'cursor')?.alpha, 'the resolvable server still lands');
  });
});

test('a server that fails to load is reported, not silently dropped', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { bad: { command: 'npx', args: 'not-an-array' } });
    selection(homes, ['cursor'], ['bad']);

    const report = await runSync({});

    assert.equal(entryFor(report, { type: 'mcp', id: 'bad' })?.outcome, 'failed');
    assert.equal(fs.existsSync(mcpHostPath(homes, 'cursor')), false);
    assert.equal(report.exitCode, 1);
  });
});

test('several slices of one host land in a single write', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { command: 'beta' }, gamma: { command: 'gamma' } });
    selection(homes, ['cursor'], ['alpha', 'beta', 'gamma']);

    const report = await runSync({});

    const writes = mcpRows(report, 'cursor').filter((entry) => entry.outcome === 'written');
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
    selection(homes, ['cursor', 'codex'], ['alpha']);

    await runSync({});
    const before = (['cursor', 'codex'] as McpAppId[]).map(
      (app) => [app, fs.readFileSync(mcpHostPath(homes, app), 'utf-8')] as const
    );

    const report = await runSync({});

    for (const [app, content] of before) {
      assert.equal(fs.readFileSync(mcpHostPath(homes, app), 'utf-8'), content, app);
    }
    assert.equal(mcpRows(report).filter((entry) => entry.outcome === 'written').length, 0);
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
    selection(homes, ['cursor', 'codex', 'gemini'], ['owned', 'foreign']);
    // A key holding a different secret under a name the library also uses: the
    // write that replaces it may not quote either side.
    seedHost(
      homes,
      'cursor',
      JSON.stringify({ mcpServers: { foreign: { command: 'theirs', env: { TOKEN: 'theirs' } } } })
    );

    await runSync({});
    // Then customize one server and drop it, so the left-behind reason runs too.
    const gemini = mcpHostPath(homes, 'gemini');
    const root = JSON.parse(fs.readFileSync(gemini, 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    root.mcpServers.owned.env = { TOKEN: 'edited' };
    fs.writeFileSync(gemini, JSON.stringify(root), 'utf-8');
    selection(homes, ['cursor', 'codex', 'gemini'], ['foreign']);
    const report = await runSync({});

    const outcomes = new Set(report.entries.map((entry) => entry.outcome));
    assert.ok(outcomes.has('written') && outcomes.has('left-behind'), 'both reason paths ran');
    const text = report.entries
      .map((entry) => `${entry.reason ?? ''} ${entry.detail ?? ''} ${entry.id ?? ''}`)
      .join('\n');
    assert.equal(text.includes(secret), false, 'no reason quotes a server env value');
    assert.equal(renderReport(report).includes(secret), false, 'nor does the rendered report');
    // The value still reaches the target it was meant for.
    assert.deepEqual(readMcpHost(homes, 'codex')?.foreign.env, { TOKEN: secret });
  });
});

/**
 * A container key holding something that is not a map of servers. The value
 * asb reads at the server key is `undefined` either way, so without a check
 * the planner takes the create branch and hands an unindexable parent to the
 * writer: one malformed key in a file asb does not own would then abort the
 * whole run.
 */
const CONTAINER_CLASSES: readonly [
  label: string,
  app: McpAppId,
  literal: string,
  container: RegExp,
  typeName: RegExp,
][] = [
  ['array', 'cursor', '[ "one", "two" ]', /mcpServers/, /array/],
  ['empty array', 'cursor', '[]', /mcpServers/, /array/],
  ['number', 'cursor', '12345', /mcpServers/, /number/],
  ['null', 'cursor', 'null', /mcpServers/, /null/],
  ['boolean', 'cursor', 'false', /mcpServers/, /boolean/],
  ['string', 'cursor', '"nope"', /mcpServers/, /string/],
  ['opencode array', 'opencode', '[]', /mcp\b/, /array/],
];

test('a container key that is not a table of servers fails that host alone', async () => {
  for (const [label, app, literal, container, typeName] of CONTAINER_CLASSES) {
    await withScratchHomes(async (homes) => {
      installApps(homes, app, 'gemini');
      seedMcpLibrary(homes, { alpha: ALPHA });
      selection(homes, [app, 'gemini'], ['alpha']);
      const key = app === 'opencode' ? 'mcp' : 'mcpServers';
      const host = `{\n  "${key}": ${literal}\n}\n`;
      const filePath = seedHost(homes, app, host);

      // The preview reports it before any apply, and the apply changes nothing.
      const preview = await runSync({ dryRun: true });
      assert.equal(mcpRows(preview, app)[0]?.outcome, 'failed', label);

      const report = await runSync({});

      assert.equal(fs.readFileSync(filePath, 'utf-8'), host, label);
      const failed = mcpRows(report, app)[0];
      assert.equal(failed?.outcome, 'failed', label);
      assert.equal(failed?.detail, 'parse-error', label);
      assert.match(failed?.reason ?? '', container, label);
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
    seedHost(homes, 'cursor', '{\n  "mcpServers": []\n}\n');

    const report = await runSync({});

    assert.ok(fs.existsSync(ruleFilePath(homes, 'claude-code')), 'rules still land');
    assert.deepEqual(readMcpHost(homes, 'codex')?.alpha, { command: 'npx', args: ['-y', 'alpha'] });
    assert.ok(readMcpHost(homes, 'claude-code')?.alpha, 'the other JSON host is written');
    assert.equal(entryFor(report, { app: 'cursor', type: 'mcp' })?.outcome, 'failed');

    // The read-only surfaces answer for every other app instead of aborting.
    const preview = await runSync({ dryRun: true });
    assert.ok(preview.entries.some((entry) => entry.app === 'codex'));
    const { slices } = await runExplain('alpha');
    assert.ok(slices.some((slice) => slice.app === 'codex'));
  });
});

test('a host that will not parse reports where it broke, never what it holds', async () => {
  const placeholder = 'INVENTED-PLACEHOLDER-9f3a';
  const fixtures: readonly [label: string, host: string][] = [
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
      selection(homes, ['codex'], ['alpha']);
      seedHost(homes, 'codex', host);

      const report = await runSync({});

      const failed = mcpRows(report, 'codex')[0];
      assert.equal(failed?.detail, 'parse-error', label);
      assert.match(failed?.reason ?? '', /row \d+/, label);
      assert.equal(renderReport(report).includes(placeholder), false, label);
      assert.equal(JSON.stringify(report).includes(placeholder), false, `${label} (json)`);
    });
  }
});

test('selecting a server puts the library definition at its key, and nothing else', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    const host = seedHost(
      homes,
      'cursor',
      '{\n  "mcpServers": {\n    "alpha": { "command": "mine", "args": ["hand-written"] },\n    "theirs": { "command": "theirs" }\n  }\n}\n'
    );
    seedMcpLibrary(homes, { alpha: ALPHA });
    selection(homes, ['cursor'], ['alpha']);

    const first = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, {
      command: 'npx',
      args: ['-y', 'alpha'],
      type: 'stdio',
    });
    assert.deepEqual(readMcpHost(homes, 'cursor')?.theirs, { command: 'theirs' });
    assert.equal(first.exitCode, 0);
    assert.ok(fs.readFileSync(host, 'utf-8').includes('theirs'));

    // Selecting a server asks for the library's definition at that key, so a
    // later hand edit loses to it rather than deadlocking the run.
    const edited = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    edited.mcpServers.alpha.args = ['-y', 'edited-by-hand'];
    fs.writeFileSync(host, `${JSON.stringify(edited, null, 2)}\n`, 'utf-8');
    seedMcpLibrary(homes, { alpha: { command: 'npx', args: ['-y', 'alpha', '--new'] } });

    const second = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha.args, ['-y', 'alpha', '--new']);
    assert.equal(second.exitCode, 0);
    // One pass is enough: the run after it has nothing left to reconcile.
    const third = await runSync({});
    assert.equal(entryFor(third, { type: 'mcp', id: 'alpha' })?.outcome, 'unchanged');
  });
});

test('a key already holding asb’s own render needs no write', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    selection(homes, ['cursor'], ['alpha']);
    // Hand-seeded, with no prior run to consult: identity is the whole proof.
    const host = seedHost(
      homes,
      'cursor',
      `${JSON.stringify(
        { mcpServers: { alpha: { command: 'npx', args: ['-y', 'alpha'], type: 'stdio' } } },
        null,
        2
      )}\n`
    );
    const bytes = fs.readFileSync(host, 'utf-8');

    const report = await runSync({});

    assert.equal(entryFor(report, { type: 'mcp', id: 'alpha' })?.outcome, 'unchanged');
    assert.equal(fs.readFileSync(host, 'utf-8'), bytes, 'the host is not rewritten');
  });
});

/** One JSON host and one TOML host, each carrying content asb did not write. */
const OWNED_HOSTS: readonly {
  app: string;
  install(homes: ScratchHomes): void;
  host(homes: ScratchHomes): string;
  parse(raw: string): Record<string, unknown>;
  rootKey: string;
  foreign: string;
  keep: [key: string, value: unknown];
  seed: string;
  /** Bytes only the raw document can prove kept. */
  keepsText?: string;
}[] = [
  {
    app: 'cursor',
    install: (homes) => installApps(homes, 'cursor'),
    host: (homes) => mcpHostPath(homes, 'cursor'),
    parse: (raw) => JSON.parse(raw) as Record<string, unknown>,
    rootKey: 'mcpServers',
    foreign: 'theirs',
    keep: ['otherSetting', true],
    seed: '{\n  "mcpServers": {\n    "theirs": { "command": "theirs" }\n  },\n  "otherSetting": true\n}\n',
  },
  {
    app: 'traecli',
    install: (homes) =>
      fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true }),
    host: (homes) => path.join(homes.agentsHome, '.trae', 'traecli.toml'),
    parse: (raw) => parseToml(raw) as Record<string, unknown>,
    rootKey: 'mcp_servers',
    foreign: 'foreign',
    keep: ['model', 'their-model'],
    seed: '# hand written\nmodel = "their-model"\n\n[mcp_servers.foreign]\ncommand = "theirs"\n',
    keepsText: '# hand written',
  },
];

test('foreign servers beside an owned key survive every write and every removal', async () => {
  for (const fixture of OWNED_HOSTS) {
    await withScratchHomes(async (homes) => {
      fixture.install(homes);
      const host = fixture.host(homes);
      fs.mkdirSync(path.dirname(host), { recursive: true });
      fs.writeFileSync(host, fixture.seed, 'utf-8');
      const root = (): Record<string, unknown> => fixture.parse(fs.readFileSync(host, 'utf-8'));
      const servers = (): Record<string, Record<string, unknown>> =>
        (root()[fixture.rootKey] ?? {}) as Record<string, Record<string, unknown>>;

      seedMcpLibrary(homes, { alpha: ALPHA });
      selection(homes, [fixture.app], ['alpha']);
      await runSync({});

      assert.deepEqual(Object.keys(servers()).sort(), ['alpha', fixture.foreign], fixture.app);
      assert.equal(root()[fixture.keep[0]], fixture.keep[1], fixture.app);

      // Retiring the key is an edit, so it rides the host's one grouped write,
      // and nothing but that key goes with it.
      selection(homes, [fixture.app], []);
      const report = await runSync({});

      assert.deepEqual(Object.keys(servers()), [fixture.foreign], fixture.app);
      assert.deepEqual(servers()[fixture.foreign], { command: 'theirs' }, fixture.app);
      assert.equal(root()[fixture.keep[0]], fixture.keep[1], fixture.app);
      const write = mcpRows(report).find((entry) => entry.outcome === 'written');
      assert.equal(write?.reason, 'retired alpha', fixture.app);
      if (fixture.keepsText !== undefined) {
        assert.ok(fs.readFileSync(host, 'utf-8').includes(fixture.keepsText), fixture.app);
      }
    });
  }
});

test('an update replaces the owned value wholesale, so a stale sub-key goes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'trae');
    seedMcpLibrary(homes, { alpha: { command: 'first', args: ['a'], env: { KEY: 'value' } } });
    selection(homes, ['cursor', 'trae'], ['alpha']);
    await runSync({});
    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, {
      command: 'first',
      args: ['a'],
      env: { KEY: 'value' },
      type: 'stdio',
    });

    // A field merge would leave `args` and `env` running under the new command.
    seedMcpLibrary(homes, { alpha: { command: 'second' } });
    const report = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, { command: 'second', type: 'stdio' });
    assert.deepEqual(readMcpHost(homes, 'trae')?.alpha, { command: 'second' });
    assert.match(mcpRows(report)[0]?.reason ?? '', /wrote alpha/);
  });
});

test('a deselected slice whose command was changed is left alone and not named', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { command: 'beta' }, gamma: { command: 'gamma' } });
    selection(homes, ['cursor'], ['alpha', 'beta']);
    await runSync({});

    const host = mcpHostPath(homes, 'cursor');
    const edited = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    // A key running a different program, a key already gone, and a key nothing
    // ever selected: three names asb has no claim on.
    edited.mcpServers.alpha.command = 'user-edited';
    delete edited.mcpServers.beta;
    edited.mcpServers.gamma = { command: 'hand-written gamma' };
    const bytes = `${JSON.stringify(edited, null, 2)}\n`;
    fs.writeFileSync(host, bytes, 'utf-8');

    selection(homes, ['cursor'], []);
    const report = await runSync({});

    assert.deepEqual(mcpRows(report), [], JSON.stringify(report.entries, null, 2));
    assert.equal(report.exitCode, 0);
    assert.equal(fs.readFileSync(host, 'utf-8'), bytes, 'not a byte of the host is touched');
  });
});

test('two ids that sanitize to one key fail that app rather than take turns', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'gemini');
    seedMcpLibrary(homes, { 'foo:bar': ALPHA, 'foo-bar': { command: 'other' } });
    selection(homes, ['cursor', 'gemini'], ['foo:bar', 'foo-bar']);

    const report = await runSync({});

    assert.equal(fs.existsSync(mcpHostPath(homes, 'cursor')), false);
    const failed = report.entries.find(
      (entry) => entry.app === 'cursor' && entry.outcome === 'failed'
    );
    assert.equal(failed?.detail, 'render-error');
    assert.match(failed?.reason ?? '', /both become "foo-bar"/);
    // gemini does not sanitize, so the same pair is fine there.
    assert.deepEqual(Object.keys(readMcpHost(homes, 'gemini') ?? {}).sort(), [
      'foo-bar',
      'foo:bar',
    ]);
  });
});

test('a host whose parent resolves outside the app root is refused', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'trae');
    // Trae's host sits one directory below its root, so a link at User/ points
    // the write out of the app root while the root itself stays genuine.
    const elsewhere = path.join(homes.root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(detectDir(homes, 'trae'), 'User'));

    seedMcpLibrary(homes, { alpha: ALPHA });
    selection(homes, ['trae'], ['alpha']);

    const report = await runSync({});

    const blocked = entryFor(report, { app: 'trae', type: 'mcp' });
    assert.equal(blocked?.outcome, 'blocked');
    assert.equal(blocked?.detail, 'path-escape');
    assert.equal(fs.existsSync(path.join(elsewhere, 'mcp.json')), false);
  });
});

/**
 * The same value with `env` spelled as a sub-table. TOML merges it into
 * `mcp_servers.alpha`, so it parses to what asb records, but the header owns a
 * byte span of its own outside the parent table's: a splice of the parent can
 * neither replace it nor take it away.
 */
const SUB_TABLE_HOST = [
  '# my codex config -- hand written',
  'model = "some-model"',
  '',
  '[mcp_servers.alpha]',
  'command = "npx"',
  'args = [ "-y", "alpha" ]',
  '',
  '[mcp_servers.alpha.env]',
  'FOO = "one"',
  '',
  '[other_thing]',
  'keep = true',
  '',
].join('\n');

const ALPHA_SUB_TABLE = { command: 'npx', args: ['-y', 'alpha'], env: { FOO: 'one' } };

test('explain resolves a server by its identity, per app, with both hashes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'codex');
    // One app asb owns its key in, one whose spelling it cannot address.
    seedHost(homes, 'codex', SUB_TABLE_HOST);
    const definitions = seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { FOO: 'two' } },
    });
    selection(homes, ['cursor', 'codex'], ['alpha']);
    await runSync({});

    const { slices } = await runExplain('alpha');

    assert.equal(slices.length, 2, 'one slice per app that carries the server');
    assert.deepEqual(slices.map((slice) => slice.app).sort(), ['codex', 'cursor']);
    assert.deepEqual(
      slices.map((slice) => slice.path).sort(),
      [mcpHostPath(homes, 'codex'), mcpHostPath(homes, 'cursor')].sort()
    );
    for (const slice of slices) {
      assert.deepEqual(slice.components, [{ id: 'alpha', path: definitions }]);
      assert.ok(slice.desired?.includes('npx'));
    }

    const resolved = slices.find((slice) => slice.app === 'cursor');
    assert.equal(resolved?.outcome, 'unchanged');
    assert.equal(resolved?.provenance, 'identity');
    assert.equal(resolved?.desiredHash, resolved?.currentHash);

    const blocked = slices.find((slice) => slice.app === 'codex');
    assert.equal(blocked?.outcome, 'blocked');
    assert.equal(blocked?.detail, 'foreign');
    assert.equal(blocked?.provenance, null);
    assert.notEqual(blocked?.currentHash, blocked?.desiredHash);
  });
});

test('a codex table replaced by hand with an inline form is never spliced', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA });
    selection(homes, ['codex'], ['alpha']);
    await runSync({});

    // Same value, different TOML spelling: the byte-splice writer addresses
    // tables, so a key it cannot locate is reported rather than duplicated.
    const inline = 'mcp_servers = { alpha = { command = "npx" } }\n';
    seedHost(homes, 'codex', inline);
    seedMcpLibrary(homes, { alpha: { command: 'changed' } });
    const report = await runSync({});

    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), inline);
    const blocked = entryFor(report, { type: 'mcp', id: 'alpha' });
    assert.equal(blocked?.outcome, 'blocked');
    assert.equal(blocked?.detail, 'foreign');
    assert.match(blocked?.reason ?? '', /not written as a table/);
  });
});

test('an owned key with a descendant table conflicts rather than being half-written', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    selection(homes, ['codex'], ['alpha']);
    await runSync({});

    // Reformatted by hand into the sub-table spelling: same value, same order,
    // so the key still holds the render and nothing has drifted.
    seedHost(homes, 'codex', SUB_TABLE_HOST);
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { FOO: 'two' } },
    });
    const report = await runSync({});

    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
    const blocked = entryFor(report, { type: 'mcp', id: 'alpha' });
    assert.equal(blocked?.outcome, 'blocked');
    assert.equal(blocked?.detail, 'foreign');
    assert.match(blocked?.reason ?? '', /mcp_servers\.alpha\.env/);
    // A splice of the parent span would write `env.FOO` beside the orphaned
    // header and leave the whole document unreadable to codex.
    assert.deepEqual(readMcpHost(homes, 'codex')?.alpha, ALPHA_SUB_TABLE);
    assert.equal(report.exitCode, 1);

    // The desired value now loses `env` entirely. Splicing the parent span
    // writes bytes identical to what is there, so the host would look
    // unchanged while the sub-table keeps merging the stale values back in.
    seedMcpLibrary(homes, { alpha: { command: 'npx', args: ['-y', 'alpha'] } });
    const dropped = await runSync({});

    assert.equal(entryFor(dropped, { type: 'mcp', id: 'alpha' })?.outcome, 'blocked');
    assert.deepEqual(readMcpHost(homes, 'codex')?.alpha, ALPHA_SUB_TABLE, 'env is still merged');
    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
  });
});

test('a quoted sibling name is not a descendant: the owned key stays writable', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    selection(homes, ['codex'], ['alpha']);
    await runSync({});

    // A server literally named `alpha.beta`, a legal sibling key whose header
    // spells the dot inside quotes. It nests nothing under `alpha`.
    fs.appendFileSync(
      mcpHostPath(homes, 'codex'),
      '\n[mcp_servers."alpha.beta"]\ncommand = "beta-cmd"\n'
    );
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { FOO: 'two' } },
    });
    const report = await runSync({});

    assert.equal(mcpRows(report, 'codex')[0]?.outcome, 'written');
    assert.equal(report.exitCode, 0);
    const host = fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8');
    assert.match(host, /\[mcp_servers\."alpha\.beta"\]\ncommand = "beta-cmd"/);
    assert.equal(readMcpHost(homes, 'codex')?.alpha.env?.FOO, 'two');
  });
});

test('a key spelled across sub-tables already holds the render, so nothing happens', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    selection(homes, ['codex'], ['alpha']);
    seedHost(homes, 'codex', SUB_TABLE_HOST);

    const report = await runSync({});

    // Whoever wrote those headers, the server they describe is the library's.
    // Nothing needs writing, so the spelling asb could not splice never comes
    // up: it does the moment the definition moves on, and that run blocks.
    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
    assert.equal(entryFor(report, { type: 'mcp', id: 'alpha' })?.outcome, 'unchanged');
  });
});

test('a deselected key with a descendant table is left behind, not reported retired', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    selection(homes, ['codex'], ['alpha']);
    await runSync({});

    seedHost(homes, 'codex', SUB_TABLE_HOST);
    selection(homes, ['codex'], []);
    const report = await runSync({});

    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
    const left = entryFor(report, { type: 'mcp', id: 'alpha' });
    assert.equal(left?.outcome, 'left-behind');
    assert.match(left?.reason ?? '', /mcp_servers\.alpha\.env/);
  });
});

test('a still-selected server whose definition disappeared is missing, not retired', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { gone: { command: 'npx', args: ['gone'] } });
    selection(homes, ['codex'], ['gone']);
    assert.equal((await runSync({})).exitCode, 0);

    seedMcpLibrary(homes, {});
    for (const report of [await runSync({ dryRun: true }), await runSync({})]) {
      assert.equal(entryFor(report, { type: 'mcp', id: 'gone' })?.outcome, 'missing');
      assert.equal(
        report.entries.some((entry) => entry.reason?.includes('retired gone')),
        false,
        JSON.stringify(report.entries, null, 2)
      );
    }
    assert.ok(readMcpHost(homes, 'codex')?.gone, 'the key that was written stays written');
  });
});

test('explain masks every credential value after every app dialect', async () => {
  await withScratchHomes(async (homes) => {
    const localSecret = 'INVENTED-LOCAL-9f3a';
    const remoteSecret = 'INVENTED-REMOTE-9f3a';
    for (const row of APP_ROWS) fs.mkdirSync(row.detectDir(homes), { recursive: true });
    seedMcpLibrary(homes, {
      local: { command: 'run', env: { API_TOKEN: localSecret } },
      remote: {
        type: 'http',
        url: 'https://example.invalid/mcp',
        headers: { Authorization: remoteSecret },
        http_headers: { 'X-Api-Key': remoteSecret },
        env_http_headers: { 'X-Env-Key': remoteSecret },
      },
    });
    writeUserConfig(
      homes,
      `[applications]\nenabled = [${APP_ROWS.map((row) => JSON.stringify(row.id)).join(
        ', '
      )}]\n\n[mcp]\nenabled = ["local", "remote"]\n`
    );

    for (const id of ['local', 'remote']) {
      const { slices } = await runExplain(id);
      for (const row of APP_ROWS.filter((candidate) => candidate.mcp)) {
        const slice = slices.find((candidate) => candidate.app === row.id);
        assert.ok(slice, `${row.id}/${id}`);
        const json = JSON.stringify(slice);
        const text = renderExplain([slice], id);
        assert.equal(json.includes(localSecret) || json.includes(remoteSecret), false, row.id);
        assert.equal(text.includes(localSecret) || text.includes(remoteSecret), false, row.id);
      }
      // A masked value still says which credential it is: the key names stay.
      const verbatim = slices.filter((slice) => slice.app === 'claude-code');
      const text = renderExplain(verbatim, id);
      assert.match(text, /\*\*\*/, id);
      for (const key of id === 'local'
        ? ['API_TOKEN']
        : ['Authorization', 'X-Api-Key', 'X-Env-Key'])
        assert.match(text, new RegExp(key), `${id}/${key}`);
    }
  });
});

test('explain masks env values through the keyed-array dialect too', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.config', 'custom'), { recursive: true });
    const placeholder = 'INVENTED-PLACEHOLDER-9f3a';
    seedMcpLibrary(homes, { alpha: { command: 'run', env: { API_TOKEN: placeholder } } });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["custom"]',
        '',
        '[mcp]',
        'enabled = ["alpha"]',
        '',
        '[targets.custom.mcp]',
        'format = "yaml"',
        'config_path = "~/.config/custom/custom.yaml"',
        'root_key = "mcp_servers"',
        'structure = "keyed-array"',
        'key_field = "name"',
        'env_transform = { key_name = "key", value_name = "value" }',
        '',
      ].join('\n')
    );
    await runSync({});

    const { slices } = await runExplain('alpha');
    const output = renderExplain(slices, 'alpha');

    // Masking has to survive the reshape from an env map into kv members.
    assert.equal(output.includes(placeholder), false);
    assert.equal(JSON.stringify(slices).includes(placeholder), false);
    assert.match(output, /API_TOKEN/);
    assert.match(output, /\*\*\*/);
  });
});

test('structured cells that overlap or disagree on one host cancel every write', () => {
  const action = (id: string, baseContent: string, keyPath: string[], value: unknown): Action => ({
    app: id,
    type: 'mcp',
    id,
    path: '/tmp/shared.json',
    op: 'write',
    outcome: 'written',
    content: '{}',
    root: '/tmp',
    expectedHash: null,
    keyEdits: { format: 'json', baseContent, edits: [{ keyPath, value }] },
  });

  const scenarios: readonly [label: string, actions: Action[]][] = [
    [
      'the same key twice',
      [
        action('one', '{}', ['mcpServers', 'same'], { command: 'one' }),
        action('two', '{}', ['mcpServers', 'same'], { command: 'two' }),
      ],
    ],
    [
      'incompatible views of the base document',
      [
        action('one', '{}', ['mcpServers', 'one'], { command: 'one' }),
        action('two', '{ }', ['mcpServers', 'two'], { command: 'two' }),
      ],
    ],
    [
      'a key nested inside another edit',
      [
        action('one', '{}', ['mcpServers'], { alpha: { command: 'one' } }),
        action('two', '{}', ['mcpServers', 'alpha'], { command: 'two' }),
      ],
    ],
  ];

  for (const [label, actions] of scenarios) {
    const grouped = groupKeyActions(actions);
    assert.equal(grouped.length, actions.length, label);
    for (const candidate of grouped) {
      assert.notEqual(candidate.op, 'write', label);
      assert.ok(
        candidate.outcome === 'conflict' || candidate.outcome === 'failed',
        `${label}: ${JSON.stringify(candidate)}`
      );
      assert.equal(candidate.keyEdits, undefined, `${label}: a canceled action carries no edit`);
    }
  }
});

test('structured key edits fail closed on a document that addresses one key twice', () => {
  const document = '{"mcpServers": {"a": 1}, "other": 2, "mcpServers": {"b": 2}}';
  assert.throws(
    () => applyKeysEdits(document, 'json', [{ keyPath: ['mcpServers'], value: { c: 3 } }]),
    /duplicate key "mcpServers"/
  );
});
