import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { distributeCommands, resolveCommandFilePath } from '../src/commands/distribution.js';
import { buildCommandInventory } from '../src/commands/inventory.js';
import { ensureCommandsDirectory } from '../src/commands/library.js';
import { renderDefaultCommandTemplate } from '../src/commands/template.js';
import { loadLibraryStateSection, updateLibraryStateSection } from '../src/library/state.js';
import { distributeSubagents, resolveSubagentFilePath } from '../src/subagents/distribution.js';
import { buildSubagentInventory } from '../src/subagents/inventory.js';
import { ensureSubagentsDirectory } from '../src/subagents/library.js';
import { renderDefaultSubagentTemplate } from '../src/subagents/template.js';

import { withTempHomes } from './helpers/tmp.js';

// End-to-end smoke test covering: add -> select -> propagate -> list -> state
// Uses system temp dir via withTempHomes; keeps assertions minimal and readable.

test('e2e: library -> state -> distribution -> inventory', () => {
  withTempHomes(() => {
    // 1) Scaffold sample command and subagent into library
    const cmdDir = ensureCommandsDirectory();
    const subDir = ensureSubagentsDirectory();

    const cmdId = 'explain';
    const subId = 'strict-code-reviewer';

    fs.writeFileSync(path.join(cmdDir, `${cmdId}.md`), renderDefaultCommandTemplate());
    fs.writeFileSync(path.join(subDir, `${subId}.md`), renderDefaultSubagentTemplate());

    // 2) Activate with ordering in state
    updateLibraryStateSection('commands', () => ({ active: [cmdId], agentSync: {} }));
    updateLibraryStateSection('subagents', () => ({ active: [subId], agentSync: {} }));

    // 3) Propagate to all supported platforms
    const cOutcome = distributeCommands();
    const sOutcome = distributeSubagents();

    // Expect at least one write per aggregate
    assert.ok(cOutcome.results.some((r) => r.status === 'written' || r.status === 'skipped'));
    assert.ok(sOutcome.results.some((r) => r.status === 'written' || r.status === 'skipped'));

    // Files exist for common platforms
    for (const p of ['claude-code', 'codex', 'gemini', 'opencode'] as const) {
      const out = resolveCommandFilePath(p, cmdId);
      assert.equal(fs.existsSync(out), true, `command output missing for ${p}`);
    }
    for (const p of ['claude-code', 'opencode'] as const) {
      const out = resolveSubagentFilePath(p, subId);
      assert.equal(fs.existsSync(out), true, `subagent output missing for ${p}`);
    }

    // 4) Inventory reflects activation and extras presence
    const cmdInv = buildCommandInventory();
    const subInv = buildSubagentInventory();

    const activeCmd = cmdInv.entries.find((e) => e.id === cmdId);
    assert.ok(activeCmd && activeCmd.active === true);
    assert.ok(Array.isArray(activeCmd?.extrasKeys));

    const activeSub = subInv.entries.find((e) => e.id === subId);
    assert.ok(activeSub && activeSub.active === true);
    assert.ok(Array.isArray(activeSub?.extrasKeys));

    // 5) State hashes were written for platforms
    const cmdState = loadLibraryStateSection('commands');
    const subState = loadLibraryStateSection('subagents');

    for (const p of ['claude-code', 'codex', 'gemini', 'opencode'] as const) {
      const sync = cmdState.agentSync[p];
      assert.ok(sync && typeof sync.hash === 'string');
    }
    for (const p of ['claude-code', 'opencode'] as const) {
      const sync = subState.agentSync[p];
      assert.ok(sync && typeof sync.hash === 'string');
    }

    // 6) Second run should mostly be skipped
    const cOutcome2 = distributeCommands();
    const sOutcome2 = distributeSubagents();
    assert.ok(cOutcome2.results.every((r) => r.status === 'skipped'));
    assert.ok(sOutcome2.results.every((r) => r.status === 'skipped'));
  });
});
