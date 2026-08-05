import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import type { Report } from '../src/engine/report.js';
import {
  entryFor,
  installApps,
  type ScratchHomes,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * use_agents_dir: codex/gemini/opencode/traecli read skills from the shared
 * ~/.agents/skills directory. The union row distributes the union of the
 * ACTIVE members' effective selections; the members' own rows deselect, so
 * their stale copies leave through the proof-gated removal path.
 */

function config(opts: {
  apps: readonly string[];
  skills: readonly string[];
  agentsDir?: boolean;
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
  if (opts.agentsDir !== undefined) {
    lines.push('', '[distribution]', `use_agents_dir = ${opts.agentsDir}`);
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

test('the agents row writes the union of active member selections to the shared directory', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'gemini', 'opencode', 'claude-code');
    for (const id of ['alpha', 'beta', 'gamma']) seedSkill(homes, id);
    writeUserConfig(
      homes,
      config({
        apps: ['codex', 'gemini', 'opencode', 'claude-code'],
        skills: ['alpha'],
        agentsDir: true,
        extra:
          '[applications.gemini.skills]\nadd = ["beta"]\n\n[applications.opencode.skills]\nadd = ["gamma"]',
      })
    );

    const report = await runSync();

    // One copy per selected skill, in the one directory every member reads.
    for (const id of ['alpha', 'beta', 'gamma'] as const) {
      const entry = skillEntry(report, 'agents', id);
      assert.equal(entry?.outcome, 'written', id);
      assert.equal(entry?.detail, 'created', id);
      assert.equal(entry?.path, unionBundle(homes, id));
      assert.equal(exists(unionBundle(homes, id), 'SKILL.md'), true);
    }

    // The members' own parents get no copies; the non-member keeps its own.
    for (const member of ['codex', 'gemini', 'opencode'] as const) {
      assert.equal(fs.existsSync(skillsParentDir(homes, member)), false, member);
    }
    assert.equal(skillEntry(report, 'claude-code', 'alpha')?.outcome, 'written');
    assert.equal(exists(skillsParentDir(homes, 'claude-code'), 'alpha', 'SKILL.md'), true);
    assert.equal(exists(skillsParentDir(homes, 'claude-code'), 'beta'), false);
    assert.equal(report.exitCode, 0);
  });
});

test('turning use_agents_dir on removes the per-app copies once the union copy is proven', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'] }));

    const first = await runSync();
    const codexCopy = path.join(skillsParentDir(homes, 'codex'), 'alpha');
    assert.equal(skillEntry(first, 'codex', 'alpha')?.outcome, 'written');
    assert.equal(fs.existsSync(codexCopy), true);

    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));
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

test('turning use_agents_dir off restores the per-app copies before the union ones leave', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    seedSkill(homes, 'beta');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha', 'beta'], agentsDir: true }));

    await runSync();
    assert.equal(fs.existsSync(unionBundle(homes, 'alpha')), true);
    // A union copy edited by hand can no longer be removed on byte proof.
    fs.writeFileSync(path.join(unionBundle(homes, 'beta'), 'SKILL.md'), 'hand-edited\n');

    writeUserConfig(
      homes,
      config({ apps: ['codex'], skills: ['alpha', 'beta'], agentsDir: false })
    );
    const report = await runSync();

    // Mirror image of toggle-on: the per-app copy is written first, and the
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
    assert.equal(skillEntry(second, 'agents', 'beta')?.outcome, 'removed');
    assert.equal(skillEntry(second, 'agents', 'beta')?.detail, 'stale-copy');
    for (const id of ['alpha', 'beta'] as const) {
      assert.equal(fs.existsSync(unionBundle(homes, id)), false, id);
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
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));

    // The filter drops the union write; the deferred removal must not fire.
    const filtered = await runSync({ apps: ['codex'] });

    const entry = skillEntry(filtered, 'codex', 'alpha');
    assert.equal(entry?.outcome, 'skipped');
    assert.equal(entry?.detail, 'not-selected');
    assert.equal(exists(codexCopy, 'SKILL.md'), true, 'copy intact');
    assert.equal(skillEntry(filtered, 'agents', 'alpha'), undefined, 'union write filtered out');
    assert.equal(filtered.exitCode, 0);

    const full = await runSync();
    assert.equal(skillEntry(full, 'agents', 'alpha')?.outcome, 'written');
    const converged = await runSync();
    assert.equal(skillEntry(converged, 'codex', 'alpha')?.outcome, 'removed');
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
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));

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

test('the union stays dormant while no member is active and wakes with proof intact', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'claude-code');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));

    const first = await runSync();
    assert.equal(skillEntry(first, 'agents', 'alpha')?.outcome, 'written');
    const unionCopy = path.join(unionBundle(homes, 'alpha'), 'SKILL.md');
    assert.equal(fs.existsSync(unionCopy), true);

    // Two ways to leave the union without an active member: no member enabled
    // at all, and a member that is enabled but not installed. Neither wakes
    // union cleanup — the shared files and the ownership record survive.
    for (const apps of [['claude-code'], ['traecli']]) {
      writeUserConfig(homes, config({ apps, skills: ['alpha'], agentsDir: true }));
      const dormant = await runSync();
      assert.equal(skillEntry(dormant, 'agents', 'alpha'), undefined, `${apps[0]}: no agents row`);
      assert.equal(fs.existsSync(unionCopy), true, `${apps[0]}: union copy untouched`);
      assert.equal(dormant.exitCode, 0);
    }

    // A returning member finds the record intact: deselection still removes
    // with proof instead of rediscovering an unproven foreign tree.
    writeUserConfig(homes, config({ apps: ['codex'], skills: [], agentsDir: true }));
    const cleanup = await runSync();
    assert.equal(skillEntry(cleanup, 'agents', 'alpha')?.outcome, 'removed');
    assert.equal(fs.existsSync(unionBundle(homes, 'alpha')), false, 'removed with proof');
  });
});

test('a member with no skills cell of its own reports missing skills only through the union', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.trae', 'cli'), { recursive: true });

    writeUserConfig(homes, config({ apps: ['traecli'], skills: ['ghost'], agentsDir: false }));
    const nowhere = await runSync();

    assert.equal(nowhere.exitCode, 0);
    assert.equal(
      nowhere.entries.some((entry) => entry.type === 'skills' && entry.id === 'ghost'),
      false,
      'a selection with no destination must not false-fail the run'
    );

    writeUserConfig(homes, config({ apps: ['traecli'], skills: ['ghost'], agentsDir: true }));
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
