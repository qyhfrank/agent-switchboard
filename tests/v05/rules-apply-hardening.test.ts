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
  seedSkill,
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

test('a stale lock from a dead process fails closed and names the holder', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    fs.mkdirSync(homes.stateHome, { recursive: true });
    const lockFile = path.join(homes.stateHome, 'run.lock');
    const dead = deadPid();
    fs.writeFileSync(lockFile, `${dead} test\n`);
    ageFile(lockFile, 20);

    // No automatic reaping: any steal of the live path races a concurrent
    // O_EXCL create, so the run stops and tells the user what to remove.
    await assert.rejects(() => runSync(), new RegExp(`${dead}.*not running`));
    assert.equal(fs.existsSync(ruleFilePath(homes, 'codex')), false, 'nothing written');
    assert.equal(fs.existsSync(lockFile), true, 'lock left for manual removal');

    fs.unlinkSync(lockFile);
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

test('a symlinked target writes through the link and keeps it on removal', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    const backing = path.join(homes.root, 'mackup-store', 'AGENTS.md');
    fs.mkdirSync(path.dirname(backing), { recursive: true });
    fs.writeFileSync(backing, 'old hand-managed content\n');
    const target = ruleFilePath(homes, 'codex');
    fs.symlinkSync(backing, target);

    const report = await runSync();
    assert.equal(report.exitCode, 0);
    assert.equal(
      fs.readFileSync(backing, 'utf-8'),
      `${renderedRules('codex', 'Always be kind.\n')}\nold hand-managed content\n`,
      'written through the link, above the bytes already there'
    );
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'target is still the user link');

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

test('a dangling symlinked target is written through, creating the backing file', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    const backing = path.join(homes.root, 'dotfiles-store', 'AGENTS.md');
    fs.mkdirSync(path.dirname(backing), { recursive: true });
    const target = ruleFilePath(homes, 'codex');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(backing, target);
    fs.rmSync(backing, { force: true });

    const report = await runSync();
    assert.equal(report.exitCode, 0);

    // 0.4's writeFileSync followed the dangling link and created the backing
    // file; replacing the link with a plain file would break the dotfiles
    // setup the user built the link for.
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the link survives');
    assert.equal(
      fs.readFileSync(backing, 'utf-8'),
      renderedRules('codex', 'Always be kind.\n'),
      'the backing file was created through the link'
    );
  });
});

test('a symlink cycle at the target fails the entry and never replaces the link', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, CODEX_CONFIG);
    installApps(homes, 'codex');
    const target = ruleFilePath(homes, 'codex');
    const partner = path.join(path.dirname(target), 'loop-partner');
    fs.symlinkSync(partner, target);
    fs.symlinkSync(target, partner);

    const report = await runSync();

    // 0.4's writeFileSync threw ELOOP; the entry fails and the link survives.
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
    seedRule(homes, 'base.md', 'Always be kind.\n');
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
