import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
  installApps,
  type ScratchHomes,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * use_agents_dir: codex/gemini/opencode read skills from the shared
 * ~/.agents/skills directory. The union row distributes the union of the
 * ACTIVE members' effective selections; the members' own rows deselect,
 * so their stale copies leave through the proof-gated removal path (0.4
 * left them behind silently).
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

function agentsBundle(homes: ScratchHomes, id: string): string {
  return path.join(skillsParentDir(homes, 'agents'), id);
}

function entryFor(report: Report, app: string, id: string): ReportEntry | undefined {
  return report.entries.find(
    (entry) => entry.app === app && entry.type === 'skills' && entry.id === id
  );
}

test('the agents row writes the union of active member selections to ~/.agents/skills', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'gemini', 'claude-code');
    seedSkill(homes, 'alpha');
    seedSkill(homes, 'beta');
    writeUserConfig(
      homes,
      config({
        apps: ['codex', 'gemini', 'claude-code', 'opencode'],
        skills: ['alpha'],
        agentsDir: true,
        extra: '[applications.gemini.skills]\nadd = ["beta"]',
      })
    );

    const report = await runSync();

    for (const id of ['alpha', 'beta'] as const) {
      const entry = entryFor(report, 'agents', id);
      assert.equal(entry?.outcome, 'written');
      assert.equal(entry?.detail, 'created');
      assert.equal(entry?.path, agentsBundle(homes, id));
      assert.equal(fs.existsSync(path.join(agentsBundle(homes, id), 'SKILL.md')), true);
    }

    // The members' own parents get no copies; the non-member app keeps its own.
    assert.equal(fs.existsSync(path.join(skillsParentDir(homes, 'codex'), 'alpha')), false);
    assert.equal(fs.existsSync(path.join(skillsParentDir(homes, 'gemini'), 'beta')), false);
    assert.equal(entryFor(report, 'claude-code', 'alpha')?.outcome, 'written');
    assert.equal(
      fs.existsSync(path.join(skillsParentDir(homes, 'claude-code'), 'alpha', 'SKILL.md')),
      true
    );

    // An enabled but uninstalled member contributes nothing and gets nothing.
    assert.equal(entryFor(report, 'opencode', 'alpha'), undefined);
    assert.equal(report.exitCode, 0);
  });
});

test('turning use_agents_dir on removes the recorded per-app copies with proof', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'] }));

    const first = await runSync();
    const codexCopy = path.join(skillsParentDir(homes, 'codex'), 'alpha');
    assert.equal(entryFor(first, 'codex', 'alpha')?.outcome, 'written');
    assert.equal(fs.existsSync(codexCopy), true);

    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));
    const second = await runSync();

    assert.equal(entryFor(second, 'codex', 'alpha')?.outcome, 'removed', '0.4 leaked this copy');
    assert.equal(fs.existsSync(codexCopy), false);
    assert.equal(entryFor(second, 'agents', 'alpha')?.outcome, 'written');
    assert.equal(fs.existsSync(path.join(agentsBundle(homes, 'alpha'), 'SKILL.md')), true);
    assert.equal(second.exitCode, 0);

    const third = await runSync();
    assert.equal(entryFor(third, 'agents', 'alpha')?.outcome, 'unchanged');
    assert.equal(entryFor(third, 'codex', 'alpha'), undefined, 'the removed copy stays gone');
  });
});

test('turning use_agents_dir off cleans the recorded union copies and restores per-app ones', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));

    await runSync();
    assert.equal(fs.existsSync(agentsBundle(homes, 'alpha')), true);

    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: false }));
    const report = await runSync();

    assert.equal(entryFor(report, 'agents', 'alpha')?.outcome, 'removed');
    assert.equal(fs.existsSync(agentsBundle(homes, 'alpha')), false);
    assert.equal(entryFor(report, 'codex', 'alpha')?.outcome, 'written');
    assert.equal(
      fs.existsSync(path.join(skillsParentDir(homes, 'codex'), 'alpha', 'SKILL.md')),
      true
    );
    assert.equal(report.exitCode, 0);
  });
});

test('a user-modified union bundle survives the toggle-off as left-behind', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));

    await runSync();
    fs.writeFileSync(path.join(agentsBundle(homes, 'alpha'), 'SKILL.md'), 'hand-edited\n');

    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: false }));
    const report = await runSync();

    const entry = entryFor(report, 'agents', 'alpha');
    assert.equal(entry?.outcome, 'left-behind');
    assert.equal(entry?.detail, 'modified');
    assert.equal(
      fs.readFileSync(path.join(agentsBundle(homes, 'alpha'), 'SKILL.md'), 'utf-8'),
      'hand-edited\n'
    );
    assert.equal(report.exitCode, 1);
  });
});

test('the agents .system directory is reserved exactly like the codex one', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedSkill(homes, 'alpha');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['alpha'], agentsDir: true }));

    const reserved = path.join(skillsParentDir(homes, 'agents'), '.system');
    fs.mkdirSync(reserved, { recursive: true });
    fs.writeFileSync(path.join(reserved, 'state.json'), '{"codex":"owns this"}\n');

    const report = await runSync();

    assert.equal(entryFor(report, 'agents', 'alpha')?.outcome, 'written');
    assert.equal(
      report.entries.some((entry) => entry.id === '.system' || entry.path === reserved),
      false
    );
    assert.equal(
      fs.readFileSync(path.join(reserved, 'state.json'), 'utf-8'),
      '{"codex":"owns this"}\n'
    );
  });
});
