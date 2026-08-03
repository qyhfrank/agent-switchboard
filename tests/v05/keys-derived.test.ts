import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
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
 * The keys comparator: a slice inside a document the user also writes is
 * asb's while the serialized value at its key path equals the render.
 *
 * The name of the key proves nothing. Anyone writing an MCP server by hand
 * picks the name the library would pick, so a key whose value is not the
 * render is the user's — it is never overwritten on the way out and never
 * removed. Deleting a hand-written server is the one outcome this shape
 * exists to prevent, which is why the deselect scan says nothing at all about
 * a key it cannot tie to the library's own definition.
 */

const ALPHA = { command: 'npx', args: ['-y', 'alpha'] };
/** What cursor's dialect makes of ALPHA. */
const ALPHA_RENDERED = { command: 'npx', args: ['-y', 'alpha'], type: 'stdio' };

function seedHost(homes: ScratchHomes, app: McpAppId, servers: Record<string, unknown>): string {
  const filePath = mcpHostPath(homes, app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf-8');
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

function rows(report: Report, id: string) {
  return report.entries.filter((entry) => entry.type === 'mcp' && entry.id === id);
}

/** Every key edit to one host lands as a single write, named by its reason. */
function hostWrite(report: Report): ReportEntry {
  const entry = report.entries.find((row) => row.type === 'mcp' && row.id === null);
  assert.ok(entry, JSON.stringify(report.entries, null, 2));
  return entry;
}

/** Forget everything the previous run recorded, so only derivation is left. */
function forgetLedger(homes: ScratchHomes): void {
  fs.rmSync(path.join(homes.stateHome, 'ledger.json'), { force: true });
}

test('a server sharing a library id but never selected is neither touched nor named', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA, beta: { command: 'npx', args: ['-y', 'beta'] } });
    config(homes, ['cursor'], ['beta']);
    const mine = { command: 'mine', args: ['hand-written'] };
    const host = seedHost(homes, 'cursor', { alpha: mine });

    const report = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, mine);
    assert.deepEqual(rows(report, 'alpha'), [], JSON.stringify(report.entries, null, 2));
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.readFileSync(host, 'utf-8').includes('hand-written'));
  });
});

test('a customized library server is left behind and reported once on deselection', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], []);
    const customized = { ...ALPHA_RENDERED, env: { TOKEN: 'mine' } };
    seedHost(homes, 'cursor', { alpha: customized });

    const report = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, customized);
    const left = rows(report, 'alpha');
    assert.equal(left.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(left[0].outcome, 'left-behind');
    assert.equal(left[0].detail, 'modified');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
  });
});

test('a deselected server still holding the render is removed with no record to consult', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);
    await runSync({});
    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, ALPHA_RENDERED);

    forgetLedger(homes);
    config(homes, ['cursor'], []);
    const report = await runSync({});

    assert.equal(readMcpHost(homes, 'cursor')?.alpha, undefined);
    assert.match(hostWrite(report).reason ?? '', /retired alpha/);
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
  });
});

test('selecting a server whose key drifted rewrites it in one pass', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: ALPHA });
    config(homes, ['cursor'], ['alpha']);
    seedHost(homes, 'cursor', { alpha: { command: 'npx', args: ['-y', 'alpha@0.1'] } });

    const first = await runSync({});
    assert.match(hostWrite(first).reason ?? '', /wrote alpha/);
    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, ALPHA_RENDERED);

    forgetLedger(homes);
    const second = await runSync({});
    assert.equal(rows(second, 'alpha')[0]?.outcome, 'unchanged');
    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
  });
});

test('a hand-edited Codex role key survives deselection and its neighbour is removed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    const role = (id: string) =>
      fs.writeFileSync(
        path.join(homes.asbHome, 'agents', `${id}.md`),
        `---\nextras:\n  codex:\n    model: gpt-5\n---\n${id}\n`,
        'utf-8'
      );
    fs.mkdirSync(path.join(homes.asbHome, 'agents'), { recursive: true });
    role('reviewer');
    role('planner');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = ["reviewer", "planner"]\n'
    );
    await runSync();

    const configPath = path.join(homes.agentsHome, '.codex', 'config.toml');
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, 'utf-8')
        .replace('[agents.reviewer]', '[agents.reviewer]\nmine = true'),
      'utf-8'
    );

    forgetLedger(homes);
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[agents]\nenabled = []\n');
    const report = await runSync();

    const parsed = parseToml(fs.readFileSync(configPath, 'utf-8')) as {
      agents?: Record<string, unknown>;
    };
    assert.ok(parsed.agents?.reviewer, 'the edited role key is the user’s now');
    assert.equal(parsed.agents?.planner, undefined, 'the untouched one is provably asb’s');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
  });
});
