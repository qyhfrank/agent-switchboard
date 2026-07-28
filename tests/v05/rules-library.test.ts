import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scanLibrary } from '../../src/engine/library.js';
import { seedRule, withScratchHomes } from './helpers/scratch.js';

test('scanLibrary on an empty home finds nothing and creates nothing', async () => {
  await withScratchHomes(async ({ asbHome }) => {
    const inventory = scanLibrary();
    assert.deepEqual(inventory.components, []);
    assert.deepEqual(inventory.failed, []);
    assert.equal(fs.existsSync(path.join(asbHome, 'rules')), false);
  });
});

test('scanLibrary parses metadata and content from markdown rules', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(
      homes,
      'alpha.md',
      '---\n' +
        'title: Alpha Rule\n' +
        'description: Test snippet\n' +
        'tags:\n' +
        '  - style\n' +
        '  - hygiene\n' +
        'requires:\n' +
        '  - claude\n' +
        '  - codex\n' +
        '---\n' +
        'Always lint before committing.\n'
    );
    seedRule(homes, 'beta.markdown', 'Content without frontmatter.');

    const inventory = scanLibrary();
    const rules = inventory.components.filter((component) => component.type === 'rules');
    assert.equal(rules.length, 2);
    assert.deepEqual(inventory.failed, []);

    const [alpha, beta] = rules;

    assert.equal(alpha.id, 'alpha');
    assert.equal(alpha.metadata.title, 'Alpha Rule');
    assert.equal(alpha.metadata.description, 'Test snippet');
    assert.deepEqual(alpha.metadata.tags, ['style', 'hygiene']);
    assert.deepEqual(alpha.metadata.requires, ['claude', 'codex']);
    assert.equal(alpha.content, 'Always lint before committing.\n');

    assert.equal(beta.id, 'beta');
    assert.deepEqual(beta.metadata.tags, []);
    assert.deepEqual(beta.metadata.requires, []);
    assert.equal(beta.content, 'Content without frontmatter.');
  });
});

test('a malformed rule becomes a failed component and blocks nothing else', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    const brokenPath = seedRule(homes, 'broken.md', '---\ninvalid\n');

    const inventory = scanLibrary();

    const rules = inventory.components.filter((component) => component.type === 'rules');
    assert.deepEqual(
      rules.map((component) => component.id),
      ['alpha']
    );

    assert.equal(inventory.failed.length, 1);
    const [failure] = inventory.failed;
    assert.equal(failure.type, 'rules');
    assert.equal(failure.id, 'broken');
    assert.equal(failure.path, brokenPath);
    assert.match(failure.error, /closing delimiter/);
  });
});

test('scanLibrary returns rules sorted by id', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'zeta.md', 'Z\n');
    seedRule(homes, 'alpha.md', 'A\n');
    seedRule(homes, 'mid.md', 'M\n');

    const inventory = scanLibrary();
    assert.deepEqual(
      inventory.components.map((component) => component.id),
      ['alpha', 'mid', 'zeta']
    );
  });
});
