import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import { type Report, renderReport } from '../src/engine/report.js';
import {
  entryFor,
  installApps,
  type ScratchHomes,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function config(opts: {
  apps: readonly string[];
  skills: readonly string[];
  shared?: boolean;
  extra?: string;
}): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  const lines = [
    '[applications]',
    `enabled = [${list(opts.apps)}]`,
    '',
    '[skills]',
    `enabled = [${list(opts.skills)}]`,
  ];
  if (!opts.shared) {
    for (const app of opts.apps.filter((app) => ['codex', 'opencode', 'cursor'].includes(app))) {
      lines.push('', `[applications.${app}.skills]`, 'destination = "own"');
    }
  }
  if (opts.extra) lines.push('', opts.extra);
  return `${lines.join('\n')}\n`;
}

function unionBundle(homes: ScratchHomes, id: string): string {
  return path.join(skillsParentDir(homes, 'agents'), id);
}

function skillEntry(report: Report, app: string, id: string) {
  return entryFor(report, { app, type: 'skills', id });
}

function exists(...segments: string[]): boolean {
  return fs.existsSync(path.join(...segments));
}

test('foreign shared bundles survive dry runs and sync while own replacements stay available', async () => {
  for (const scope of ['user', 'project'] as const) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'cursor', 'opencode');
      seedSkill(homes, 'review');
      const project = scope === 'project' ? path.join(homes.root, 'project') : undefined;
      if (project) fs.mkdirSync(project);
      const configure = (shared: boolean) => {
        const selection = config({ apps: ['cursor', 'opencode'], skills: ['review'], shared });
        if (project) {
          writeUserConfig(homes, '[applications]\nenabled = ["cursor", "opencode"]\n');
          fs.writeFileSync(
            path.join(project, '.asb.toml'),
            `${selection}[distribution.project]\ncollision = "takeover"\n`
          );
        } else writeUserConfig(homes, selection);
      };
      configure(false);
      assert.equal((await runSync({ project })).exitCode, 0);
      const own = ['cursor', 'opencode'].map((app) =>
        path.join(
          project
            ? path.join(project, `.${app}`, 'skills')
            : skillsParentDir(homes, app as 'cursor' | 'opencode'),
          'review',
          'SKILL.md'
        )
      );
      const originals = own.map((file) => fs.readFileSync(file, 'utf8'));
      const foreign = project
        ? path.join(project, '.agents', 'skills', 'review')
        : unionBundle(homes, 'review');
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'Personal instructions\n');
      fs.writeFileSync(path.join(foreign, 'notes.txt'), 'Personal notes\n');
      configure(true);
      for (const dryRun of [true, false, false]) {
        const report = await runSync({ project, dryRun });
        const row = report.entries.find((entry) => entry.path === foreign);
        assert.equal(row?.outcome, 'conflict');
        assert.equal(row?.detail, 'foreign');
        assert.equal(
          fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'),
          'Personal instructions\n'
        );
        assert.equal(fs.readFileSync(path.join(foreign, 'notes.txt'), 'utf8'), 'Personal notes\n');
        assert.deepEqual(
          own.map((file) => fs.readFileSync(file, 'utf8')),
          originals
        );
      }
    });
  }
});

test('default skills destinations share native readers and keep Claude in its own directory', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex', 'opencode', 'cursor', 'pi', 'dsh');
    seedSkill(homes, 'review');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code", "codex", "opencode", "cursor", "pi", "dsh"]\n[skills]\nenabled = ["review"]\n'
    );
    const report = await runSync();
    assert.equal(report.exitCode, 0);
    assert.ok(exists(unionBundle(homes, 'review'), 'SKILL.md'));
    assert.ok(exists(skillsParentDir(homes, 'claude-code'), 'review', 'SKILL.md'));
    for (const app of ['codex', 'opencode', 'cursor', 'pi', 'dsh'] as const) {
      assert.equal(exists(skillsParentDir(homes, app)), false, app);
    }
    assert.equal(report.entries.filter((entry) => entry.outcome === 'written').length, 2);
    const states = fs
      .readdirSync(path.join(homes.stateHome, 'distribution'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(homes.stateHome, 'distribution', name), 'utf8'))
      );
    assert.ok(states.every((state) => state.version === 1));
    assert.deepEqual(
      states.flatMap((state) => state.slices).find((slice) => slice.app === 'agents').members,
      ['codex', 'opencode', 'cursor', 'pi', 'dsh']
    );
  });
});

