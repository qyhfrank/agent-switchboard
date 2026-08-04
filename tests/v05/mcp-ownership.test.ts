import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
  detectDir,
  installApps,
  type McpAppId,
  mcpHostPath,
  readMcpHost,
  type ScratchHomes,
  seedMcpLibrary,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Ownership honesty for MCP slices: what asb may overwrite, what it may
 * reclaim, and what it has to say when it can do neither.
 *
 * The owned slice of a managed server key is asb's full render, so a write is
 * a wholesale value replace and protection comes from the drift check rather
 * than from merging around the user's edits. That resolves the tension the
 * quarry recorded as R-6 vs R-7: 0.4's per-server field merge let a foreign
 * sub-key survive an update
 * while Trae's dialect needed the same key erased. Both cannot hold; the
 * replace is strictly safer because an edited slice conflicts instead of being
 * silently half-merged. The predecessor case is adapted here with that
 * changed expectation.
 *
 * Also adapted: 0.4's global write reset `mcpServers` to `{}` and repopulated
 * it, destroying any hand-written server (quarry R-2). Here a key is foreign
 * until identity proves it.
 */

const ALPHA = { command: 'npx', args: ['-y', 'alpha'] };

function seedHost(homes: ScratchHomes, app: McpAppId, content: string): string {
  const filePath = mcpHostPath(homes, app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function config(homes: ScratchHomes, apps: string[], servers: string[]): void {
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

function row(report: Report, id: string): ReportEntry | undefined {
  return report.entries.find((entry) => entry.type === 'mcp' && entry.id === id);
}

test('selecting a server puts the library definition at its key, and nothing else', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    const host = seedHost(
      homes,
      'cursor',
      '{\n  "mcpServers": {\n    "alpha": { "command": "mine", "args": ["hand-written"] },\n    "theirs": { "command": "theirs" }\n  }\n}\n'
    );
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);

    const report = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, {
      command: 'npx',
      args: ['-y', 'alpha'],
      type: 'stdio',
    });
    assert.deepEqual(readMcpHost(homes, 'cursor')?.theirs, { command: 'theirs' });
    assert.equal(report.exitCode, 0);
    assert.ok(fs.readFileSync(host, 'utf-8').includes('theirs'));
  });
});

test('a key already holding asb’s own render needs no write', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);
    const before = seedHost(
      homes,
      'cursor',
      `${JSON.stringify(
        { mcpServers: { alpha: { command: 'npx', args: ['-y', 'alpha'], type: 'stdio' } } },
        null,
        2
      )}\n`
    );
    const bytes = fs.readFileSync(before, 'utf-8');

    const report = await runSync({});

    assert.equal(row(report, 'alpha')?.outcome, 'unchanged');
    assert.equal(fs.readFileSync(before, 'utf-8'), bytes, 'the host is not rewritten');
  });
});

test('foreign servers beside an owned key survive every write and every removal', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedHost(
      homes,
      'cursor',
      '{\n  "mcpServers": {\n    "theirs": { "command": "theirs" }\n  },\n  "otherSetting": true\n}\n'
    );
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);

    await runSync({});
    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}), ['theirs', 'alpha']);

    config(homes, ['cursor'], []);
    const report = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor'), { theirs: { command: 'theirs' } });
    // The removal is an edit, so it rides the host's one grouped write.
    const write = report.entries.find(
      (entry) => entry.type === 'mcp' && entry.outcome === 'written'
    );
    assert.equal(write?.reason, 'retired alpha');
    const content = JSON.parse(fs.readFileSync(mcpHostPath(homes, 'cursor'), 'utf-8'));
    assert.equal(content.otherSetting, true);
  });
});

test('an update replaces the owned value wholesale, so a stale sub-key goes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'first', args: ['a'] } });
    config(homes, ['cursor'], ['alpha']);
    await runSync({});
    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, {
      command: 'first',
      args: ['a'],
      type: 'stdio',
    });

    // 0.4 merged per field, so `args` survived a command-only definition.
    seedMcpLibrary(homes, { alpha: { command: 'second' } });
    const report = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, { command: 'second', type: 'stdio' });
    assert.match(report.entries.find((entry) => entry.type === 'mcp')?.reason ?? '', /wrote alpha/);
  });
});

test('trae erases a type key it once wrote when the definition loses it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'trae');
    seedMcpLibrary(homes, { alpha: { type: 'http', url: 'https://example.com/one' } });
    config(homes, ['trae'], ['alpha']);
    await runSync({});
    assert.deepEqual(readMcpHost(homes, 'trae')?.alpha, { url: 'https://example.com/one' });

    seedMcpLibrary(homes, { alpha: { command: 'npx' } });
    await runSync({});

    assert.deepEqual(readMcpHost(homes, 'trae')?.alpha, { command: 'npx' });
  });
});

