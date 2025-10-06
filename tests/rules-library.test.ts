import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ensureRulesDirectory, loadRuleLibrary } from '../src/rules/library.js';

function withTempAsbHome<T>(fn: (configDir: string) => T): T {
  const previousAsbHome = process.env.ASB_HOME;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-rules-test-'));
  const configDir = path.join(tempRoot, 'config');
  process.env.ASB_HOME = configDir;
  try {
    return fn(configDir);
  } finally {
    process.env.ASB_HOME = previousAsbHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('loadRuleLibrary ensures directory existence and returns empty list', () => {
  withTempAsbHome((configDir) => {
    const rulesDir = path.join(configDir, 'rules');
    assert.equal(fs.existsSync(rulesDir), false);

    const rules = loadRuleLibrary();
    assert.equal(Array.isArray(rules), true);
    assert.equal(rules.length, 0);
    assert.equal(fs.existsSync(rulesDir), true);
  });
});

test('loadRuleLibrary parses metadata and content from markdown files', () => {
  withTempAsbHome((_configDir) => {
    const rulesDir = ensureRulesDirectory();

    fs.writeFileSync(
      path.join(rulesDir, 'alpha.md'),
      `---\n` +
        `title: Alpha Rule\n` +
        `description: Test snippet\n` +
        `tags:\n` +
        `  - style\n` +
        `  - hygiene\n` +
        `requires:\n` +
        `  - claude\n` +
        `  - codex\n` +
        `---\n` +
        `Always lint before committing.\n`
    );

    fs.writeFileSync(path.join(rulesDir, 'beta.markdown'), `Content without frontmatter.`);

    const rules = loadRuleLibrary();
    assert.equal(rules.length, 2);
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

test('loadRuleLibrary surfaces frontmatter errors with file context', () => {
  withTempAsbHome((_configDir) => {
    const rulesDir = ensureRulesDirectory();

    fs.writeFileSync(path.join(rulesDir, 'broken.md'), `---\ninvalid\n`);

    assert.throws(
      () => {
        loadRuleLibrary();
      },
      /closing delimiter/,
      'should throw when closing delimiter is missing'
    );
  });
});
