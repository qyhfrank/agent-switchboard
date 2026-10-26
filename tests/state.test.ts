import assert from 'node:assert/strict';
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
