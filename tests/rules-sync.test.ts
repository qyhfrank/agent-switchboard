import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import type { Report } from '../src/engine/report.js';
import {
  detectDir,
  entryFor,
  installApps,
  RULE_APPS,
  type RuleAppId,
  renderedRules,
  ruleFilePath,
  type ScratchHomes,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const COMPOSED_V1 = 'First version\n\nBeta body\n';
const COMPOSED_V2 = 'Second version\n\nBeta body\n';

function seedTwoRules(homes: ScratchHomes): void {
  seedRule(homes, 'alpha.md', '---\ntitle: Alpha\n---\nFirst version\n');
  seedRule(homes, 'beta.md', 'Beta body\n');
}

function configFor(apps: readonly string[], rules: readonly string[]): string {
  const appList = apps.map((id) => `"${id}"`).join(', ');
  const ruleList = rules.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${appList}]\n\n[rules]\nenabled = [${ruleList}]\n`;
}

function rulesRows(report: Report) {
  return report.entries.filter((entry) => entry.type === 'rules');
}

test('first sync writes composed rules to every enabled installed app', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, ...RULE_APPS, 'claude-desktop');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor([...RULE_APPS, 'claude-desktop'], ['alpha', 'beta']));

    const report = await runSync();

    for (const app of RULE_APPS) {
      const entry = entryFor(report, { app, type: 'rules' });
      assert.ok(entry, `expected a rules entry for ${app}`);
      assert.equal(entry.outcome, 'written', app);
      assert.equal(entry.detail, 'created', app);
      assert.equal(entry.path, ruleFilePath(homes, app));
      assert.equal(
        fs.readFileSync(ruleFilePath(homes, app), 'utf-8'),
        renderedRules(app, COMPOSED_V1),
        app
      );
    }
    // An app whose table row has no rules cell contributes no rules action.
    assert.equal(entryFor(report, { app: 'claude-desktop', type: 'rules' }), undefined);
    // The dedicated target is alone in its directory: no prefixed sibling.
    assert.deepEqual(fs.readdirSync(path.dirname(ruleFilePath(homes, 'cursor'))), ['rules.mdc']);
    assert.equal(report.exitCode, 0);
  });
});

test('editing a rule updates every target and an unedited resync is unchanged', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'cursor'] as const;
    installApps(homes, ...apps);
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(apps, ['alpha', 'beta']));

    // One target already carries a region holding an older composition.
    const shared = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, renderedRules('claude-code', 'Old composed output\n'), 'utf-8');

    const first = await runSync();
    assert.equal(entryFor(first, { app: 'claude-code', type: 'rules' })?.detail, 'updated');
    assert.equal(fs.readFileSync(shared, 'utf-8'), renderedRules('claude-code', COMPOSED_V1));
    assert.equal(first.exitCode, 0);

    seedRule(homes, 'alpha.md', '---\ntitle: Alpha\n---\nSecond version\n');
    const second = await runSync();
    for (const app of apps) {
      const entry = entryFor(second, { app, type: 'rules' });
      assert.equal(entry?.outcome, 'written', app);
      assert.equal(entry?.detail, 'updated', app);
      assert.equal(
        fs.readFileSync(ruleFilePath(homes, app), 'utf-8'),
        renderedRules(app, COMPOSED_V2),
        app
      );
    }

    const third = await runSync();
    for (const app of apps) {
      assert.equal(entryFor(third, { app, type: 'rules' })?.outcome, 'unchanged', app);
    }
    assert.equal(third.exitCode, 0);
  });
});

test('byte-identical pre-existing targets are unchanged without rewriting', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'cursor'] as const;
    installApps(homes, ...apps);
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(apps, ['alpha', 'beta']));

    const before = new Map<RuleAppId, number>();
    for (const app of apps) {
      const filePath = ruleFilePath(homes, app);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, renderedRules(app, COMPOSED_V1), 'utf-8');
      before.set(app, fs.statSync(filePath).mtimeMs);
    }

    const report = await runSync();
    for (const app of apps) {
      assert.equal(entryFor(report, { app, type: 'rules' })?.outcome, 'unchanged', app);
      assert.equal(fs.statSync(ruleFilePath(homes, app)).mtimeMs, before.get(app), app);
    }
    assert.equal(report.exitCode, 0);

    const second = await runSync();
    for (const app of apps) {
      assert.equal(entryFor(second, { app, type: 'rules' })?.outcome, 'unchanged', app);
    }
  });
});

test('a still-selected rule that composes to empty bytes leaves no empty region', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'solo.md', 'Something worth writing\n');
    writeUserConfig(homes, configFor(['claude-code'], ['solo']));

    await runSync();
    const filePath = ruleFilePath(homes, 'claude-code');
    assert.equal(fs.existsSync(filePath), true);

    // The rule empties while still selected. A region with nothing in it is
    // noise, so it goes, and the host goes with it because it held nothing
    // else. Giving the rule a body back restores both.
    seedRule(homes, 'solo.md', '');
    const report = await runSync();

    assert.equal(entryFor(report, { app: 'claude-code', type: 'rules' })?.outcome, 'removed');
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(report.exitCode, 0);

    seedRule(homes, 'solo.md', 'Something worth writing again\n');
    const restored = await runSync();
    assert.equal(entryFor(restored, { app: 'claude-code', type: 'rules' })?.outcome, 'written');
    assert.equal(
      fs.readFileSync(filePath, 'utf-8'),
      renderedRules('claude-code', 'Something worth writing again\n')
    );
  });
});

test('a malformed unselected rule fails alone while selected rules deploy', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    const brokenPath = seedRule(homes, 'broken.md', '---\ninvalid\n');
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));

    const report = await runSync();

    const failure = entryFor(report, { id: 'broken' });
    assert.ok(failure, 'expected an entry for the malformed rule');
    assert.equal(failure.outcome, 'failed');
    assert.equal(failure.detail, 'parse-error');
    assert.equal(failure.path, brokenPath);
    assert.match(failure.reason ?? '', /closing delimiter/);

    assert.equal(entryFor(report, { app: 'claude-code', type: 'rules' })?.outcome, 'written');
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      renderedRules('claude-code', 'Alpha body\n')
    );
    assert.equal(report.exitCode, 1);
  });
});

test('a dry run reports the actions the real run performs and writes nothing', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'cursor'] as const;
    installApps(homes, ...apps);
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(apps, ['alpha', 'beta']));

    const dry = await runSync({ dryRun: true });

    for (const app of apps) assert.equal(fs.existsSync(ruleFilePath(homes, app)), false, app);
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'ledger.json')), false);
    assert.equal(dry.exitCode, 0);

    const real = await runSync();
    const shape = (report: Report) =>
      rulesRows(report)
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

test('detect dirs alone never gain rule files when no rules are selected', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'cursor'] as const;
    installApps(homes, ...apps);
    writeUserConfig(homes, configFor(apps, []));

    const report = await runSync();

    for (const app of apps) assert.equal(fs.existsSync(ruleFilePath(homes, app)), false, app);
    assert.deepEqual(fs.readdirSync(detectDir(homes, 'cursor')), []);
    assert.equal(report.exitCode, 0);
  });
});

test('an atomic rewrite keeps the private mode the target already carried', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedRule(homes, 'private.md', 'First.\n');
    writeUserConfig(homes, configFor(['codex'], ['private']));
    assert.equal((await runSync()).exitCode, 0);

    const target = ruleFilePath(homes, 'codex');
    fs.chmodSync(target, 0o600);
    seedRule(homes, 'private.md', 'Second.\n');

    // The temp file is what the rename installs, so a widened temp would widen
    // the target: catch it at the rename rather than after the fact.
    const previousUmask = process.umask(0o022);
    const originalRename = fs.renameSync;
    let tempMode: number | undefined;
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (path.resolve(String(newPath)) === target) {
        tempMode = fs.statSync(oldPath).mode & 0o777;
      }
      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;
    try {
      assert.equal((await runSync()).exitCode, 0);
    } finally {
      fs.renameSync = originalRename;
      process.umask(previousUmask);
    }

    assert.equal(tempMode, 0o600);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  });
});
