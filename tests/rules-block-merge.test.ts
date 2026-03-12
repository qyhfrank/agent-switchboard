import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isDedicatedAsbRulesFile,
  mergeRulesBlock,
  removeRulesBlock,
} from '../src/rules/block-merge.js';

const START = '<!-- asb:rules:start -->';
const END = '<!-- asb:rules:end -->';

// ── mergeRulesBlock ──

test('mergeRulesBlock inserts block at top (prepend) in empty file', () => {
  const result = mergeRulesBlock('', 'Rule content here', 'prepend');
  assert.ok(result.startsWith(START));
  assert.ok(result.includes('Rule content here'));
  assert.ok(result.includes(END));
});

test('mergeRulesBlock inserts block at top (prepend) with existing content', () => {
  const existing = 'Project-specific instructions\n';
  const result = mergeRulesBlock(existing, 'ASB rules', 'prepend');
  const startIdx = result.indexOf(START);
  const existingIdx = result.indexOf('Project-specific instructions');
  assert.ok(startIdx < existingIdx, 'ASB block should come before existing content');
});

test('mergeRulesBlock inserts block at bottom (append) with existing content', () => {
  const existing = 'Project-specific instructions\n';
  const result = mergeRulesBlock(existing, 'ASB rules', 'append');
  const endIdx = result.indexOf(END);
  const existingIdx = result.indexOf('Project-specific instructions');
  assert.ok(existingIdx < endIdx, 'Existing content should come before ASB block');
});

test('mergeRulesBlock replaces existing block', () => {
  const existing = `Before content\n${START}\nOld ASB content\n${END}\nAfter content\n`;
  const result = mergeRulesBlock(existing, 'New ASB content', 'prepend');
  assert.ok(result.includes('New ASB content'));
  assert.ok(!result.includes('Old ASB content'));
  assert.ok(result.includes('Before content'));
  assert.ok(result.includes('After content'));
});

test('mergeRulesBlock preserves surrounding content on replace', () => {
  const existing = `# My Project\n\n${START}\nold rules\n${END}\n\n## Other Section\n`;
  const result = mergeRulesBlock(existing, 'new rules', 'prepend');
  assert.ok(result.includes('# My Project'));
  assert.ok(result.includes('## Other Section'));
  assert.ok(result.includes('new rules'));
  assert.ok(!result.includes('old rules'));
});

test('mergeRulesBlock with empty content removes existing block', () => {
  const existing = `Before\n${START}\nASB stuff\n${END}\nAfter\n`;
  const result = mergeRulesBlock(existing, '', 'prepend');
  assert.ok(!result.includes(START));
  assert.ok(!result.includes(END));
  assert.ok(!result.includes('ASB stuff'));
});

test('mergeRulesBlock with empty content and no block returns unchanged', () => {
  const existing = 'Just some content\n';
  const result = mergeRulesBlock(existing, '', 'prepend');
  assert.equal(result, existing);
});

// ── removeRulesBlock ──

test('removeRulesBlock removes markers and content', () => {
  const content = `Before\n\n${START}\nASB content\n${END}\n\nAfter\n`;
  const result = removeRulesBlock(content);
  assert.ok(!result.includes(START));
  assert.ok(!result.includes(END));
  assert.ok(!result.includes('ASB content'));
  assert.ok(result.includes('Before'));
  assert.ok(result.includes('After'));
});

test('removeRulesBlock returns empty string when only ASB block', () => {
  const content = `${START}\nASB only content\n${END}\n`;
  const result = removeRulesBlock(content);
  assert.equal(result, '');
});

test('removeRulesBlock returns content unchanged when no markers', () => {
  const content = 'No markers here\n';
  const result = removeRulesBlock(content);
  assert.equal(result, content);
});

test('removeRulesBlock collapses excess blank lines', () => {
  const content = `Line 1\n\n\n${START}\nblock\n${END}\n\n\nLine 2\n`;
  const result = removeRulesBlock(content);
  assert.ok(!result.includes('\n\n\n'), 'Should not have 3+ consecutive newlines');
});

// ── isDedicatedAsbRulesFile ──

test('isDedicatedAsbRulesFile returns true for asb-rules prefixed files', () => {
  assert.ok(isDedicatedAsbRulesFile('/path/to/.cursor/rules/asb-rules.mdc'));
  assert.ok(isDedicatedAsbRulesFile('/path/to/.trae/rules/asb-rules.md'));
});

test('isDedicatedAsbRulesFile returns false for shared files', () => {
  assert.ok(!isDedicatedAsbRulesFile('/path/to/.claude/CLAUDE.md'));
  assert.ok(!isDedicatedAsbRulesFile('/path/to/AGENTS.md'));
  assert.ok(!isDedicatedAsbRulesFile('/path/to/project/AGENTS.md'));
});

test('isDedicatedAsbRulesFile handles Windows paths', () => {
  assert.ok(isDedicatedAsbRulesFile(String.raw`C:\repo\.cursor\rules\asb-rules.mdc`));
  assert.ok(!isDedicatedAsbRulesFile(String.raw`C:\repo\.claude\CLAUDE.md`));
});
