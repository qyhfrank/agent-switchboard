import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import { installApps, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

function seedCommand(homes: { asbHome: string }, id: string, body: string): void {
  const dir = path.join(homes.asbHome, 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), body, 'utf-8');
}

function commandPath(homes: { agentsHome: string }, id: string): string {
  return path.join(homes.agentsHome, '.claude', 'commands', `${id}.md`);
}

function entryFor(report: Report, id: string): ReportEntry | undefined {
  return report.entries.find((entry) => entry.type === 'commands' && entry.id === id);
}

function configFor(commands: readonly string[]): string {
  return `[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = [${commands.map((id) => `"${id}"`).join(', ')}]\n`;
}

test('a deselected command matching the render is removed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedCommand(homes, 'foo', '---\ndescription: Foo\n---\nFoo body.\n');
    writeUserConfig(homes, configFor(['foo']));
    await runSync();
    assert.ok(fs.existsSync(commandPath(homes, 'foo')));

    writeUserConfig(homes, configFor([]));
    const report = await runSync();

    assert.equal(entryFor(report, 'foo')?.outcome, 'removed');
    assert.equal(fs.existsSync(commandPath(homes, 'foo')), false);
    assert.equal(report.exitCode, 0);

    const later = await runSync();
    assert.equal(entryFor(later, 'foo'), undefined, 'nothing left to say');
  });
});

test('a deselected command edited by hand is reported once and left in place', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedCommand(homes, 'foo', '---\ndescription: Foo\n---\nFoo body.\n');
    writeUserConfig(homes, configFor(['foo']));
    await runSync();

    const target = commandPath(homes, 'foo');
    fs.writeFileSync(target, '---\ndescription: Foo\n---\nMy own wording.\n', 'utf-8');

    writeUserConfig(homes, configFor([]));
    const report = await runSync();

    const entry = entryFor(report, 'foo');
    assert.equal(entry?.outcome, 'left-behind');
    assert.equal(entry?.detail, 'unproven');
    assert.equal(fs.readFileSync(target, 'utf-8'), '---\ndescription: Foo\n---\nMy own wording.\n');
    assert.equal(report.exitCode, 0);
  });
});

test('a command that already holds the render is unchanged, never adopted', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedCommand(homes, 'foo', '---\ndescription: Foo\n---\nFoo body.\n');
    writeUserConfig(homes, configFor(['foo']));
    const first = await runSync();
    const written = fs.readFileSync(commandPath(homes, 'foo'), 'utf-8');
    assert.equal(entryFor(first, 'foo')?.outcome, 'written');

    // A fresh machine with the same bytes already in place.
    fs.rmSync(path.join(homes.stateHome, 'ledger.json'), { force: true });
    const report = await runSync();

    assert.equal(entryFor(report, 'foo')?.outcome, 'unchanged');
    assert.equal(fs.readFileSync(commandPath(homes, 'foo'), 'utf-8'), written);
    assert.equal(
      report.entries.some((row) => row.outcome === 'adopted'),
      false
    );
  });
});

test('a selected command whose target drifted is rewritten in one pass', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedCommand(homes, 'foo', '---\ndescription: Foo\n---\nFoo body.\n');
    writeUserConfig(homes, configFor(['foo']));
    await runSync();
    const rendered = fs.readFileSync(commandPath(homes, 'foo'), 'utf-8');

    fs.writeFileSync(commandPath(homes, 'foo'), 'edited by hand\n', 'utf-8');
    const report = await runSync();

    const entry = entryFor(report, 'foo');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(fs.readFileSync(commandPath(homes, 'foo'), 'utf-8'), rendered);
    assert.equal(report.exitCode, 0);
  });
});

test('a file whose name matches no library component is never touched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedCommand(homes, 'foo', '---\ndescription: Foo\n---\nFoo body.\n');
    writeUserConfig(homes, configFor(['foo']));

    const stranger = path.join(homes.agentsHome, '.claude', 'commands', 'mine.md');
    fs.mkdirSync(path.dirname(stranger), { recursive: true });
    fs.writeFileSync(stranger, 'my own command\n', 'utf-8');

    const report = await runSync();
    assert.equal(fs.readFileSync(stranger, 'utf-8'), 'my own command\n');
    assert.equal(
      report.entries.some((row) => row.path === stranger),
      false,
      'a name asb does not define is not asb to discuss'
    );
  });
});