test('an own destination writes Cursor separately while other readers keep the shared copy', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex', 'opencode', 'cursor', 'pi', 'dsh');
    seedSkill(homes, 'review');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code", "codex", "opencode", "cursor", "pi", "dsh"]\n[skills]\nenabled = ["review"]\n[applications.cursor.skills]\ndestination = "own"\n'
    );
    assert.equal((await runSync()).exitCode, 0);
    for (const app of ['agents', 'claude-code', 'cursor'] as const)
      assert.ok(exists(skillsParentDir(homes, app), 'review', 'SKILL.md'));
    for (const app of ['codex', 'opencode', 'pi', 'dsh'] as const)
      assert.equal(exists(skillsParentDir(homes, app)), false);
  });
});

test('a per-app remove moves a shared skill only to the readers still selecting it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'cursor');
    for (const id of ['alpha', 'beta']) seedSkill(homes, id);
    const base =
      '[applications]\nenabled = ["codex", "cursor"]\n[skills]\nenabled = ["alpha", "beta"]\n';
    writeUserConfig(homes, base);
    await runSync();
    writeUserConfig(homes, `${base}[applications.cursor.skills]\nremove = ["beta"]\n`);
    await runSync();
    const settled = await runSync();
    assert.equal(settled.exitCode, 0);
    assert.ok(exists(unionBundle(homes, 'alpha'), 'SKILL.md'));
    assert.equal(exists(unionBundle(homes, 'beta')), false);
    assert.ok(exists(skillsParentDir(homes, 'codex'), 'beta', 'SKILL.md'));
    assert.equal(exists(skillsParentDir(homes, 'cursor'), 'beta'), false);
  });
});

test('a reader without an own directory warns about its remainder and continues', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });
    for (const id of ['common', 'extra']) seedSkill(homes, id);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex", "traecli"]\n[skills]\nenabled = ["common"]\n[applications.traecli.skills]\nadd = ["extra"]\n'
    );
    const report = await runSync();
    assert.equal(report.exitCode, 0);
    const warning = skillEntry(report, 'traecli', 'extra');
    assert.equal(warning?.outcome, 'skipped');
    assert.equal(warning?.detail, 'no-own-destination');
    assert.match(warning?.reason ?? '', /traecli.*extra.*no own skills directory/);
    assert.ok(exists(unionBundle(homes, 'common'), 'SKILL.md'));
    assert.equal(exists(unionBundle(homes, 'extra')), false);
    assert.match(
      renderReport(report, { layout: 'interactive', color: false, command: 'sync' }),
      /needs attention/
    );
    assert.match(renderReport(report), /traecli[\s\S]*extra/);
  });
});

test('destination validation rejects unsupported readers and an own directory that does not exist', async () => {
  await withScratchHomes(async (homes) => {
    for (const app of ['claude-code', 'trae', 'claude-desktop', 'traecli']) {
      writeUserConfig(
        homes,
        `[applications]\nenabled = ["${app}"]\n[applications.${app}.skills]\ndestination = "own"\n`
      );
      await assert.rejects(runSync(), /skills do not support destination/);
    }
    writeUserConfig(homes, '[applications.claude-code.skills]\ndestination = "shared"\n');
    await assert.rejects(runSync(), /skills do not support destination/);
  });
});

test('moving own copies preserves edits and unrecorded neighbours after the shared copy lands', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor', 'opencode');
    for (const id of ['clean', 'edited']) seedSkill(homes, id);
    writeUserConfig(homes, config({ apps: ['cursor', 'opencode'], skills: ['clean', 'edited'] }));
    await runSync();
    for (const app of ['cursor', 'opencode'] as const) {
      fs.writeFileSync(
        path.join(skillsParentDir(homes, app), 'edited', 'SKILL.md'),
        'User changes\n'
      );
      fs.mkdirSync(path.join(skillsParentDir(homes, app), 'foreign'));
      fs.writeFileSync(path.join(skillsParentDir(homes, app), 'foreign', 'notes.md'), 'Keep\n');
    }
    writeUserConfig(
      homes,
      config({ apps: ['cursor', 'opencode'], skills: ['clean', 'edited'], shared: true })
    );
    await runSync();
    const settled = await runSync();
    assert.equal(settled.exitCode, 0);
    for (const app of ['cursor', 'opencode'] as const) {
      assert.equal(exists(skillsParentDir(homes, app), 'clean'), false);
      assert.equal(
        fs.readFileSync(path.join(skillsParentDir(homes, app), 'edited', 'SKILL.md'), 'utf8'),
        'User changes\n'
      );
      assert.equal(skillEntry(settled, app, 'edited')?.outcome, 'left-behind');
      assert.equal(
        fs.readFileSync(path.join(skillsParentDir(homes, app), 'foreign', 'notes.md'), 'utf8'),
        'Keep\n'
      );
    }
    for (const id of ['clean', 'edited']) assert.ok(exists(unionBundle(homes, id), 'SKILL.md'));
  });
});

