import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { executeAction, runSync } from '../src/engine/cli.js';
import type { Action } from '../src/engine/plan.js';
import { acquireRunLock } from '../src/engine/runstate.js';
import { hashContent } from '../src/engine/shapes.js';
import {
  installApps,
  renderedRules,
  ruleFilePath,
  seedRule,
  seedSkill,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * What the executor refuses to do at write time: run beside another run,
 * follow a link out of the app root, overwrite content that changed after
 * planning, or let one pathological path disable the rest of the run.
 */

const CODEX_CONFIG = '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["base"]\n';
const CURSOR_CONFIG = '[applications]\nenabled = ["cursor"]\n\n[rules]\nenabled = ["base"]\n';
const BODY = 'Always be kind.\n';

function ageFile(filePath: string, minutes: number): void {
  const past = (Date.now() - minutes * 60 * 1000) / 1000;
  fs.utimesSync(filePath, past, past);
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  assert.ok(result.pid, 'spawn produced a pid');
  return result.pid;
}

test('a lock fails the run closed however old it is, and is never reaped', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', BODY);
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    const lockFile = path.join(homes.stateHome, 'run.lock');

    // A holder that is still alive: age alone never makes a lock stealable.
    fs.writeFileSync(lockFile, `${process.pid} test\n`);
    ageFile(lockFile, 20);
    await assert.rejects(() => runSync(), /active/i);
    assert.equal(fs.existsSync(ruleFilePath(homes, 'codex')), false, 'nothing written');
    assert.equal(fs.existsSync(lockFile), true, 'foreign lock left in place');

    // A holder that is gone: any steal of the live path races a concurrent
    // O_EXCL create, so the run stops and tells the user what to remove.
    const dead = deadPid();
    fs.writeFileSync(lockFile, `${dead} test\n`);
    ageFile(lockFile, 20);
    await assert.rejects(() => runSync(), new RegExp(`${dead}.*not running`));
    assert.equal(fs.existsSync(ruleFilePath(homes, 'codex')), false, 'nothing written');
    assert.equal(fs.existsSync(lockFile), true, 'lock left for manual removal');
    assert.deepEqual(
      fs.readdirSync(homes.stateHome).filter((name) => name.startsWith('run.lock.')),
      [],
      'no half-written lock generation is left behind'
    );

    fs.unlinkSync(lockFile);
    const report = await runSync();
    assert.equal(report.exitCode, 0);
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8'),
      renderedRules('codex', BODY)
    );
    assert.equal(fs.existsSync(lockFile), false, 'lock released after the run');
  });
});

test('release only unlinks the lock generation this process wrote', async () => {
  await withScratchHomes(async (homes) => {
    const lockFile = path.join(homes.stateHome, 'run.lock');
    const lock = acquireRunLock(homes.stateHome);
    const foreign = `${process.pid} 2099-01-01T00:00:00.000Z (foreign)\n`;
    fs.writeFileSync(lockFile, foreign);

    lock.release();
    assert.equal(fs.readFileSync(lockFile, 'utf-8'), foreign);

    fs.unlinkSync(lockFile);
    const second = acquireRunLock(homes.stateHome);
    second.release();
    assert.equal(fs.existsSync(lockFile), false);
  });
});

