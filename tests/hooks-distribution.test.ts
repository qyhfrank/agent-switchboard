/**
 * Tests: distributeHooks respects isInstalled check and supports multiple targets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getClaudeDir,
  getCodexConfigPath,
  getCodexHooksJsonPath,
  getProjectCodexHooksJsonPath,
} from '../src/config/paths.js';
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
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo notify' }] }],
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
      // Notification should NOT appear in codex hooks.json
      assert.equal(
        hooks?.Notification,
        undefined,
        'Notification should not be in codex hooks.json'
      );
    }
  });
});

test('distributeHooks: preserves current Codex supported events', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('permission-hook', 'PermissionRequest');
    createCodexCompatibleHook('pre-compact-hook', 'PreCompact');
    createCodexCompatibleHook('post-compact-hook', 'PostCompact');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['permission-hook', 'pre-compact-hook', 'post-compact-hook'],
      agentSync: {
        codex: { enabled: ['permission-hook', 'pre-compact-hook', 'post-compact-hook'] },
      },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;

    assert.ok(hooks.PermissionRequest, 'PermissionRequest should be preserved');
    assert.ok(hooks.PreCompact, 'PreCompact should be preserved');
    assert.ok(hooks.PostCompact, 'PostCompact should be preserved');
  });
});

test('distributeHooks: codex canonical hooks feature does not produce legacy warning', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(getCodexConfigPath(), '[features]\nhooks = true\n');
    createCodexCompatibleHook('feature-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['feature-hook'],
      agentSync: { codex: { enabled: ['feature-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const configResults = outcome.results.filter(
      (r) => r.platform === 'codex' && 'filePath' in r && r.filePath === getCodexConfigPath()
    );

    assert.equal(configResults.length, 0, 'canonical features.hooks=true should not warn');
  });
});

test('distributeHooks: codex reports disabled hooks feature without claiming a write', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(getCodexConfigPath(), '[features]\nhooks = false\n');
    createCodexCompatibleHook('disabled-feature-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['disabled-feature-hook'],
      agentSync: { codex: { enabled: ['disabled-feature-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const configResults = outcome.results.filter(
      (r) => r.platform === 'codex' && 'filePath' in r && r.filePath === getCodexConfigPath()
    );

    assert.ok(
      configResults.some(
        (r) =>
          r.status === 'conflict' &&
          r.reason?.includes('features.hooks') &&
          !r.reason.includes('codex_hooks')
      ),
      'disabled features.hooks should be reported as a conflict-style warning'
    );
    assert.equal(
      configResults.some((r) => r.status === 'written'),
      false,
      'feature warning must not be reported as written'
    );
  });
});

test('distributeHooks: codex project hooks do not auto-trust the project', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const projectRoot = path.join(agentsHome, 'project-with-codex-hooks');
    fs.mkdirSync(projectRoot, { recursive: true });
    createCodexCompatibleHook('project-hook');
    updateLibraryStateSection(
      'hooks',
      () => ({
        enabled: ['project-hook'],
        agentSync: { codex: { enabled: ['project-hook'] } },
      }),
      { project: projectRoot }
    );

    const outcome = distributeHooks({ project: projectRoot }, ['codex'], new Set(['codex']));

    assert.ok(
      fs.existsSync(getProjectCodexHooksJsonPath(projectRoot)),
      'project hooks.json should be written'
    );
    const globalConfigPath = getCodexConfigPath();
    const globalConfig = fs.existsSync(globalConfigPath)
      ? fs.readFileSync(globalConfigPath, 'utf-8')
      : '';
    assert.equal(
      globalConfig.includes('trust_level = "trusted"'),
      false,
      'hook distribution must not automatically trust project config'
    );
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'conflict' &&
          r.reason?.includes('project is not trusted')
      ),
      'project trust gap should be visible to the user'
    );
  });
});

test('distributeHooks: codex changed hooks report review requirement', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('review-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['review-hook'],
      agentSync: { codex: { enabled: ['review-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      ),
      'new or changed Codex hooks should tell users to review them in /hooks'
    );
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

// ---------------------------------------------------------------------------
// F-006: Additional coverage for Codex hook distribution
// ---------------------------------------------------------------------------

function createBundleHook(id: string, event = 'UserPromptSubmit'): void {
  const hooksDir = ensureHooksDirectory();
  const bundleDir = path.join(hooksDir, id);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'hook.json'),
    JSON.stringify({
      name: id,
      description: `Bundle hook ${id}`,
      hooks: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder
        [event]: [{ hooks: [{ type: 'command', command: '${HOOK_DIR}/run.sh' }] }],
      },
    })
  );
  fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\necho test\n');
}

function createMixedHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  fs.writeFileSync(
    path.join(hooksDir, `${id}.json`),
    JSON.stringify({
      name: id,
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo ok' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }],
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'echo start' },
              { type: 'http', url: 'http://example.com' },
            ],
          },
        ],
      },
    })
  );
}

test('distributeHooks: codex bundle hook copies files and rewrites HOOK_DIR', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-test');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-test'],
      agentSync: { codex: { enabled: ['bundle-test'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json should exist');

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const command = hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    assert.ok(command, 'should have a command');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal check
    assert.ok(!command.includes('${HOOK_DIR}'), 'HOOK_DIR should be rewritten');
    assert.ok(command.includes('bundle-test'), 'should reference bundle dir');
  });
});

test('distributeHooks: codex mixed hook keeps supported events/handlers, drops unsupported', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createMixedHook('mixed-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['mixed-hook'],
      agentSync: { codex: { enabled: ['mixed-hook'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json should exist');

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;

    // UserPromptSubmit (supported event, command handler) should be present
    assert.ok(hooks.UserPromptSubmit, 'UserPromptSubmit should be present');
    // PreCompact is supported by current Codex and should be present
    assert.ok(hooks.PreCompact, 'PreCompact should be preserved');
    // SessionStart should have only the command handler, not the http one
    if (hooks.SessionStart) {
      for (const group of hooks.SessionStart as Array<{ hooks: Array<{ type: string }> }>) {
        for (const h of group.hooks) {
          assert.notEqual(h.type, 'http', 'http handler should be filtered out');
        }
      }
    }
  });
});

test('distributeHooks: codex idempotent re-sync updates ASB hooks without duplication', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('idempotent-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['idempotent-hook'],
      agentSync: { codex: { enabled: ['idempotent-hook'] } },
    }));

    // First sync
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    // Second sync (idempotent)
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    const groups = hooks.UserPromptSubmit as Array<Record<string, unknown>>;

    const asbGroups = groups.filter((g) => g._asb_source === true);
    assert.equal(
      asbGroups.length,
      1,
      'should have exactly 1 ASB group after re-sync, not duplicated'
    );
  });
});

test('distributeHooks: codex dryRun does not write hooks.json', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('dryrun-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['dryrun-hook'],
      agentSync: { codex: { enabled: ['dryrun-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']), { dryRun: true });

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(codexResults.length > 0, 'should produce results');

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(!fs.existsSync(hooksJsonPath), 'hooks.json should NOT be written in dryRun');
  });
});

test('distributeHooks: codex returns error for malformed hooks.json shape', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: 'bad-shape' }));

    createCodexCompatibleHook('shape-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['shape-hook'],
      agentSync: { codex: { enabled: ['shape-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    const errorResults = outcome.results.filter(
      (r) => r.platform === 'codex' && r.status === 'error'
    );
    assert.ok(errorResults.length > 0, 'should produce error result for malformed hooks.json');
  });
});