test('the shared directory holds the intersection and each own directory holds its remainder', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'opencode', 'claude-code');
    for (const id of ['alpha', 'beta', 'gamma']) seedSkill(homes, id);
    writeUserConfig(
      homes,
      config({
        apps: ['codex', 'opencode', 'claude-code'],
        skills: ['alpha'],
        shared: true,
        extra:
          '[applications.codex.skills]\nadd = ["beta"]\n\n[applications.opencode.skills]\nadd = ["gamma"]',
      })
    );

    const report = await runSync();

    // One copy per selected skill, in the one directory every member reads.
    for (const id of ['alpha'] as const) {
      const entry = skillEntry(report, 'agents', id);
      assert.equal(entry?.outcome, 'written', id);
      assert.equal(entry?.detail, 'created', id);
      assert.equal(entry?.path, unionBundle(homes, id));
      assert.equal(exists(unionBundle(homes, id), 'SKILL.md'), true);
    }

    for (const [member, id] of [
      ['codex', 'beta'],
      ['opencode', 'gamma'],
    ] as const) {
      assert.equal(exists(skillsParentDir(homes, member), id, 'SKILL.md'), true);
      assert.equal(exists(skillsParentDir(homes, member), 'alpha'), false);
      assert.equal(exists(unionBundle(homes, id)), false);
    }
    assert.equal(skillEntry(report, 'claude-code', 'alpha')?.outcome, 'written');
    assert.equal(exists(skillsParentDir(homes, 'claude-code'), 'alpha', 'SKILL.md'), true);
    assert.equal(exists(skillsParentDir(homes, 'claude-code'), 'beta'), false);
    assert.equal(report.exitCode, 0);
  });
});

test('switching to shared destinations removes the per-app copies once the union copy is proven', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'] }));

    const first = await runSync();
    const codexCopy = path.join(skillsParentDir(homes, 'codex'), 'alpha');
    assert.equal(skillEntry(first, 'codex', 'alpha')?.outcome, 'written');
    assert.equal(fs.existsSync(codexCopy), true);

    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], shared: true }));
    const second = await runSync();

    // The old copy leaves only after the union copy is proven on disk, so
    // this run defers the removal and the next one performs it.
    const deferred = skillEntry(second, 'codex', 'alpha');
    assert.equal(deferred?.outcome, 'skipped');
    assert.equal(deferred?.detail, 'not-selected');
    assert.equal(fs.existsSync(codexCopy), true, 'kept until the union copy lands');
    assert.equal(skillEntry(second, 'agents', 'alpha')?.outcome, 'written');
    assert.equal(exists(unionBundle(homes, 'alpha'), 'SKILL.md'), true);
    assert.equal(second.exitCode, 0);

    const third = await runSync();
    assert.equal(skillEntry(third, 'codex', 'alpha')?.outcome, 'removed');
    assert.equal(fs.existsSync(codexCopy), false);
    assert.equal(skillEntry(third, 'agents', 'alpha')?.outcome, 'unchanged');
    assert.equal(third.exitCode, 0);

    const fourth = await runSync();
    assert.equal(skillEntry(fourth, 'agents', 'alpha')?.outcome, 'unchanged');
    assert.equal(skillEntry(fourth, 'codex', 'alpha'), undefined, 'the removed copy stays gone');
  });
});

test('switching to own destinations restores the per-app copies before the union ones leave', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    seedSkill(homes, 'beta');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha', 'beta'], shared: true }));

    await runSync();
    assert.equal(fs.existsSync(unionBundle(homes, 'alpha')), true);
    // A union copy edited by hand can no longer be removed on byte proof.
    fs.writeFileSync(path.join(unionBundle(homes, 'beta'), 'SKILL.md'), 'hand-edited\n');

    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha', 'beta'], shared: false }));
    const report = await runSync();

    // Moving back to own directories: the per-app copy is written first, and the
    // union copy leaves on the following run once that copy is proven.
    for (const id of ['alpha', 'beta'] as const) {
      assert.equal(skillEntry(report, 'agents', id)?.outcome, 'skipped', id);
      assert.equal(fs.existsSync(unionBundle(homes, id)), true, id);
      assert.equal(skillEntry(report, 'codex', id)?.outcome, 'written', id);
      assert.equal(exists(skillsParentDir(homes, 'codex'), id, 'SKILL.md'), true);
    }
    assert.equal(
      fs.readFileSync(path.join(unionBundle(homes, 'beta'), 'SKILL.md'), 'utf-8'),
      'hand-edited\n',
      'the held copy is not touched while it is still the only one'
    );
    assert.equal(report.exitCode, 0);

    const second = await runSync();

    assert.equal(skillEntry(second, 'agents', 'alpha')?.outcome, 'removed');
    assert.equal(skillEntry(second, 'agents', 'alpha')?.detail, undefined, 'removed on byte proof');
    assert.equal(skillEntry(second, 'agents', 'beta')?.outcome, 'left-behind');
    for (const id of ['alpha', 'beta'] as const) {
      assert.equal(fs.existsSync(unionBundle(homes, id)), id === 'beta', id);
      assert.equal(skillEntry(second, 'codex', id)?.outcome, 'unchanged', id);
    }
    assert.equal(second.exitCode, 0);
  });
});