test('a selected slice edited by hand takes the library definition again', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);
    await runSync({});

    const host = mcpHostPath(homes, 'cursor');
    const edited = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    edited.mcpServers.alpha.args = ['-y', 'edited-by-hand'];
    fs.writeFileSync(host, `${JSON.stringify(edited, null, 2)}\n`, 'utf-8');

    seedMcpLibrary(homes, { alpha: { command: 'npx', args: ['-y', 'alpha', '--new'] } });
    const report = await runSync({});

    // Selecting a server asks for the library's definition at that key, so the
    // edit loses to it rather than deadlocking the run. Edit the library entry.
    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha.args, ['-y', 'alpha', '--new']);
    assert.equal(report.exitCode, 0);
  });
});

test('a deselected slice whose command was changed is left alone and not named', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);
    await runSync({});

    const host = mcpHostPath(homes, 'cursor');
    const edited = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    edited.mcpServers.alpha.command = 'user-edited';
    fs.writeFileSync(host, `${JSON.stringify(edited, null, 2)}\n`, 'utf-8');

    config(homes, ['cursor'], []);
    const report = await runSync({});

    // A key running a different program is a different server that happens to
    // carry the name, whoever typed it. It stays, and nothing is said about it.
    assert.equal(readMcpHost(homes, 'cursor')?.alpha.command, 'user-edited');
    assert.equal(row(report, 'alpha'), undefined, JSON.stringify(report.entries, null, 2));
    assert.equal(report.exitCode, 0);
  });
});

test('a deselected slice already gone is nothing to report', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);
    await runSync({});

    const empty = '{\n  "mcpServers": {}\n}\n';
    fs.writeFileSync(mcpHostPath(homes, 'cursor'), empty, 'utf-8');
    config(homes, ['cursor'], []);
    const report = await runSync({});

    assert.equal(row(report, 'alpha'), undefined, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.readFileSync(mcpHostPath(homes, 'cursor'), 'utf-8'), empty);
  });
});

test('removal takes one key and leaves the other owned keys in place', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { command: 'beta' } });
    config(homes, ['codex'], ['alpha', 'beta']);
    await runSync({});

    config(homes, ['codex'], ['beta']);
    const report = await runSync({});

    assert.deepEqual(Object.keys(readMcpHost(homes, 'codex') ?? {}), ['beta']);
    assert.equal(row(report, 'beta')?.outcome, 'unchanged');
    const write = report.entries.find(
      (entry) => entry.type === 'mcp' && entry.outcome === 'written'
    );
    assert.equal(write?.reason, 'retired alpha');
  });
});

test('two ids that sanitize to one key fail that app rather than take turns', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'gemini');
    seedMcpLibrary(homes, { 'foo:bar': ALPHA, 'foo-bar': { command: 'other' } });
    config(homes, ['cursor', 'gemini'], ['foo:bar', 'foo-bar']);

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
    config(homes, ['trae'], ['alpha']);

    const report = await runSync({});

    const blocked = report.entries.find((entry) => entry.type === 'mcp' && entry.app === 'trae');
    assert.equal(blocked?.outcome, 'blocked');
    assert.equal(blocked?.detail, 'path-escape');
    assert.equal(fs.existsSync(path.join(elsewhere, 'mcp.json')), false);
  });
});

test('explain resolves a server by its identity, per app, with both hashes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'codex');
    const definitions = seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor', 'codex'], ['alpha']);
    await runSync({});

    const { slices } = await runExplain('alpha');

    assert.equal(slices.length, 2, 'one slice per app that carries the server');
    for (const slice of slices) {
      assert.equal(slice.outcome, 'unchanged');
      assert.equal(slice.provenance, 'identity');
      assert.equal(slice.desiredHash, slice.currentHash);
      assert.deepEqual(slice.components, [{ id: 'alpha', path: definitions }]);
      assert.ok(slice.desired?.includes('npx'));
    }
    assert.deepEqual(slices.map((slice) => slice.app).sort(), ['codex', 'cursor']);
    assert.deepEqual(
      slices.map((slice) => slice.path).sort(),
      [mcpHostPath(homes, 'codex'), mcpHostPath(homes, 'cursor')].sort()
    );
  });
});

test('explain names a key asb cannot splice and what is in the way', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHost(homes, 'codex', SUB_TABLE_HOST);
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { FOO: 'two' } },
    });
    config(homes, ['codex'], ['alpha']);

    const [slice] = (await runExplain('alpha')).slices;

    assert.equal(slice.outcome, 'blocked');
    assert.equal(slice.detail, 'foreign');
    assert.equal(slice.provenance, null);
    assert.notEqual(slice.currentHash, slice.desiredHash);
  });
});

