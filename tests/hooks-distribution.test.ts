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
  getCodexDir,
  getCodexHooksJsonPath,
  getProjectCodexHooksJsonPath,
} from '../src/config/paths.js';
import { distributeHooks } from '../src/hooks/distribution.js';
import { ensureHooksDirectory } from '../src/hooks/library.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { getTargetById } from '../src/targets/registry.js';
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

test('distributeHooks: executable mode drift is repaired for claude-code bundles', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const { pluginDir, hookId } = createPluginHookSource(asbHome);
    const sourceScript = path.join(pluginDir, 'hooks', 'run-hook.cmd');
    fs.chmodSync(sourceScript, 0o755);
    updateLibraryStateSection('hooks', () => ({ enabled: [hookId], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);
    const targetDir = path.join(getClaudeDir(), 'hooks', 'asb', hookId);
    const targetScript = path.join(targetDir, 'run-hook.cmd');
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);

    fs.chmodSync(targetScript, 0o644);
    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

test('distributeHooks: claude-code rejects symlinked bundle parent before settings merge', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    updateLibraryStateSection('hooks', () => ({ enabled: [hookId], agentSync: {} }));

    const hooksLink = path.join(getClaudeDir(), 'hooks', 'asb');
    const outsideDir = path.join(agentsHome, 'outside-claude-hooks');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const targetDir = path.join(hooksLink, hookId);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.existsSync(path.join(outsideDir, hookId)), false);
    assert.equal(fs.existsSync(path.join(getClaudeDir(), 'settings.json')), false);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /symlinked bundle root/);
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

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(
      codexResults.some(
        (r) =>
          r.status === 'skipped' &&
          r.entryId === 'compact-hook' &&
          r.reason?.includes('unsupported events') &&
          r.reason.includes('Notification')
      ),
      'unsupported-only hook should produce a visible Codex diagnostic'
    );
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

test('distributeHooks: codex respects active profile hooks feature override', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(
      getCodexConfigPath(),
      'profile = "work"\n\n[profiles.work.features]\nhooks = false\n'
    );
    createCodexCompatibleHook('profile-disabled-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['profile-disabled-hook'],
      agentSync: { codex: { enabled: ['profile-disabled-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'conflict' &&
          r.filePath === getCodexConfigPath() &&
          r.reason?.includes('features.hooks')
      ),
      'active profile features.hooks=false should be reported as disabled'
    );
  });
});

test('distributeHooks: codex profile hooks feature overrides top-level feature', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(
      getCodexConfigPath(),
      'profile = "work"\n\n[features]\nhooks = false\n\n[profiles.work.features]\nhooks = true\n'
    );
    createCodexCompatibleHook('profile-enabled-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['profile-enabled-hook'],
      agentSync: { codex: { enabled: ['profile-enabled-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.filePath === getCodexConfigPath() &&
          r.status === 'conflict' &&
          r.reason?.includes('features.hooks')
      ),
      false,
      'profile features.hooks=true should override top-level disabled hooks'
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

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'skipped' &&
          r.entryId === 'http-hook' &&
          r.reason?.includes('unsupported handler types') &&
          r.reason.includes('http')
      ),
      'unsupported handler type should produce a visible Codex diagnostic'
    );

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
// Additional coverage for Codex hook distribution
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

test('distributeHooks: codex bundle content changes update review surface', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-review-test');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-review-test'],
      agentSync: { codex: { enabled: ['bundle-review-test'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const hooksJsonPath = getCodexHooksJsonPath();
    const firstContent = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const firstHooks = firstContent.hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    const firstCommand = firstHooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    assert.ok(firstCommand?.includes('asb-bundle-sha256'), 'bundle command should include hash');

    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'bundle-review-test', 'run.sh'),
      '#!/bin/sh\necho changed\n'
    );

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const secondContent = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const secondHooks = secondContent.hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    const secondCommand = secondHooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command;

    assert.notEqual(secondCommand, firstCommand, 'bundle content change should alter hooks.json');
    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      ),
      'bundle content change should report Codex review requirement'
    );
  });
});

