import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import { loadConfig } from '../src/engine/config.js';
import { installApps, seedRule, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

/**
 * The machine state a run resolves and leaves behind: where the home overrides
 * point, and a state directory that holds the fact of the last run and nothing
 * an earlier version recorded about what asb owns.
 */

const CLAUDE_CONFIG = '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n';

test('a relative home override resolves once against the invocation cwd', async () => {
  await withScratchHomes(async (homes) => {
    const config = loadConfig({
      env: {
        ...process.env,
        ASB_HOME: homes.asbHome,
        ASB_AGENTS_HOME: 'relative-agents',
        ASB_STATE_HOME: homes.stateHome,
      },
    });

    assert.ok(path.isAbsolute(config.homes.agentsHome));
    assert.equal(config.homes.agentsHome, path.resolve('relative-agents'));
  });
});

test('only a real run stamps the last-run fact a later status reads back', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Be kind.\n');
    writeUserConfig(homes, CLAUDE_CONFIG);

    const before = await runSync({ dryRun: true });
    assert.equal(before.lastRun, undefined, 'no run recorded yet');

    await runSync();

    const status = await runSync({ dryRun: true });
    assert.ok(status.lastRun, 'the real run stamped the fact');
    assert.match(status.lastRun?.summary ?? '', /1 written/);
  });
});

test('a sync clears the stores an earlier version wrote and leaves only run state', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Be kind.\n');
    writeUserConfig(homes, CLAUDE_CONFIG);

    // What an earlier install left in place: the entry ledger, the per-project
    // manifests, and the hook peer records. The ledger entry points at a file
    // belonging to an app this version does not know; sweeping means removing
    // the record, never acting on what it says.
    const sentinelPath = path.join(homes.agentsHome, '.retired-app', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, 'Sentinel bytes.\n');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    const legacyEntry = {
      app: 'retired-app',
      type: 'rules',
      id: null,
      path: sentinelPath,
      shape: 'own-file',
      hash: '0'.repeat(64),
      provenance: 'written',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(homes.stateHome, 'ledger.json'),
      `${JSON.stringify({ version: 1, entries: [legacyEntry] })}\n`
    );
    for (const store of ['hooks', 'manifests']) {
      const dir = path.join(homes.asbHome, 'state', store);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stale.json'), '{}\n');
    }
    // A live neighbour under the same parent, which is not asb's to clear.
    const native = path.join(homes.asbHome, 'state', 'native-plugins');
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'keep.json'), '{}\n');

    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(
      fs.readdirSync(homes.stateHome).sort(),
      ['last-run.json'],
      'the state dir carries the last run and, while one is in flight, run.lock'
    );
    assert.deepEqual(fs.readdirSync(path.join(homes.asbHome, 'state')), ['native-plugins']);
    assert.ok(fs.existsSync(path.join(native, 'keep.json')));
    assert.equal(
      fs.readFileSync(sentinelPath, 'utf-8'),
      'Sentinel bytes.\n',
      'the swept record never reaches the file it named'
    );

    const lastRun = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'last-run.json'), 'utf-8')
    ) as { at: string; summary: string };
    assert.match(lastRun.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(lastRun.summary, /written/);

    // A project phase records nothing new in either state parent.
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "managed"\n\n[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );
    assert.equal((await runSync({ project })).exitCode, 0);
    assert.deepEqual(fs.readdirSync(homes.stateHome).sort(), ['last-run.json']);
    assert.deepEqual(fs.readdirSync(path.join(homes.asbHome, 'state')), ['native-plugins']);
  });
});
