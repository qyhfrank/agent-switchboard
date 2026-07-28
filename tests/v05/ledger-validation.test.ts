import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import { LedgerError, ledgerPath, loadLedger } from '../../src/engine/ledger.js';
import {
  installApps,
  type ScratchHomes,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * A ledger entry authorizes overwrites and deletions, so a semantically
 * corrupt one must abort the run (LedgerError, exit 2) before any write —
 * never feed the planner a shape it does not reason about.
 */

const CONFIG = '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n';

async function seededLedger(homes: ScratchHomes): Promise<string> {
  seedRule(homes, 'alpha.md', 'Be kind.\n');
  writeUserConfig(homes, CONFIG);
  installApps(homes, 'claude-code');
  await runSync();
  return ledgerPath(homes.stateHome);
}

function mutateLedger(filePath: string, mutate: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  mutate(raw);
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
}

const CORRUPTIONS: { name: string; entry: unknown }[] = [
  { name: 'a null entry', entry: null },
  {
    name: 'a relative path',
    entry: {
      app: 'claude-code',
      type: 'rules',
      id: null,
      path: 'relative/CLAUDE.md',
      shape: 'own-file',
      hash: 'abc',
      provenance: 'written',
      updatedAt: 'now',
    },
  },
  {
    name: 'a non-string hash',
    entry: {
      app: 'claude-code',
      type: 'rules',
      id: null,
      path: '/tmp/x',
      shape: 'own-file',
      hash: null,
      provenance: 'written',
      updatedAt: 'now',
    },
  },
  {
    name: 'an unknown provenance',
    entry: {
      app: 'claude-code',
      type: 'rules',
      id: null,
      path: '/tmp/x',
      shape: 'own-file',
      hash: 'abc',
      provenance: 'divine-right',
      updatedAt: 'now',
    },
  },
  {
    name: 'an escaping own-dir file list',
    entry: {
      app: 'claude-code',
      type: 'skills',
      id: 'x',
      path: '/tmp/x',
      shape: 'own-dir',
      hash: 'abc',
      files: ['ok.md', '../victim.txt'],
      provenance: 'written',
      updatedAt: 'now',
    },
  },
];

for (const corruption of CORRUPTIONS) {
  test(`a ledger with ${corruption.name} aborts the run before any write`, async () => {
    await withScratchHomes(async (homes) => {
      const filePath = await seededLedger(homes);
      const target = path.join(homes.agentsHome, '.claude', 'CLAUDE.md');
      const before = fs.readFileSync(target, 'utf-8');

      mutateLedger(filePath, (raw) => {
        (raw.entries as unknown[]).push(corruption.entry);
      });
      // The library moves on so a permitted run would rewrite the target.
      seedRule(homes, 'alpha.md', 'Changed content.\n');

      await assert.rejects(runSync(), (error: unknown) => {
        assert.ok(error instanceof LedgerError, 'fails closed as a LedgerError');
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /invalid entry/);
        return true;
      });
      assert.equal(fs.readFileSync(target, 'utf-8'), before, 'nothing was written');
    });
  });
}

test('an invalid lastRun record also fails closed', async () => {
  await withScratchHomes(async (homes) => {
    const filePath = await seededLedger(homes);
    mutateLedger(filePath, (raw) => {
      raw.lastRun = { at: 42 };
    });
    await assert.rejects(runSync(), /unrecognized lastRun/);
  });
});

test('a valid ledger still loads after the validation pass', async () => {
  await withScratchHomes(async (homes) => {
    const filePath = await seededLedger(homes);
    const ledger = loadLedger(path.dirname(filePath));
    assert.equal(ledger.version, 1);
    assert.ok(ledger.entries.length >= 1);
  });
});
