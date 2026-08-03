import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
  detectDir,
  installApps,
  RULE_APPS,
  type RuleAppId,
  renderedRules,
  ruleFilePath,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const COMPOSED_V1 = 'First version\n\nBeta body\n';
const COMPOSED_V2 = 'Second version\n\nBeta body\n';

function seedTwoRules(homes: Parameters<typeof seedRule>[0]): void {
  seedRule(homes, 'alpha.md', '---\ntitle: Alpha\n---\nFirst version\n');
  seedRule(homes, 'beta.md', 'Beta body\n');
}

function configFor(apps: readonly string[], rules: readonly string[], extra = ''): string {
  const appList = apps.map((id) => `"${id}"`).join(', ');
  const ruleList = rules.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${appList}]\n${extra}\n[rules]\nenabled = [${ruleList}]\n`;
}

function rulesEntry(report: Report, app: string): ReportEntry | undefined {
  return report.entries.find((entry) => entry.app === app && entry.type === 'rules');
}

function rulesEntries(report: Report): ReportEntry[] {
  return report.entries.filter((entry) => entry.type === 'rules');
}

test('first sync writes composed rules to every enabled installed app', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes);
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(RULE_APPS, ['alpha', 'beta']));

    const report = await runSync();

    for (const app of RULE_APPS) {
      const entry = rulesEntry(report, app);
      assert.ok(entry, `expected a rules entry for ${app}`);
      assert.equal(entry.outcome, 'written');
      assert.equal(entry.detail, 'created');
      assert.equal(entry.path, ruleFilePath(homes, app));
      const onDisk = fs.readFileSync(ruleFilePath(homes, app), 'utf-8');
      assert.equal(onDisk, renderedRules(app, COMPOSED_V1));
    }
    assert.equal(report.exitCode, 0);
  });
});

test('editing a rule updates targets and an unedited resync is unchanged', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code', 'cursor'], ['alpha', 'beta']));

    await runSync();
    seedRule(homes, 'alpha.md', '---\ntitle: Alpha\n---\nSecond version\n');

    const second = await runSync();
    for (const app of ['claude-code', 'cursor'] as const) {
      const entry = rulesEntry(second, app);
      assert.equal(entry?.outcome, 'written');
      assert.equal(entry?.detail, 'updated');
      assert.equal(
        fs.readFileSync(ruleFilePath(homes, app), 'utf-8'),
        renderedRules(app, COMPOSED_V2)
      );
    }

    const third = await runSync();
    for (const app of ['claude-code', 'cursor'] as const) {
      assert.equal(rulesEntry(third, app)?.outcome, 'unchanged');
    }
    assert.equal(third.exitCode, 0);
  });
});

test('byte-identical pre-existing targets are unchanged without rewriting', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code', 'cursor'], ['alpha', 'beta']));

    const before = new Map<RuleAppId, number>();
    for (const app of ['claude-code', 'cursor'] as const) {
      const filePath = ruleFilePath(homes, app);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, renderedRules(app, COMPOSED_V1), 'utf-8');
      before.set(app, fs.statSync(filePath).mtimeMs);
    }

    const report = await runSync();
    for (const app of ['claude-code', 'cursor'] as const) {
      const entry = rulesEntry(report, app);
      assert.equal(entry?.outcome, 'unchanged');
      assert.equal(fs.statSync(ruleFilePath(homes, app)).mtimeMs, before.get(app));
    }
    assert.equal(report.exitCode, 0);

    const second = await runSync();
    for (const app of ['claude-code', 'cursor'] as const) {
      assert.equal(rulesEntry(second, app)?.outcome, 'unchanged');
    }
  });
});

test('a shared target holding an older composition is rewritten in one sync', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));

    const filePath = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderedRules('claude-code', 'Old composed output\n'), 'utf-8');

    const report = await runSync();
    const entry = rulesEntry(report, 'claude-code');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), renderedRules('claude-code', COMPOSED_V1));
    assert.equal(report.exitCode, 0);
  });
});

test('hand-written bytes at a shared target survive both the write and the removal', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));

    const filePath = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'Hand-written notes asb never wrote\n', 'utf-8');

    await runSync();
    assert.match(fs.readFileSync(filePath, 'utf-8'), /Hand-written notes asb never wrote/);

    writeUserConfig(homes, configFor(['claude-code'], []));
    const report = await runSync();

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'removed');
    assert.equal(
      fs.readFileSync(filePath, 'utf-8'),
      'Hand-written notes asb never wrote\n',
      'only the marked region is asb to take'
    );

    // Nothing of asb's is left in the file, so later runs stay silent.
    const later = await runSync();
    assert.equal(rulesEntry(later, 'claude-code'), undefined);
    assert.equal(fs.existsSync(filePath), true);
  });
});

test('a still-selected rule that composes to empty bytes leaves no empty region', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'solo.md', 'Something worth writing\n');
    writeUserConfig(
      homes,
      `[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["solo"]\nincludeDelimiters = false\n`
    );

    await runSync();
    const filePath = ruleFilePath(homes, 'claude-code');
    assert.equal(fs.existsSync(filePath), true);

    // The rule file becomes empty while still selected. A region with nothing
    // in it is noise, so it goes; the file itself goes with it because it held
    // nothing else. Giving the rule a body back restores both.
    seedRule(homes, 'solo.md', '');
    const report = await runSync();

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'removed');
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(report.exitCode, 0);

    seedRule(homes, 'solo.md', 'Something worth writing again\n');
    const restored = await runSync();
    assert.equal(rulesEntry(restored, 'claude-code')?.outcome, 'written');
    assert.equal(
      fs.readFileSync(filePath, 'utf-8'),
      renderedRules('claude-code', 'Something worth writing again\n')
    );
  });
});

test('deselecting every rule removes only what asb wrote', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor', 'trae');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code', 'cursor', 'trae'], ['alpha', 'beta']));

    await runSync();
    writeUserConfig(homes, configFor(['claude-code', 'cursor', 'trae'], []));

    const report = await runSync();
    for (const app of ['claude-code', 'cursor', 'trae'] as const) {
      const entry = rulesEntry(report, app);
      assert.equal(entry?.outcome, 'removed');
      assert.equal(fs.existsSync(ruleFilePath(homes, app)), false);
    }
    assert.equal(report.exitCode, 0);
  });
});

test('a hand-authored file at a shared target with nothing selected is untouched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(homes, configFor(['claude-code'], []));

    const filePath = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'My own global notes.\n', 'utf-8');

    const report = await runSync();

    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'My own global notes.\n');
    const destructive = report.entries.find(
      (entry) =>
        entry.path === filePath && (entry.outcome === 'written' || entry.outcome === 'removed')
    );
    assert.equal(destructive, undefined);
    assert.equal(report.exitCode, 0);
  });
});

test('an enabled app that is not detected is skipped with the assume_installed pointer', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code', 'opencode'], ['alpha', 'beta']));

    const report = await runSync();

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'written');
    const skipped = report.entries.find(
      (entry) => entry.app === 'opencode' && entry.outcome === 'skipped'
    );
    assert.ok(skipped, 'expected a skipped entry for the undetected app');
    assert.equal(skipped.detail, 'app-not-installed');
    assert.match(skipped.reason ?? '', /assume_installed/);
    assert.equal(fs.existsSync(ruleFilePath(homes, 'opencode')), false);
    assert.equal(report.exitCode, 0);
  });
});

test('assume_installed forces distribution to an undetected app', async () => {
  await withScratchHomes(async (homes) => {
    seedTwoRules(homes);
    writeUserConfig(
      homes,
      configFor(['opencode'], ['alpha', 'beta'], 'assume_installed = ["opencode"]\n')
    );

    const report = await runSync();
    const entry = rulesEntry(report, 'opencode');
    assert.equal(entry?.outcome, 'written');
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'opencode'), 'utf-8'),
      renderedRules('opencode', COMPOSED_V1)
    );
    assert.equal(report.exitCode, 0);
  });
});

test('an app without a rules target contributes no rules actions', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'claude-desktop');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code', 'claude-desktop'], ['alpha', 'beta']));

    const report = await runSync();

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'written');
    assert.equal(rulesEntry(report, 'claude-desktop'), undefined);
    assert.equal(report.exitCode, 0);
  });
});

test('a corrupt ledger aborts the run before any write', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));

    await runSync();
    const ledgerPath = path.join(homes.stateHome, 'ledger.json');
    assert.ok(fs.existsSync(ledgerPath), 'expected the ledger in the state dir');

    seedRule(homes, 'alpha.md', '---\ntitle: Alpha\n---\nSecond version\n');
    fs.writeFileSync(ledgerPath, '{corrupt', 'utf-8');

    const bytesBefore = fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8');
    await assert.rejects(() => runSync(), /ledger/i);
    assert.equal(fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'), bytesBefore);
  });
});

test('an enabled rule missing from the library blocks the aggregate and touches nothing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'ghost']));

    const report = await runSync();

    const missing = report.entries.find(
      (entry) => entry.id === 'ghost' && entry.outcome === 'missing'
    );
    assert.ok(missing, 'expected a missing entry for the absent rule');

    const appEntry = rulesEntry(report, 'claude-code');
    assert.equal(appEntry?.outcome, 'failed');
    assert.equal(appEntry?.detail, 'aggregate-blocked');
    assert.match(appEntry?.reason ?? '', /ghost/);
    assert.equal(fs.existsSync(ruleFilePath(homes, 'claude-code')), false);
    assert.equal(report.exitCode, 1);
  });
});

test('a malformed unselected rule fails alone while selected rules deploy', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    seedRule(homes, 'broken.md', '---\ninvalid\n');
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));

    const report = await runSync();

    const failure = report.entries.find(
      (entry) => entry.id === 'broken' && entry.outcome === 'failed'
    );
    assert.ok(failure, 'expected a failed entry for the malformed rule');
    assert.equal(failure.detail, 'parse-error');
    assert.match(failure.reason ?? '', /closing delimiter/);

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'written');
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      renderedRules('claude-code', 'Alpha body\n')
    );
    assert.equal(report.exitCode, 1);
  });
});

test('dry-run reports the same actions the real run performs and writes nothing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code', 'cursor'], ['alpha', 'beta']));

    const dry = await runSync({ dryRun: true });

    for (const app of ['claude-code', 'cursor'] as const) {
      assert.equal(fs.existsSync(ruleFilePath(homes, app)), false);
    }
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'ledger.json')), false);
    assert.equal(dry.exitCode, 0);

    const real = await runSync();

    const shape = (report: Report) =>
      rulesEntries(report)
        .map((entry) => ({
          app: entry.app,
          path: entry.path,
          outcome: entry.outcome,
          detail: entry.detail,
        }))
        .sort((a, b) => String(a.app).localeCompare(String(b.app)));
    assert.deepEqual(shape(dry), shape(real));
  });
});

test('detect dirs alone never gain rule files when no rules exist', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    writeUserConfig(homes, configFor(['claude-code', 'cursor'], []));

    const report = await runSync();

    assert.equal(fs.existsSync(ruleFilePath(homes, 'claude-code')), false);
    assert.equal(fs.existsSync(ruleFilePath(homes, 'cursor')), false);
    assert.deepEqual(fs.readdirSync(detectDir(homes, 'cursor')), []);
    assert.equal(report.exitCode, 0);
  });
});
