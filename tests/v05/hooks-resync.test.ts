import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import { installApps, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

/** The built 0.5 CLI re-syncs its own hook state without duplicate appends or removals. */

const DIST = path.resolve('dist/index.js');

function seedHook(asbHome: string, id: string): void {
  const dir = path.join(asbHome, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    `${JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: `echo ${id}` }] }],
        },
      },
      null,
      2
    )}\n`
  );
}

test('the built 0.5 binary re-syncs hook state without duplicates or removals', async () => {
  // The resync case is the suite's only executable evidence on the built
  // binary; a missing dist is a broken gate, never a skip. CI builds first.
  assert.ok(fs.existsSync(DIST), 'dist/index.js absent — run npm run build first');
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes.asbHome, 'probe');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["probe"]\n'
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0, 'the 0.5 sync succeeds');
    const settingsPath = path.join(homes.agentsHome, '.claude', 'settings.json');
    const statePath = path.join(homes.asbHome, 'state', 'hooks', 'claude-code.json');
    const settingsBefore = fs.readFileSync(settingsPath, 'utf-8');
    const stateBefore = fs.readFileSync(statePath, 'utf-8');
    const groupsBefore = JSON.parse(settingsBefore).hooks.UserPromptSubmit.length;

    const env = {
      ...process.env,
      ASB_HOME: homes.asbHome,
      ASB_AGENTS_HOME: homes.agentsHome,
      ASB_STATE_HOME: homes.stateHome,
      ASB_CACHE_HOME: path.join(homes.root, 'cache'),
    };

    const dry = spawnSync(process.execPath, [DIST, 'sync', '--dry-run'], {
      env,
      encoding: 'utf-8',
    });
    assert.equal(dry.status, 0, `0.5 dry-run exits clean\n${dry.stdout}\n${dry.stderr}`);

    const real = spawnSync(process.execPath, [DIST, 'sync'], { env, encoding: 'utf-8' });
    assert.equal(real.status, 0, `0.5 sync exits clean\n${real.stdout}\n${real.stderr}`);

    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.equal(
      settingsAfter.hooks.UserPromptSubmit.length,
      groupsBefore,
      'the group is neither duplicated nor removed'
    );
    const stateAfter = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(stateAfter.version, 1);
    assert.equal(
      stateAfter.events.UserPromptSubmit.length,
      JSON.parse(stateBefore).events.UserPromptSubmit.length,
      'the shared record still carries exactly the groups 0.5 appended'
    );
  });
});
