/**
 * Tests: distributeHooks respects isInstalled check and supports multiple targets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getClaudeDir, getCodexHooksJsonPath } from '../src/config/paths.js';
import { distributeHooks } from '../src/hooks/distribution.js';
import { ensureHooksDirectory } from '../src/hooks/library.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { simulateAppsInstalled, withTempHomes } from './helpers/tmp.js';

function createHookEntry(id: string): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Test hook ${id}`,
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo test' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

function createPluginHookSource(asbHome: string): { pluginDir: string; hookId: string } {
  const marketplaceDir = path.join(asbHome, 'marketplaces', 'superpowers');
  const pluginDir = path.join(marketplaceDir, 'plugins', 'superpowers');
  const hooksDir = path.join(pluginDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });

  fs.writeFileSync(
    path.join(hooksDir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
                command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
              },
            ],
          },
        ],
      },
    })
  );
  fs.writeFileSync(path.join(hooksDir, 'run-hook.cmd'), '@echo off\n');
  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'superpowers',
      owner: { name: 'test-owner' },
      plugins: [{ name: 'superpowers', source: './plugins/superpowers' }],
    })
  );
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'superpowers' })
  );
  fs.writeFileSync(
    path.join(asbHome, 'config.toml'),
    `[plugins.sources]\nsuperpowers = "${marketplaceDir}"\n`
  );

  return { pluginDir, hookId: 'superpowers@superpowers:hooks' };
}

test('distributeHooks: skips when claude-code not installed and not in assumeInstalled', () => {
  withTempHomes(() => {
    // Do NOT call simulateAppsInstalled() so claude-code appears uninstalled
    createHookEntry('test-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['test-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.equal(outcome.results.length, 0, 'should produce no results when not installed');
  });
});

test('distributeHooks: distributes when claude-code is in assumeInstalled', () => {
  withTempHomes(() => {
    // Do NOT call simulateAppsInstalled() so claude-code appears uninstalled
    createHookEntry('test-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['test-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code'], new Set(['claude-code']));

    assert.ok(outcome.results.length > 0, 'should produce results when assumed installed');
  });
});

test('distributeHooks: distributes when claude-code is actually installed', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['test-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.length > 0, 'should produce results when installed');
  });
});

test('distributeHooks: rewrites plugin hook CLAUDE_PLUGIN_ROOT references to distributed hook paths', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    updateLibraryStateSection('hooks', () => ({ enabled: [hookId], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);
    assert.ok(outcome.results.length > 0, 'should produce distribution results');

    const settings = JSON.parse(
      fs.readFileSync(path.join(getClaudeDir(), 'settings.json'), 'utf-8')
    ) as {
      hooks: {
        SessionStart: Array<{
          hooks: Array<{
            command?: string;
          }>;
        }>;
      };
    };

    const command = settings.hooks.SessionStart[0]?.hooks[0]?.command;
    const expectedPath = path.join(getClaudeDir(), 'hooks', 'asb', hookId, 'run-hook.cmd');
    const portablePath = expectedPath.replace(os.homedir(), '$HOME');

    assert.equal(command, `"${portablePath}" session-start`);
  });
});

// ---------------------------------------------------------------------------
// Codex hook distribution tests
// ---------------------------------------------------------------------------

function createCodexCompatibleHook(id: string, event = 'UserPromptSubmit'): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Test hook ${id}`,
    hooks: {
      [event]: [{ matcher: '', hooks: [{ type: 'command', command: 'echo test-codex' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

function createUnsupportedEventHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Hook with unsupported event ${id}`,
    hooks: {
      PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'echo compact' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

function createHttpHandlerHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Hook with http handler ${id}`,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'http', url: 'http://example.com' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

test('distributeHooks: writes hooks.json for codex when installed', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('codex-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-hook'],
      agentSync: { codex: { enabled: ['codex-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(codexResults.length > 0, 'should produce codex results');

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json should exist');

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    assert.ok(hooks.UserPromptSubmit, 'should have UserPromptSubmit event');
    assert.ok(Array.isArray(hooks.UserPromptSubmit), 'UserPromptSubmit should be an array');
    assert.ok(hooks.UserPromptSubmit.length > 0, 'should have at least one matcher group');
  });
});

test('distributeHooks: skips codex when not installed', () => {
  withTempHomes(() => {
    // Do NOT call simulateAppsInstalled('codex')
    createCodexCompatibleHook('codex-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-hook'],
      agentSync: { codex: { enabled: ['codex-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex']);

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.equal(codexResults.length, 0, 'should produce no codex results when not installed');
  });
});

test('distributeHooks: filters unsupported events for codex', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createUnsupportedEventHook('compact-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['compact-hook'],
      agentSync: { codex: { enabled: ['compact-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    // Hook with only unsupported events should either produce a skip/warning result
    // or write an empty hooks.json (no events to merge)
    const _codexResults = outcome.results.filter((r) => r.platform === 'codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    if (fs.existsSync(hooksJsonPath)) {
      const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const hooks = content.hooks as Record<string, unknown[]> | undefined;
      // PreCompact should NOT appear in codex hooks.json
      assert.equal(hooks?.PreCompact, undefined, 'PreCompact should not be in codex hooks.json');
    }
  });
});

test('distributeHooks: filters http handlers for codex', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createHttpHandlerHook('http-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['http-hook'],
      agentSync: { codex: { enabled: ['http-hook'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    // http handlers must not appear in codex hooks.json
    const hooksJsonPath = getCodexHooksJsonPath();
    if (fs.existsSync(hooksJsonPath)) {
      const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const hooks = content.hooks as Record<string, unknown[]> | undefined;
      if (hooks?.SessionStart) {
        for (const group of hooks.SessionStart as Array<{ hooks: Array<{ type: string }> }>) {
          for (const h of group.hooks) {
            assert.notEqual(h.type, 'http', 'http handlers should not appear in codex hooks.json');
          }
        }
      }
    }
  });
});

test('distributeHooks: preserves existing user hooks in codex hooks.json', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');

    // Write a pre-existing user hook in hooks.json
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'echo user-hook' }],
            },
          ],
        },
      })
    );

    createCodexCompatibleHook('asb-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['asb-hook'],
      agentSync: { codex: { enabled: ['asb-hook'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    const groups = hooks.UserPromptSubmit as Array<Record<string, unknown>>;

    // Should have both: user hook (without _asb_source) and ASB hook (with _asb_source)
    const userGroups = groups.filter((g) => g._asb_source === undefined);
    const asbGroups = groups.filter((g) => g._asb_source === true);
    assert.ok(userGroups.length > 0, 'should preserve user hooks');
    assert.ok(asbGroups.length > 0, 'should add ASB-managed hooks');
  });
});

test('distributeHooks: cleans ASB hooks from codex when selection is empty', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');

    // Pre-populate hooks.json with an ASB-managed group
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo asb' }], _asb_source: true },
            { matcher: '', hooks: [{ type: 'command', command: 'echo user' }] },
          ],
        },
        _asb_managed_hooks: ['old-hook'],
      })
    );

    // Empty selection for codex
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    const groups = hooks.UserPromptSubmit as Array<Record<string, unknown>>;

    // ASB groups should be removed, user group preserved
    const asbGroups = groups.filter((g) => g._asb_source === true);
    const userGroups = groups.filter((g) => g._asb_source === undefined);
    assert.equal(asbGroups.length, 0, 'ASB hooks should be cleaned up');
    assert.ok(userGroups.length > 0, 'user hooks should be preserved');
  });
});

test('distributeHooks: distributes to both claude-code and codex simultaneously', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code', 'codex');
    createCodexCompatibleHook('shared-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['shared-hook'],
      agentSync: {
        'claude-code': { enabled: ['shared-hook'] },
        codex: { enabled: ['shared-hook'] },
      },
    }));

    const outcome = distributeHooks(undefined, ['claude-code', 'codex']);

    const claudeResults = outcome.results.filter((r) => r.platform === 'claude-code');
    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(claudeResults.length > 0, 'should produce claude-code results');
    assert.ok(codexResults.length > 0, 'should produce codex results');
  });
});
