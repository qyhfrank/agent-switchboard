import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { executeAction, runSync } from '../../src/engine/cli.js';
import type { Ledger } from '../../src/engine/ledger.js';
import type { Action } from '../../src/engine/plan.js';
import { hashContent } from '../../src/engine/shapes.js';
import {
  installApps,
  renderedRules,
  ruleFilePath,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const CODEX_CONFIG = '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["base"]\n';
const CURSOR_CONFIG = '[applications]\nenabled = ["cursor"]\n\n[rules]\nenabled = ["base"]\n';

function ageFile(filePath: string, minutes: number): void {
  const past = (Date.now() - minutes * 60 * 1000) / 1000;
  fs.utimesSync(filePath, past, past);
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  assert.ok(result.pid, 'spawn produced a pid');
  return result.pid;
}

test('a lock held by a live process refuses the run, however old the file', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    const lockFile = path.join(homes.stateHome, 'run.lock');
    fs.writeFileSync(lockFile, `${process.pid} test\n`);
    ageFile(lockFile, 20);

    await assert.rejects(() => runSync(), /active/i);
    assert.equal(fs.existsSync(ruleFilePath(homes, 'codex')), false, 'nothing written');
    assert.equal(fs.existsSync(lockFile), true, 'foreign lock left in place');
  });
});

test('a stale lock from a dead process is stolen and the run proceeds', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    const lockFile = path.join(homes.stateHome, 'run.lock');
    fs.writeFileSync(lockFile, `${deadPid()} test\n`);
    ageFile(lockFile, 20);

    const report = await runSync();
    assert.equal(report.exitCode, 0);
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8'),
      renderedRules('codex', 'Always be kind.\n')
    );
    assert.equal(fs.existsSync(lockFile), false, 'lock released after the run');
  });
});

test('an escaping parent chain blocks identically in dry-run and real run', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CURSOR_CONFIG);
    installApps(homes, 'cursor');
    const outside = path.join(homes.root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(homes.agentsHome, '.cursor', 'rules'));

    const dry = await runSync({ dryRun: true });
    const real = await runSync();
    const pick = (entries: typeof dry.entries) =>
      entries.map(({ app, outcome, detail }) => ({ app, outcome, detail }));
    assert.deepEqual(pick(dry.entries), pick(real.entries));
    assert.equal(dry.entries[0].outcome, 'blocked');
    assert.equal(dry.entries[0].detail, 'path-escape');
    assert.equal(dry.exitCode, 1);
    assert.equal(real.exitCode, 1);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the escape');
    assert.equal(
      fs.existsSync(path.join(homes.stateHome, 'run.lock')),
      false,
      'lock released after a blocked run'
    );
  });
});

test('a symlinked target file writes through the link and removal unlinks only the link', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    const backing = path.join(homes.root, 'mackup-store', 'AGENTS.md');
    fs.mkdirSync(path.dirname(backing), { recursive: true });
    fs.writeFileSync(backing, 'old hand-managed content\n');
    const target = ruleFilePath(homes, 'codex');
    fs.symlinkSync(backing, target);

    // First contact adopts the occupied file by convention without writing;
    // the update lands on the next sync and flips the entry to written.
    const adoption = await runSync();
    assert.equal(adoption.exitCode, 0);
    assert.equal(
      fs.readFileSync(backing, 'utf-8'),
      'old hand-managed content\n',
      'adoption writes nothing'
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0);
    const rendered = renderedRules('codex', 'Always be kind.\n');
    assert.equal(fs.readFileSync(backing, 'utf-8'), rendered, 'written through the link');
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'target is still the user link');

    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = []\n');
    const removal = await runSync();
    assert.equal(removal.exitCode, 0);
    assert.equal(removal.summary.removed, 1);
    assert.ok(!fs.existsSync(target) && !fs.lstatSync(backing).isSymbolicLink());
    assert.equal(fs.readFileSync(backing, 'utf-8'), rendered, 'the backing file is never deleted');
    assert.throws(() => fs.lstatSync(target), 'the link itself is gone');
  });
});

test('the executor refuses actions whose target drifted after planning', async () => {
  await withScratchHomes(async (homes) => {
    const dir = path.join(homes.root, 'drift');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(target, 'tampered after planning\n');
    const ledger: Ledger = { version: 1, entries: [] };

    const base: Action = {
      app: 'codex',
      type: 'rules',
      id: null,
      path: target,
      op: 'write',
      outcome: 'written',
      detail: 'updated',
      content: 'new content\n',
      root: dir,
      expectedHash: hashContent('what planning captured\n'),
      ledger: {
        op: 'put',
        entry: {
          app: 'codex',
          type: 'rules',
          id: null,
          path: target,
          shape: 'own-file',
          hash: hashContent('new content\n'),
          provenance: 'written',
          updatedAt: 'now',
        },
      },
    };

    const write = executeAction(base, ledger);
    assert.equal(write.outcome, 'conflict');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'tampered after planning\n');
    assert.equal(ledger.entries.length, 0, 'no ledger claim on refusal');

    const remove = executeAction({ ...base, op: 'remove', outcome: 'removed' }, ledger);
    assert.equal(remove.outcome, 'left-behind');
    assert.equal(remove.detail, 'modified');
    assert.equal(fs.existsSync(target), true);

    const matching = executeAction(
      { ...base, expectedHash: hashContent('tampered after planning\n') },
      ledger
    );
    assert.equal(matching.outcome, 'written');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'new content\n');
    assert.equal(ledger.entries.length, 1, 'ledger claim recorded on success');
  });
});

test('mutations without a containment root are refused, not silently unchecked', async () => {
  const ledger: Ledger = { version: 1, entries: [] };
  const entry = executeAction(
    {
      app: 'codex',
      type: 'rules',
      id: null,
      path: '/tmp/never-written.md',
      op: 'write',
      outcome: 'written',
      content: 'x',
      expectedHash: null,
    },
    ledger
  );
  assert.equal(entry.outcome, 'blocked');
  assert.equal(entry.detail, 'path-escape');
  assert.equal(fs.existsSync('/tmp/never-written.md'), false);
});
