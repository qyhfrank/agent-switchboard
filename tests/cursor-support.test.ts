import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { distributeCommands, resolveCommandFilePath } from '../src/commands/distribution.js';
import { importCommandFromFile } from '../src/commands/importer.js';
import { ensureCommandsDirectory } from '../src/commands/library.js';
import { parseLibraryMarkdown } from '../src/library/parser.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { RULE_SUPPORTED_AGENTS } from '../src/rules/agents.js';
import { distributeRules } from '../src/rules/distribution.js';
import { ensureRulesDirectory } from '../src/rules/library.js';
import { DEFAULT_RULE_STATE, saveRuleState } from '../src/rules/state.js';
import {
  distributeSkills,
  resolveSkillTargetDir,
  SKILL_PLATFORMS,
} from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { distributeSubagents, resolveSubagentFilePath } from '../src/subagents/distribution.js';
import { importSubagentFromFile } from '../src/subagents/importer.js';
import { ensureSubagentsDirectory } from '../src/subagents/library.js';
import { withTempDir, withTempHomes } from './helpers/tmp.js';

// ---------------------------------------------------------------------------
// Commands: cursor platform
// ---------------------------------------------------------------------------

test('distributeCommands: cursor output is pure content without frontmatter', () => {
  withTempHomes(() => {
    const cmdDir = ensureCommandsDirectory();
    const cmdId = 'cursor-cmd';
    fs.writeFileSync(
      path.join(cmdDir, `${cmdId}.md`),
      `---\ndescription: Test command\nextras:\n  claude-code:\n    model: my-model\n---\nDo the thing.\n`
    );

    updateLibraryStateSection('commands', () => ({ active: [cmdId], agentSync: {} }));
    distributeCommands();

    const cursorFile = resolveCommandFilePath('cursor', cmdId);
    assert.ok(fs.existsSync(cursorFile), 'cursor command file should exist');
    const content = fs.readFileSync(cursorFile, 'utf-8');

    // Cursor output should NOT have YAML frontmatter
    assert.ok(!content.startsWith('---'), 'cursor command should not have frontmatter');
    // Should NOT have HTML comments (unlike Codex)
    assert.ok(!content.includes('<!--'), 'cursor command should not have HTML comments');
    // Should contain the actual body content
    assert.match(content, /Do the thing/);
    // Should end with newline
    assert.ok(content.endsWith('\n'));
  });
});

test('importCommandFromFile: cursor platform wraps raw content in library schema', () => {
  withTempDir((dir) => {
    const src = path.join(dir, 'do-thing.md');
    fs.writeFileSync(src, 'Just do the thing.\n');

    const result = importCommandFromFile('cursor', src);

    assert.equal(result.slug, 'do-thing');
    // Library schema wraps with YAML frontmatter containing extras.cursor
    const parsed = parseLibraryMarkdown(result.content);
    const extras = parsed.metadata.extras as Record<string, unknown> | undefined;
    assert.ok(extras && typeof extras === 'object', 'should have extras');
    assert.ok('cursor' in extras, 'should have extras.cursor key');
  });
});

// ---------------------------------------------------------------------------
// Skills: cursor platform and dedup
// ---------------------------------------------------------------------------

test('SKILL_PLATFORMS includes cursor', () => {
  assert.ok(SKILL_PLATFORMS.includes('cursor'), 'cursor should be in SKILL_PLATFORMS');
});

test('resolveSkillTargetDir: cursor resolves to ~/.cursor/skills/<id>', () => {
  withTempHomes(({ agentsHome }) => {
    const target = resolveSkillTargetDir('cursor', 'my-skill');
    assert.equal(target, path.join(agentsHome, '.cursor', 'skills', 'my-skill'));
  });
});

test('distributeSkills: cursor deduped when claude-code has active skills', () => {
  withTempHomes(() => {
    const skillsDir = ensureSkillsDirectory();
    const skillId = 'dedup-test';
    const skillDir = path.join(skillsDir, skillId);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${skillId}\ndescription: Test\n---\nSkill body\n`
    );

    // Activate globally (applies to all agents including claude-code)
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));

    const outcome = distributeSkills();

    // Claude-code should have written the skill
    const ccWritten = outcome.results.filter(
      (r) => r.platform === 'claude-code' && r.status === 'written'
    );
    assert.ok(ccWritten.length > 0, 'claude-code should have written skills');

    // Cursor should NOT have written (deduped because claude-code has active skills)
    const cursorWritten = outcome.results.filter(
      (r) => r.platform === 'cursor' && r.status === 'written'
    );
    assert.equal(
      cursorWritten.length,
      0,
      'cursor should be deduped when claude-code has active skills'
    );
  });
});

test('distributeSkills: cursor deduped in agents mode too', () => {
  withTempHomes(() => {
    const skillsDir = ensureSkillsDirectory();
    const skillId = 'agents-dedup';
    const skillDir = path.join(skillsDir, skillId);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${skillId}\ndescription: Test\n---\nSkill body\n`
    );

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));

    const outcome = distributeSkills(undefined, { useAgentsDir: true });

    // Claude-code should have results
    const ccResults = outcome.results.filter(
      (r) => r.platform === 'claude-code' && r.status === 'written'
    );
    assert.ok(ccResults.length > 0, 'claude-code should have written skills in agents mode');

    // Cursor should be deduped
    const cursorWritten = outcome.results.filter(
      (r) => r.platform === 'cursor' && r.status === 'written'
    );
    assert.equal(
      cursorWritten.length,
      0,
      'cursor should be deduped in agents mode when claude-code is active'
    );
  });
});