test('an escaping parent chain blocks identically in dry-run and real run', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', BODY);
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

test('a symlinked target is written through and keeps its link on removal', async () => {
  for (const backingState of ['present', 'missing'] as const) {
    await withScratchHomes(async (homes) => {
      seedRule(homes, 'base.md', BODY);
      writeUserConfig(homes, CODEX_CONFIG);
      installApps(homes, 'codex');
      const backing = path.join(homes.root, 'dotfiles-store', 'AGENTS.md');
      fs.mkdirSync(path.dirname(backing), { recursive: true });
      if (backingState === 'present') fs.writeFileSync(backing, 'old hand-managed content\n');
      const target = ruleFilePath(homes, 'codex');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(backing, target);

      const report = await runSync();

      // Replacing the link with a plain file would break the dotfiles setup
      // the user built the link for, dangling backing file or not.
      assert.equal(report.exitCode, 0);
      assert.ok(fs.lstatSync(target).isSymbolicLink(), 'target is still the user link');
      assert.equal(
        fs.readFileSync(backing, 'utf-8'),
        backingState === 'present'
          ? `${renderedRules('codex', BODY)}\nold hand-managed content\n`
          : renderedRules('codex', BODY),
        'written through the link, above the bytes already there'
      );

      if (backingState !== 'present') return;
      writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = []\n');
      const removal = await runSync();
      assert.equal(removal.exitCode, 0);
      assert.equal(removal.summary.removed, 1);
      assert.equal(
        fs.readFileSync(backing, 'utf-8'),
        'old hand-managed content\n',
        'the region goes, the hand-managed bytes stay'
      );
      assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the user link is never unlinked');
    });
  }
});

test('the executor refuses actions whose target drifted after planning', async () => {
  await withScratchHomes(async (homes) => {
    const dir = path.join(homes.root, 'drift');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(target, 'tampered after planning\n');

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
    };

    const write = executeAction(base);
    assert.equal(write.outcome, 'conflict');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'tampered after planning\n');

    const remove = executeAction({ ...base, op: 'remove', outcome: 'removed' });
    assert.equal(remove.outcome, 'left-behind');
    assert.equal(remove.detail, 'modified');
    assert.equal(fs.existsSync(target), true);

    const matching = executeAction({
      ...base,
      expectedHash: hashContent('tampered after planning\n'),
    });
    assert.equal(matching.outcome, 'written');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'new content\n');
  });
});

test('mutations without a containment root are refused, not silently unchecked', async () => {
  await withScratchHomes(async (homes) => {
    const target = path.join(homes.root, 'never-written.md');

    const entry = executeAction({
      app: 'codex',
      type: 'rules',
      id: null,
      path: target,
      op: 'write',
      outcome: 'written',
      content: 'x',
      expectedHash: null,
    });

    assert.equal(entry.outcome, 'blocked');
    assert.equal(entry.detail, 'path-escape');
    assert.equal(fs.existsSync(target), false);
  });
});

test('a symlink cycle at the target fails the entry and never replaces the link', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', BODY);
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    const target = ruleFilePath(homes, 'codex');
    const partner = path.join(path.dirname(target), 'loop-partner');
    fs.symlinkSync(partner, target);
    fs.symlinkSync(target, partner);

    const report = await runSync();

    // An unwritable target fails its own row instead of being replaced.
    const entry = report.entries.find((candidate) => candidate.app === 'codex');
    assert.equal(entry?.outcome, 'failed');
    assert.equal(entry?.detail, 'write-error');
    assert.match(entry?.reason ?? '', /ELOOP/);
    assert.equal(report.exitCode, 1);
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the cyclic link is preserved');
    assert.ok(fs.lstatSync(partner).isSymbolicLink());
  });
});

test('a cyclic directory contains to its own rows instead of killing the run', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', BODY);
    seedSkill(homes, 'alpha');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "claude-code"]\n\n[rules]\nenabled = ["base"]\n\n[skills]\nenabled = ["alpha"]\n'
    );
    installApps(homes, 'claude-code');
    const codexRoot = path.join(homes.agentsHome, '.codex');
    const codexPartner = path.join(homes.agentsHome, '.codex-loop');
    fs.symlinkSync(codexPartner, codexRoot);
    fs.symlinkSync(codexRoot, codexPartner);
    const skillsDir = path.join(homes.agentsHome, '.claude', 'skills');
    const skillsPartner = path.join(homes.agentsHome, '.claude', 'skills-loop');
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.symlinkSync(skillsPartner, skillsDir);
    fs.symlinkSync(skillsDir, skillsPartner);

    // One pathological link must not disable syncing for everything else.
    const report = await runSync();

    const rules = report.entries.find(
      (entry) => entry.app === 'claude-code' && entry.type === 'rules'
    );
    assert.equal(rules?.outcome, 'written');
    const skill = report.entries.find(
      (entry) => entry.app === 'claude-code' && entry.type === 'skills' && entry.id === 'alpha'
    );
    assert.equal(skill?.outcome, 'blocked');
    assert.equal(skill?.detail, 'path-escape');
    const codex = report.entries.find((entry) => entry.app === 'codex');
    assert.equal(codex?.outcome, 'skipped');
    assert.equal(codex?.detail, 'app-not-installed');
    assert.equal(report.exitCode, 1);
  });
});
