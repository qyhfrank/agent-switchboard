import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import { loadConfig } from '../../src/engine/config.js';
import { redactCredentials, renderReport } from '../../src/engine/report.js';
import { installApps, seedRule, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

test('relative home overrides resolve once against the invocation cwd', async () => {
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

test('project scope rejects a missing root before planning', async () => {
  await withScratchHomes(async () => {
    await assert.rejects(
      runSync({ project: '/tmp/some-repo' }),
      /does not exist or cannot be resolved/
    );
  });
});

test('the credential redactor also masks bare token userinfo', () => {
  assert.equal(
    redactCredentials('clone https://ghp_abc123@github.com/x failed'),
    'clone https://***@github.com/x failed'
  );
  assert.equal(redactCredentials('https://user:secret@host/path'), 'https://user:***@host/path');
  assert.equal(redactCredentials('https://secret-token@host/path'), 'https://***@host/path');
  assert.equal(redactCredentials('no credentials here'), 'no credentials here');
});

test('status reports the last completed real run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Be kind.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );

    const before = await runSync({ dryRun: true });
    assert.equal(before.lastRun, undefined, 'no run recorded yet');

    await runSync();

    const status = await runSync({ dryRun: true });
    assert.ok(status.lastRun, 'the real run stamped the fact');
    assert.match(status.lastRun?.summary ?? '', /1 written/);
    assert.match(renderReport(status), /last run: .* — 1 written/);
  });
});

// 0.4 lowercased the extension before matching, so `Tool.MJS` was a loaded
// extension there and must reach the cut-over advisory here too — on its own,
// not only when a lowercase sibling already triggers the row.
for (const [label, executables] of [
  ['mixed case', ['first.mjs', 'second.js', 'Tool.MJS']],
  ['uppercase only', ['Tool.MJS']],
] as const) {
  test(`leftover executable extensions produce one non-failing peer-aware warning (${label})`, async () => {
    await withScratchHomes(async (homes) => {
      const extensions = path.join(homes.asbHome, 'extensions');
      fs.mkdirSync(extensions);
      const files = [...executables, 'notes.txt'].map((name) => path.join(extensions, name));
      for (const file of files) {
        fs.writeFileSync(
          file,
          file.endsWith('notes.txt') ? 'not executable\n' : 'throw new Error("must not import");\n'
        );
      }
      const before = files.map((file) => fs.readFileSync(file));

      for (const options of [{ dryRun: true }, { dryRun: true, idGlob: 'does-not-match' }]) {
        const report = await runSync(options);
        const warnings = report.entries.filter((entry) => entry.detail === 'extensions-removed');

        assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
        assert.equal(warnings.length, 1, JSON.stringify(report.entries, null, 2));
        assert.equal(warnings[0].outcome, 'skipped');
        assert.match(warnings[0].reason ?? '', /executable .* extensions .* removed/i);
        assert.match(warnings[0].reason ?? '', /\[targets\.<id>\]/);
        assert.match(warnings[0].reason ?? '', /0\.4 peer sharing .* library/i);
        assert.match(warnings[0].reason ?? '', /not deleted at cut-over/i);
      }
      assert.deepEqual(
        files.map((file) => fs.readFileSync(file)),
        before
      );
    });
  });
}