test('an app filter mid-migration never orphans the skill', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'] }));

    await runSync();
    const codexCopy = path.join(skillsParentDir(homes, 'codex'), 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], shared: true }));

    // The filter includes the shared destination through its reader membership.
    const filtered = await runSync({ apps: ['codex'] });

    const entry = skillEntry(filtered, 'codex', 'alpha');
    assert.equal(entry?.outcome, 'skipped');
    assert.equal(entry?.detail, 'not-selected');
    assert.equal(exists(codexCopy, 'SKILL.md'), true, 'copy intact');
    assert.equal(skillEntry(filtered, 'agents', 'alpha')?.outcome, 'written');
    assert.equal(filtered.exitCode, 0);

    const full = await runSync();
    assert.equal(skillEntry(full, 'agents', 'alpha')?.outcome, 'unchanged');
    const converged = await runSync();
    assert.equal(skillEntry(converged, 'codex', 'alpha'), undefined);
    assert.equal(exists(unionBundle(homes, 'alpha'), 'SKILL.md'), true);
  });
});

test('a failing union destination leaves the per-app copy in place', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'] }));

    await runSync();
    const codexCopy = path.join(skillsParentDir(homes, 'codex'), 'alpha');

    // ~/.agents already exists as a file: the union parent cannot be created.
    fs.writeFileSync(path.join(homes.agentsHome, '.agents'), 'not a directory\n');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], shared: true }));

    const report = await runSync();

    const union = skillEntry(report, 'agents', 'alpha');
    assert.equal(union?.outcome, 'failed');
    assert.equal(union?.detail, 'write-error');
    assert.equal(skillEntry(report, 'codex', 'alpha')?.outcome, 'skipped');
    assert.equal(exists(codexCopy, 'SKILL.md'), true, 'copy intact');
    assert.equal(report.exitCode, 1);

    // Unblock the destination: the migration completes over the next runs.
    fs.rmSync(path.join(homes.agentsHome, '.agents'));
    const unblocked = await runSync();
    assert.equal(skillEntry(unblocked, 'agents', 'alpha')?.outcome, 'written');
    assert.equal(skillEntry(unblocked, 'codex', 'alpha')?.outcome, 'skipped');
    const converged = await runSync();
    assert.equal(skillEntry(converged, 'codex', 'alpha')?.outcome, 'removed');
    assert.equal(converged.exitCode, 0);
  });
});

test('the union retires when disabled but survives an enabled member being undetected', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'claude-code');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], shared: true }));

    const first = await runSync();
    assert.equal(skillEntry(first, 'agents', 'alpha')?.outcome, 'written');
    const unionCopy = path.join(unionBundle(homes, 'alpha'), 'SKILL.md');
    assert.equal(fs.existsSync(unionCopy), true);

    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['alpha'], shared: true }));
    assert.equal(skillEntry(await runSync(), 'agents', 'alpha')?.outcome, 'removed');
    assert.equal(fs.existsSync(unionCopy), false);
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], shared: true }));
    await runSync();
    writeUserConfig(homes, config({ apps: ['traecli'], skills: ['alpha'], shared: true }));
    const dormant = await runSync();
    assert.equal(skillEntry(dormant, 'agents', 'alpha'), undefined);
    assert.equal(fs.existsSync(unionCopy), true);

    // A returning member finds the record intact: deselection still removes
    // with proof instead of rediscovering an unproven foreign tree.
    writeUserConfig(homes, config({ apps: ['codex'], skills: [], shared: true }));
    const cleanup = await runSync();
    assert.equal(skillEntry(cleanup, 'agents', 'alpha')?.outcome, 'removed');
    assert.equal(fs.existsSync(unionBundle(homes, 'alpha')), false, 'removed with proof');
  });
});

test('a member with no skills cell of its own reports missing skills only through the union', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });

    writeUserConfig(homes, config({ apps: ['traecli'], skills: ['ghost'], shared: true }));
    const routed = await runSync();

    assert.equal(routed.exitCode, 1);
    assert.ok(
      routed.entries.some(
        (entry) => entry.type === 'skills' && entry.id === 'ghost' && entry.outcome === 'missing'
      ),
      'the union gives the selection a destination, so the absent library skill is reported'
    );
  });
});