test('distributeHooks: executable mode drift is repaired for codex bundles', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-mode-test');
    const sourceScript = path.join(ensureHooksDirectory(), 'bundle-mode-test', 'run.sh');
    fs.chmodSync(sourceScript, 0o755);
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-mode-test'],
      agentSync: { codex: { enabled: ['bundle-mode-test'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const targetDir = path.join(getCodexDir(), 'hooks', 'asb', 'bundle-mode-test');
    const targetScript = path.join(targetDir, 'run.sh');
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);

    fs.chmodSync(targetScript, 0o644);
    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find((r) => r.platform === 'codex' && r.targetDir === targetDir);

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

test('distributeHooks: codex bundle copy failure aborts hooks.json merge', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('broken-bundle');
    const bundleDir = path.join(ensureHooksDirectory(), 'broken-bundle');
    fs.symlinkSync(path.join(bundleDir, 'missing.sh'), path.join(bundleDir, 'broken.sh'));
    updateLibraryStateSection('hooks', () => ({
      enabled: ['broken-bundle'],
      agentSync: { codex: { enabled: ['broken-bundle'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'),
      'bundle copy failure should be reported'
    );
    assert.equal(
      fs.existsSync(getCodexHooksJsonPath()),
      false,
      'hooks.json should not be written when bundle copy fails'
    );
  });
});

test('distributeHooks: codex rejects symlinked bundle parent before hooks.json merge', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-parent-symlink');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-parent-symlink'],
      agentSync: { codex: { enabled: ['bundle-parent-symlink'] } },
    }));

    const hooksLink = path.join(getCodexDir(), 'hooks', 'asb');
    const outsideDir = path.join(agentsHome, 'outside-codex-hooks');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const targetDir = path.join(hooksLink, 'bundle-parent-symlink');
    const result = outcome.results.find((r) => r.platform === 'codex' && r.targetDir === targetDir);

    assert.equal(fs.existsSync(path.join(outsideDir, 'bundle-parent-symlink')), false);
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /symlinked bundle root/);
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

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

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
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'skipped' &&
          r.entryId === 'mixed-hook' &&
          r.reason?.includes('unsupported handler types') &&
          r.reason.includes('http')
      ),
      'partial filtering should produce a visible Codex diagnostic'
    );
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

test('distributeHooks: codex returns error for malformed hooks.json root', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(hooksJsonPath, '[]');

    createCodexCompatibleHook('root-shape-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['root-shape-hook'],
      agentSync: { codex: { enabled: ['root-shape-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'error' &&
          r.error?.includes('root must be an object')
      ),
      'array root should produce invalid-shape error'
    );
  });
});

test('distributeHooks: codex defers orphan cleanup until hooks.json write succeeds', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const oldBundleDir = path.join(path.dirname(hooksJsonPath), 'hooks', 'asb', 'old-bundle');
    fs.mkdirSync(oldBundleDir, { recursive: true });
    fs.writeFileSync(path.join(oldBundleDir, 'run.sh'), '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: `${oldBundleDir}/run.sh` }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['old-bundle'],
        preferredNotifChannel: 'notifications_disabled',
      })
    );
    fs.chmodSync(hooksJsonPath, 0o444);

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    try {
      const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

      assert.ok(
        outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'),
        'write failure should be reported'
      );
      assert.ok(
        fs.existsSync(oldBundleDir),
        'orphan bundle should remain when hooks.json write fails'
      );
    } finally {
      fs.chmodSync(hooksJsonPath, 0o644);
    }
  });
});

test('codex target registry hooks handler delegates to Codex distributor', () => {
  withTempHomes(() => {
    const target = getTargetById('codex');
    assert.ok(target?.hooks, 'codex target should expose hooks handler');

    const outcome = target.hooks.distribute({
      selected: [
        {
          id: 'registry-hook',
          bareId: 'registry-hook',
          source: 'test',
          filePath: path.join(ensureHooksDirectory(), 'registry-hook.json'),
          isBundle: false,
          hooks: {
            UserPromptSubmit: [
              { matcher: '', hooks: [{ type: 'command', command: 'echo registry' }] },
            ],
          },
        },
      ],
    });

    assert.ok(fs.existsSync(getCodexHooksJsonPath()), 'registry handler should write hooks.json');
    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      ),
      'registry handler should return Codex review diagnostic'
    );
  });
});