test('distributeSkills: cursor NOT deduped when claude-code has no active skills', () => {
  withTempHomes(({ asbHome }) => {
    const skillsDir = ensureSkillsDirectory();
    const skillId = 'cursor-only-skill';
    const skillDir = path.join(skillsDir, skillId);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${skillId}\ndescription: Test\n---\nSkill body\n`
    );

    // Activate globally, but remove from claude-code via per-agent override
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[skills]',
        `active = ["${skillId}"]`,
        '',
        '[agents.claude-code.skills]',
        `remove = ["${skillId}"]`,
      ].join('\n')
    );

    const outcome = distributeSkills();

    // Claude-code should have nothing (removed by per-agent override)
    const ccWritten = outcome.results.filter(
      (r) => r.platform === 'claude-code' && r.status === 'written'
    );
    assert.equal(ccWritten.length, 0, 'claude-code should have no skills after remove override');

    // Cursor should NOT be deduped and should receive the skill
    const cursorWritten = outcome.results.filter(
      (r) => r.platform === 'cursor' && r.status === 'written'
    );
    assert.ok(
      cursorWritten.length > 0,
      'cursor should receive skills when claude-code has none active'
    );
  });
});

// ---------------------------------------------------------------------------
// Subagents: cursor platform
// ---------------------------------------------------------------------------

test('distributeSubagents: cursor output has allowlisted frontmatter fields only', () => {
  withTempHomes(() => {
    const subDir = ensureSubagentsDirectory();
    const subId = 'filtered-agent';

    // Create a subagent with cursor extras containing both allowed and disallowed fields
    fs.writeFileSync(
      path.join(subDir, `${subId}.md`),
      [
        '---',
        'description: A test agent',
        'extras:',
        '  cursor:',
        '    name: Custom Name',
        '    readonly: true',
        '    tools:',
        '      - browser',
        '    color: blue',
        '---',
        'You are a helpful agent.',
        '',
      ].join('\n')
    );

    updateLibraryStateSection('subagents', () => ({ active: [subId], agentSync: {} }));
    distributeSubagents();

    const cursorFile = resolveSubagentFilePath('cursor', subId);
    assert.ok(fs.existsSync(cursorFile), 'cursor subagent file should exist');
    const content = fs.readFileSync(cursorFile, 'utf-8');

    // Should have frontmatter (cursor agents use YAML frontmatter)
    assert.match(content, /^---/);

    // Allowed fields should be present
    assert.match(content, /name: Custom Name/);
    assert.match(content, /readonly: true/);
    assert.match(content, /description: A test agent/);

    // Disallowed fields should NOT be in the frontmatter
    // Split out frontmatter to check precisely
    const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'should have frontmatter block');
    const frontmatter = fmMatch[1];
    assert.ok(!frontmatter.includes('tools:'), 'disallowed field "tools" should be filtered');
    assert.ok(!frontmatter.includes('color:'), 'disallowed field "color" should be filtered');

    // Body should be present
    assert.match(content, /You are a helpful agent/);
  });
});

test('distributeSubagents: cursor model defaults to inherit when not specified', () => {
  withTempHomes(() => {
    const subDir = ensureSubagentsDirectory();
    const subId = 'no-model-agent';

    // No model in extras
    fs.writeFileSync(
      path.join(subDir, `${subId}.md`),
      '---\ndescription: Agent without model\n---\nDo stuff.\n'
    );

    updateLibraryStateSection('subagents', () => ({ active: [subId], agentSync: {} }));
    distributeSubagents();

    const cursorFile = resolveSubagentFilePath('cursor', subId);
    assert.ok(fs.existsSync(cursorFile), 'cursor subagent file should exist');
    const content = fs.readFileSync(cursorFile, 'utf-8');

    // Should have model: inherit as default
    assert.match(content, /model: inherit/);
  });
});

test('importSubagentFromFile: cursor platform preserves extras under cursor key', () => {
  withTempDir((dir) => {
    const src = path.join(dir, 'reviewer.md');
    fs.writeFileSync(
      src,
      '---\nname: reviewer\ndescription: Review code\nmodel: gpt-4\nreadonly: true\n---\nReview this.\n'
    );

    const result = importSubagentFromFile('cursor', src);

    assert.equal(result.slug, 'reviewer');
    const parsed = parseLibraryMarkdown(result.content);

    assert.equal(parsed.metadata.description, 'Review code');
    const extras = parsed.metadata.extras as Record<string, unknown> | undefined;
    assert.ok(extras && typeof extras === 'object', 'should have extras');
    const cursor = extras.cursor as Record<string, unknown>;
    assert.ok(cursor && typeof cursor === 'object', 'should have extras.cursor');
    assert.equal(cursor.model, 'gpt-4');
    assert.equal(cursor.readonly, true);
  });
});

// ---------------------------------------------------------------------------
// Rules: cursor single-file .mdc distribution
// ---------------------------------------------------------------------------

test('RULE_SUPPORTED_AGENTS includes cursor', () => {
  assert.ok(
    (RULE_SUPPORTED_AGENTS as readonly string[]).includes('cursor'),
    'cursor should be in RULE_SUPPORTED_AGENTS'
  );
});

test('distributeRules: writes single asb-rules.mdc for cursor', () => {
  withTempHomes(({ agentsHome }) => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(
      path.join(rulesDir, 'hygiene.md'),
      '---\ntitle: Prompt Hygiene\ndescription: Keep prompts clean\n---\nKeep commit messages scoped.\n'
    );
    fs.writeFileSync(
      path.join(rulesDir, 'style.md'),
      '---\ntitle: Code Style\n---\nUse consistent formatting.\n'
    );

    saveRuleState({ ...DEFAULT_RULE_STATE, active: ['hygiene', 'style'], agentSync: {} });
    const outcome = distributeRules();

    const cursorResults = outcome.results.filter((r) => r.agent === 'cursor');
    assert.equal(cursorResults.length, 1, 'should have exactly one cursor distribution result');

    const cursorRulesDir = path.join(agentsHome, '.cursor', 'rules');
    const singleFile = path.join(cursorRulesDir, 'asb-rules.mdc');
    assert.ok(fs.existsSync(singleFile), 'asb-rules.mdc should exist');

    const content = fs.readFileSync(singleFile, 'utf-8');
    assert.match(content, /^---/);
    assert.match(content, /description: Agent Switchboard Rules/);
    assert.match(content, /alwaysApply: true/);
    assert.match(content, /Keep commit messages scoped/);
    assert.match(content, /Use consistent formatting/);
  });
});

test('distributeRules: cursor cleanup removes legacy per-rule .mdc files', () => {
  withTempHomes(({ agentsHome }) => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'keep.md'), 'Keep this.\n');

    const cursorRulesDir = path.join(agentsHome, '.cursor', 'rules');
    fs.mkdirSync(cursorRulesDir, { recursive: true });
    fs.writeFileSync(path.join(cursorRulesDir, 'keep.mdc'), 'legacy per-rule file\n');

    saveRuleState({ ...DEFAULT_RULE_STATE, active: ['keep'], agentSync: {} });
    distributeRules();

    assert.ok(
      fs.existsSync(path.join(cursorRulesDir, 'asb-rules.mdc')),
      'asb-rules.mdc should exist'
    );
    assert.ok(
      !fs.existsSync(path.join(cursorRulesDir, 'keep.mdc')),
      'legacy keep.mdc should be cleaned up'
    );
  });
});

test('distributeRules: cursor cleanup does not delete non-library .mdc files', () => {
  withTempHomes(({ agentsHome }) => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'managed.md'), 'Managed rule.\n');

    const cursorRulesDir = path.join(agentsHome, '.cursor', 'rules');
    fs.mkdirSync(cursorRulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorRulesDir, 'user-own.mdc'),
      '---\ndescription: My rule\nalwaysApply: true\n---\nUser rule.\n'
    );

    saveRuleState({ ...DEFAULT_RULE_STATE, active: ['managed'], agentSync: {} });
    distributeRules();

    assert.ok(
      fs.existsSync(path.join(cursorRulesDir, 'asb-rules.mdc')),
      'asb-rules.mdc should exist'
    );
    assert.ok(
      fs.existsSync(path.join(cursorRulesDir, 'user-own.mdc')),
      'user-own.mdc should not be deleted'
    );
  });
});

test('distributeRules: cursor skips unchanged asb-rules.mdc', () => {
  withTempHomes(() => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'stable.md'), 'Stable content.\n');

    saveRuleState({ ...DEFAULT_RULE_STATE, active: ['stable'], agentSync: {} });

    const first = distributeRules();
    const cursorWritten = first.results.filter(
      (r) => r.agent === 'cursor' && r.status === 'written'
    );
    assert.ok(cursorWritten.length > 0, 'first run should write');

    const second = distributeRules();
    const cursorSkipped = second.results.filter(
      (r) => r.agent === 'cursor' && r.status === 'skipped'
    );
    assert.ok(cursorSkipped.length > 0, 'second run should skip unchanged');
  });
});