test('a codex table replaced by hand with an inline form is never spliced', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['codex'], ['alpha']);
    await runSync({});

    // Same value, different TOML spelling: the byte-splice writer addresses
    // tables, so a key it cannot locate is reported rather than duplicated.
    seedHost(homes, 'codex', 'mcp_servers = { alpha = { command = "npx" } }\n');
    seedMcpLibrary(homes, { alpha: { command: 'changed' } });
    const report = await runSync({});

    assert.equal(
      fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'),
      'mcp_servers = { alpha = { command = "npx" } }\n'
    );
    const blocked = row(report, 'alpha');
    assert.equal(blocked?.outcome, 'blocked');
    assert.equal(blocked?.detail, 'foreign');
    assert.match(blocked?.reason ?? '', /not written as a table/);
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
  'model = "gpt-5"',
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

test('an owned key with a descendant table conflicts rather than being half-written', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    config(homes, ['codex'], ['alpha']);
    await runSync({});

    // Reformatted by hand into the sub-table spelling: same value, same order,
    // so the key still holds the render and nothing has drifted.
    seedHost(homes, 'codex', SUB_TABLE_HOST);
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { FOO: 'two' } },
    });
    const report = await runSync({});

    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
    const blocked = row(report, 'alpha');
    assert.equal(blocked?.outcome, 'blocked');
    assert.equal(blocked?.detail, 'foreign');
    assert.match(blocked?.reason ?? '', /mcp_servers\.alpha\.env/);
    // A splice of the parent span would write `env.FOO` beside the orphaned
    // header and leave the whole document unreadable to codex.
    assert.deepEqual(readMcpHost(homes, 'codex')?.alpha, ALPHA_SUB_TABLE);
    assert.equal(report.exitCode, 1);
  });
});

test('a quoted sibling name is not a descendant: the owned key stays writable', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    config(homes, ['codex'], ['alpha']);
    await runSync({});

    // A server literally named `alpha.beta` — a legal sibling key whose header
    // spells the dot inside quotes. It nests nothing under `alpha`.
    const sibling = '\n[mcp_servers."alpha.beta"]\ncommand = "beta-cmd"\n';
    fs.appendFileSync(mcpHostPath(homes, 'codex'), sibling);
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', args: ['-y', 'alpha'], env: { FOO: 'two' } },
    });
    const report = await runSync({});

    const written = row(report, null) ?? row(report, 'alpha');
    assert.equal(written?.outcome, 'written');
    assert.equal(report.exitCode, 0);
    const host = fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8');
    assert.match(host, /\[mcp_servers\."alpha\.beta"\]\ncommand = "beta-cmd"/);
    assert.equal(readMcpHost(homes, 'codex')?.alpha.env?.FOO, 'two');
  });
});

test('a descendant table is never re-merged behind a hash that says otherwise', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    config(homes, ['codex'], ['alpha']);
    await runSync({});

    // The desired value loses `env` entirely. Splicing the parent span writes
    // bytes identical to what is there, so the host looks unchanged while the
    // sub-table keeps merging the stale values back into the parsed server.
    seedHost(homes, 'codex', SUB_TABLE_HOST);
    seedMcpLibrary(homes, { alpha: { command: 'npx', args: ['-y', 'alpha'] } });
    const report = await runSync({});

    assert.equal(row(report, 'alpha')?.outcome, 'blocked');
    assert.deepEqual(readMcpHost(homes, 'codex')?.alpha, ALPHA_SUB_TABLE, 'env is still merged');
    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
  });
});

test('a key spelled across sub-tables already holds the render, so nothing happens', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    config(homes, ['codex'], ['alpha']);
    seedHost(homes, 'codex', SUB_TABLE_HOST);

    const report = await runSync({});

    // Whoever wrote those headers, the server they describe is the library's.
    // Nothing needs writing, so the spelling asb could not splice never comes
    // up — it does the moment the definition moves on, and that run blocks.
    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
    assert.equal(row(report, 'alpha')?.outcome, 'unchanged');
  });
});

test('a deselected key with a descendant table is left behind, not reported retired', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: ALPHA_SUB_TABLE });
    config(homes, ['codex'], ['alpha']);
    await runSync({});

    seedHost(homes, 'codex', SUB_TABLE_HOST);
    config(homes, ['codex'], []);
    const report = await runSync({});

    assert.equal(fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8'), SUB_TABLE_HOST);
    const left = row(report, 'alpha');
    assert.equal(left?.outcome, 'left-behind');
    assert.match(left?.reason ?? '', /mcp_servers\.alpha\.env/);
  });
});
