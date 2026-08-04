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

function writeProfile(homes: Parameters<typeof seedRule>[0], name: string, toml: string): void {
  fs.writeFileSync(path.join(homes.asbHome, `${name}.toml`), toml, 'utf-8');
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

test('a profile syncs from its own file and retires what config.toml distributed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    assert.equal(fs.readFileSync(target, 'utf-8'), renderedRules('claude-code', 'First version\n'));

    writeProfile(homes, 'aws', configFor(['claude-code'], ['beta']));
    const profiled = await runSync({ profile: 'aws' });

    assert.equal(rulesEntry(profiled, 'claude-code')?.outcome, 'written');
    assert.equal(
      fs.readFileSync(target, 'utf-8'),
      renderedRules('claude-code', 'Beta body\n'),
      "the profile is the whole selection; config.toml's own is not read"
    );
    assert.equal(profiled.exitCode, 0);

    // A profile is which file the run reads, never a state the run records.
    const plain = await runSync();
    assert.equal(fs.readFileSync(target, 'utf-8'), renderedRules('claude-code', 'First version\n'));
    assert.equal(plain.exitCode, 0);
  });
});

test('a section absent from the profile selects nothing and the render proves the removal', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    assert.equal(fs.existsSync(target), true);

    writeProfile(homes, 'aws', '[applications]\nenabled = ["claude-code"]\n');
    const report = await runSync({ profile: 'aws' });

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'removed');
    assert.equal(fs.existsSync(target), false, 'nothing selected, and the render says it was ours');
    assert.equal(report.exitCode, 0);
  });
});

test('a profile enabling no applications reconciles nothing and the report says so', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    const distributed = fs.readFileSync(target, 'utf-8');

    // A selection with no applications has no reconciliation universe: the
    // run is a no-op, and without the row that reads as "nothing to do".
    writeProfile(homes, 'aws', '[rules]\nenabled = ["beta"]\n');
    const report = await runSync({ profile: 'aws' });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(rulesEntries(report), []);
    const idle = report.entries.find((entry) => entry.detail === 'no-applications');
    assert.ok(idle, JSON.stringify(report.entries, null, 2));
    assert.equal(idle.outcome, 'skipped');
    assert.equal(idle.path, path.join(homes.asbHome, 'aws.toml'));
    assert.match(idle.reason ?? '', /\[applications\]/);
    assert.equal(fs.readFileSync(target, 'utf-8'), distributed, 'and nothing was touched');
  });
});

test('a config.toml enabling no applications reports exactly what it always did', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    const distributed = fs.readFileSync(target, 'utf-8');

    // The row belongs to a profile, which is a selection the run was told to
    // read. A machine whose own configuration enables nothing is the run that
    // has always had nothing to do, and it reads the same as before.
    writeUserConfig(homes, '[rules]\nenabled = ["beta"]\n');
    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(
      report.entries.filter((entry) => entry.detail === 'no-applications'),
      []
    );
    assert.equal(fs.readFileSync(target, 'utf-8'), distributed);
  });
});

test('ASB_PROFILE picks the selection file -p would have named', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));
    writeProfile(homes, 'aws', configFor(['claude-code'], ['beta']));
    process.env.ASB_PROFILE = 'aws';

    const report = await runSync();

    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      renderedRules('claude-code', 'Beta body\n')
    );
    assert.equal(report.exitCode, 0);
  });
});

test('a profile naming a file that does not exist fails the run instead of reconciling nothing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));
    await runSync();
    const target = ruleFilePath(homes, 'claude-code');
    const distributed = fs.readFileSync(target, 'utf-8');

    const expected = path.join(homes.asbHome, 'nosuch.toml');
    for (const report of [
      await runSync({ profile: 'nosuch' }),
      await (async () => {
        process.env.ASB_PROFILE = 'nosuch';
        try {
          return await runSync();
        } finally {
          delete process.env.ASB_PROFILE;
        }
      })(),
    ]) {
      const row = report.entries.find((entry) => entry.detail === 'profile-missing');
      assert.ok(row, JSON.stringify(report.entries, null, 2));
      assert.equal(row.outcome, 'missing');
      assert.equal(row.id, 'nosuch');
      assert.equal(row.path, expected);
      assert.match(row.reason ?? '', /ASB_PROFILE/);
      assert.equal(report.exitCode, 1);
      assert.deepEqual(rulesEntries(report), [], 'an absent selection reconciles nothing');
      assert.equal(fs.readFileSync(target, 'utf-8'), distributed, 'and nothing was touched');
    }
  });
});

test('the repository region composes only the rules user scope does not already carry', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedTwoRules(homes);
    writeUserConfig(homes, configFor(['codex'], ['alpha']));
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, '.asb.toml'), '[rules]\nenabled = ["alpha", "beta"]\n');

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8'),
      renderedRules('codex', 'First version\n'),
      'the user phase never loads the project layer'
    );
    const repoRules = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf-8');
    assert.equal(
      repoRules,
      renderedRules('codex', 'Beta body\n'),
      'the repository carries only what it adds'
    );
    assert.ok(!repoRules.includes('First version'), 'agent context stops double-loading');

    assert.deepEqual(
      rulesEntries(report).map((entry) => ({ scope: entry.scope, path: entry.path })),
      [
        { scope: 'user', path: ruleFilePath(homes, 'codex') },
        { scope: 'project', path: path.join(project, 'AGENTS.md') },
      ],
      'every row says which scope it belongs to, user rows first'
    );
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
