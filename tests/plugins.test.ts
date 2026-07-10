import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveApplicationNativePluginConfig,
  resolveApplicationSectionConfig,
  resolveEffectiveSectionConfig,
} from '../src/config/application-config.js';
import { loadMcpConfigWithPlugins } from '../src/config/mcp-config.js';
import { getPluginSourceLocksDir } from '../src/config/paths.js';
import { loadSwitchboardConfig } from '../src/config/switchboard-config.js';
import { addRemoteSource } from '../src/library/sources.js';
import { loadMcpEnabledState } from '../src/library/state.js';
import { redactGitCredentials } from '../src/marketplace/cache.js';
import { refreshMarketplacePluginCache } from '../src/marketplace/reader.js';
import { buildPluginIndex, clearPluginIndexCache } from '../src/plugins/index.js';
import { loadRuleLibrary } from '../src/rules/library.js';
import { loadSkillLibrary } from '../src/skills/library.js';
import { runCli } from './helpers/cli.js';
import { withTempAsbHome } from './helpers/tmp.js';

// ── Fixture helpers ────────────────────────────────────────────────

function createMarketplaceFixture(
  asbHome: string,
  marketplaceName: string,
  plugins: Array<{
    name: string;
    description?: string;
    commands?: string[];
    agents?: string[];
    skills?: Array<{ name: string; content: string }>;
    rules?: Array<{ name: string; content: string }>;
    mcp?: Record<string, unknown>;
  }>
) {
  const mktDir = path.join(asbHome, 'marketplaces', marketplaceName);
  const pluginRootDir = path.join(mktDir, 'plugins');
  fs.mkdirSync(pluginRootDir, { recursive: true });

  const manifestPlugins = plugins.map((p) => ({
    name: p.name,
    source: `./plugins/${p.name}`,
    description: p.description,
  }));

  fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(mktDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: marketplaceName,
      owner: { name: 'test-owner' },
      metadata: {},
      plugins: manifestPlugins,
    })
  );

  for (const plugin of plugins) {
    const pluginDir = path.join(pluginRootDir, plugin.name);
    fs.mkdirSync(pluginDir, { recursive: true });

    // plugin.json
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: plugin.name, description: plugin.description })
    );

    // commands
    if (plugin.commands) {
      const cmdDir = path.join(pluginDir, 'commands');
      fs.mkdirSync(cmdDir, { recursive: true });
      for (const cmd of plugin.commands) {
        fs.writeFileSync(
          path.join(cmdDir, `${cmd}.md`),
          `---\ndescription: "${cmd}"\n---\nContent of ${cmd}`
        );
      }
    }

    // agents
    if (plugin.agents) {
      const agentDir = path.join(pluginDir, 'agents');
      fs.mkdirSync(agentDir, { recursive: true });
      for (const agent of plugin.agents) {
        fs.writeFileSync(
          path.join(agentDir, `${agent}.md`),
          `---\ndescription: "${agent}"\n---\nContent of ${agent}`
        );
      }
    }

    // skills
    if (plugin.skills) {
      const skillsDir = path.join(pluginDir, 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      for (const skill of plugin.skills) {
        const skillDir = path.join(skillsDir, skill.name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.content);
      }
    }

    // rules
    if (plugin.rules) {
      const rulesDir = path.join(pluginDir, 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      for (const rule of plugin.rules) {
        fs.writeFileSync(path.join(rulesDir, `${rule.name}.md`), rule.content);
      }
    }

    // .mcp.json
    if (plugin.mcp) {
      fs.writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify(plugin.mcp));
    }
  }

  return mktDir;
}

function createCodexMarketplaceFixture(asbHome: string, marketplaceName: string): string {
  const mktDir = path.join(asbHome, 'marketplaces', marketplaceName);
  const pluginDir = path.join(mktDir, 'plugins', 'cowart');
  fs.mkdirSync(path.join(mktDir, '.agents', 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(mktDir, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: marketplaceName,
      plugins: [{ name: 'cowart', source: { source: 'local', path: './plugins/cowart' } }],
    })
  );
  fs.writeFileSync(
    path.join(pluginDir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'cowart', description: 'Cowart', version: '0.1.0' })
  );
  return mktDir;
}

function writeConfigToml(asbHome: string, content: string) {
  fs.writeFileSync(path.join(asbHome, 'config.toml'), content);
}

function initGitRepo(repoDir: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
}

function commitAll(repoDir: string): void {
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repoDir, stdio: 'ignore' });
}

function createPinnedSameOriginMarketplace(
  asbHome: string,
  name: string
): { bareRepo: string; checkoutRoot: string; marketplaceDir: string; pluginRoot: string } {
  const bareRepo = path.join(asbHome, `${name}.git`);
  const checkoutRoot = path.join(asbHome, `${name}-checkout`);
  const marketplaceDir = path.join(checkoutRoot, 'catalog');
  const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'ignore' });
  execFileSync('git', ['clone', bareRepo, checkoutRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: checkoutRoot,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], {
    cwd: checkoutRoot,
    stdio: 'ignore',
  });
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'commands', 'committed.md'), '# Committed');
  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name,
      plugins: [
        {
          name: 'pinned-plugin',
          source: {
            source: 'git-subdir',
            url: bareRepo,
            path: 'packages/plugin',
            ref: 'main',
          },
        },
      ],
    })
  );
  commitAll(checkoutRoot);
  execFileSync('git', ['push', 'origin', 'main'], { cwd: checkoutRoot, stdio: 'ignore' });
  execFileSync('git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
    cwd: checkoutRoot,
    stdio: 'ignore',
  });
  return { bareRepo, checkoutRoot, marketplaceDir, pluginRoot };
}

function createUnpinnedSameOriginMarketplace(
  asbHome: string,
  name: string
): { bareRepo: string; checkoutRoot: string; marketplaceDir: string; pluginRoot: string } {
  const fixture = createPinnedSameOriginMarketplace(asbHome, name);
  const manifestPath = path.join(fixture.marketplaceDir, '.claude-plugin', 'marketplace.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  delete manifest.plugins[0].source.ref;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  commitAll(fixture.checkoutRoot);
  execFileSync('git', ['push', 'origin', 'main'], {
    cwd: fixture.checkoutRoot,
    stdio: 'ignore',
  });
  execFileSync('git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
    cwd: fixture.checkoutRoot,
    stdio: 'ignore',
  });
  execFileSync('git', ['remote', 'set-head', 'origin', 'main'], {
    cwd: fixture.checkoutRoot,
    stdio: 'ignore',
  });
  return fixture;
}

function createRemoteSkillMarketplace(asbHome: string): {
  marketplaceDir: string;
  pluginId: string;
  skillId: string;
} {
  const remoteRepo = path.join(asbHome, 'remote-plugin.git');
  const skillDir = path.join(remoteRepo, 'skills', 'remote-skill');
  const ruleDir = path.join(remoteRepo, 'rules');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(ruleDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: remote-skill\ndescription: Remote skill\n---\nBody'
  );
  fs.writeFileSync(
    path.join(ruleDir, 'remote-rule.md'),
    '---\ntitle: Remote Rule\n---\nRemote rule body'
  );
  fs.writeFileSync(
    path.join(remoteRepo, '.mcp.json'),
    JSON.stringify({ 'remote-api': { type: 'http', url: 'https://example.com/mcp' } })
  );
  initGitRepo(remoteRepo);
  commitAll(remoteRepo);

  const marketplaceDir = path.join(asbHome, 'marketplaces', 'remote-catalog');
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'remote-catalog',
      owner: { name: 'test' },
      plugins: [
        {
          name: 'remote-plugin',
          description: 'Remote plugin',
          source: { source: 'url', url: remoteRepo },
        },
      ],
    })
  );
  return {
    marketplaceDir,
    pluginId: 'remote-plugin@remote-catalog',
    skillId: 'remote-plugin@remote-catalog:remote-skill',
  };
}

function createNativeOnlyMarketplace(asbHome: string): string {
  const mktDir = path.join(asbHome, 'marketplaces', 'native-catalog');
  fs.mkdirSync(path.join(mktDir, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(mktDir, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'native-catalog',
      plugins: [
        {
          name: 'native-package',
          version: '1.2.3',
          source: { source: 'npm', package: '@example/native-package' },
        },
      ],
    })
  );
  return mktDir;
}

// ── Tests ──────────────────────────────────────────────────────────

test('buildPluginIndex discovers marketplace plugins', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'test-marketplace', [
      {
        name: 'plugin-a',
        description: 'Plugin A',
        commands: ['cmd-one', 'cmd-two'],
        agents: ['agent-one'],
        skills: [
          {
            name: 'skill-one',
            content: '---\nname: Skill One\ndescription: A test skill\n---\nBody',
          },
        ],
      },
      {
        name: 'plugin-b',
        commands: ['cmd-three'],
      },
    ]);

    writeConfigToml(asbHome, `[plugins.sources]\ntest-marketplace = "${mktDir}"\n`);

    const index = buildPluginIndex();
    assert.equal(index.plugins.length, 2);

    const a = index.get('plugin-a');
    assert.ok(a);
    assert.equal(a.id, 'plugin-a@test-marketplace');
    assert.deepEqual(a.components.commands, [
      'plugin-a@test-marketplace:cmd-one',
      'plugin-a@test-marketplace:cmd-two',
    ]);
    assert.deepEqual(a.components.agents, ['plugin-a@test-marketplace:agent-one']);
    assert.deepEqual(a.components.skills, ['plugin-a@test-marketplace:skill-one']);
    assert.equal(a.meta.sourceKind, 'marketplace');
    assert.equal(a.meta.owner, 'test-owner');

    const b = index.get('plugin-b');
    assert.ok(b);
    assert.deepEqual(b.components.commands, ['plugin-b@test-marketplace:cmd-three']);
    assert.deepEqual(b.components.agents, []);
  });
});

test('plugin source namespace may be named source', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const marketplaceDir = createMarketplaceFixture(asbHome, 'source-catalog', [
      { name: 'demo', commands: ['one'] },
    ]);
    writeConfigToml(asbHome, `[plugins.sources]\nsource = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();

    assert.ok(index.get('demo@source'));
    assert.equal(index.get('demo@sources'), undefined);
  });
});

test('legacy plugin namespace sources still migrates from the flat format', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'legacy-sources-plugin');
    fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'commands', 'legacy.md'), '# Legacy');
    writeConfigToml(asbHome, `[plugins.sources]\nsource = "${pluginDir}"\nenabled = true\n`);

    const config = loadSwitchboardConfig();
    assert.equal(config.plugins.sources.sources, pluginDir);
    assert.deepEqual(config.plugins.enabled, ['sources']);
    assert.ok(buildPluginIndex().get('sources'));
  });
});

test('external marketplace components materialize only when selected', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir, pluginId, skillId } = createRemoteSkillMarketplace(asbHome);
    writeConfigToml(asbHome, `[plugins.sources]\nremote-catalog = "${marketplaceDir}"\n`);
    const remoteRepo = path.join(asbHome, 'remote-plugin.git');
    const offlineRepo = `${remoteRepo}.offline`;
    fs.renameSync(remoteRepo, offlineRepo);

    try {
      const listed = JSON.parse(runCli(['plugin', 'list', '--json']).stdout) as Array<{
        id: string;
        componentsResolved: boolean;
      }>;
      assert.equal(listed.find((entry) => entry.id === pluginId)?.componentsResolved, false);
      assert.equal(fs.existsSync(path.join(asbHome, 'state', 'marketplace-plugins')), false);
    } finally {
      fs.renameSync(offlineRepo, remoteRepo);
    }

    const index = buildPluginIndex();
    const plugin = index.get(pluginId);

    assert.ok(plugin);
    assert.equal(plugin.meta.description, 'Remote plugin');
    assert.deepEqual(plugin.components.skills, []);
    assert.equal(
      fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache', 'remote-catalog')),
      false
    );

    assert.equal(
      loadSkillLibrary().some((skill) => skill.id === skillId),
      false
    );
    assert.equal(
      fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache', 'remote-catalog')),
      false
    );

    assert.deepEqual(index.expand([pluginId]).skills, [skillId]);
    const selectedSkill = loadSkillLibrary().find((skill) => skill.id === skillId);
    assert.ok(selectedSkill);
    assert.equal(fs.existsSync(selectedSkill.skillPath), true);
  });
});

test('deferred marketplace descriptors reject catalog entry replacement', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir, pluginId } = createRemoteSkillMarketplace(asbHome);
    writeConfigToml(asbHome, `[plugins.sources]\nremote-catalog = "${marketplaceDir}"\n`);
    const index = buildPluginIndex();
    const plugin = index.get(pluginId);
    assert.ok(plugin);

    const manifestPath = path.join(marketplaceDir, '.claude-plugin', 'marketplace.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.plugins[0].source.url = path.join(asbHome, 'replacement.git');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    assert.throws(() => index.expand([plugin.id]), /source .* no longer active/i);
    const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
    const entries = fs.existsSync(cacheRoot)
      ? fs
          .readdirSync(cacheRoot, { recursive: true })
          .filter((entry) => String(entry).endsWith('entry.json'))
      : [];
    assert.deepEqual(entries, []);
  });
});

test('direct external component selection materializes its owning plugin', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir, pluginId, skillId } = createRemoteSkillMarketplace(asbHome);
    writeConfigToml(
      asbHome,
      [
        '[skills]',
        `enabled = ["${skillId}"]`,
        '',
        '[plugins.sources]',
        `remote-catalog = "${marketplaceDir}"`,
      ].join('\n')
    );

    const index = buildPluginIndex();
    assert.deepEqual(index.get(pluginId)?.components.skills, []);

    const resolved = resolveApplicationSectionConfig('skills', 'codex');

    assert.deepEqual(resolved.enabled, [skillId]);
    assert.equal(index.get(pluginId)?.meta.materialized, true);
    assert.equal(
      loadSkillLibrary().some((skill) => skill.id === skillId),
      true
    );
  });
});

test('configured external plugins materialize before standalone library loading', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir, pluginId, skillId } = createRemoteSkillMarketplace(asbHome);
    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        `enabled = ["${pluginId}"]`,
        '',
        '[plugins.sources]',
        `remote-catalog = "${marketplaceDir}"`,
      ].join('\n')
    );

    const skill = loadSkillLibrary().find((entry) => entry.id === skillId);

    assert.ok(skill);
    assert.equal(fs.existsSync(skill.skillPath), true);
  });
});

test('configured external plugin MCP servers materialize before MCP loading', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir, pluginId } = createRemoteSkillMarketplace(asbHome);
    const serverId = `${pluginId}:remote-api`;
    writeConfigToml(
      asbHome,
      [
        '[mcp]',
        `enabled = ["${serverId}"]`,
        '',
        '[plugins.sources]',
        `remote-catalog = "${marketplaceDir}"`,
      ].join('\n')
    );

    const config = loadMcpConfigWithPlugins();

    assert.equal(config.mcpServers[serverId]?.url, 'https://example.com/mcp');
  });
});

test('configured external plugin rules materialize before rule loading', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir, pluginId } = createRemoteSkillMarketplace(asbHome);
    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        `enabled = ["${pluginId}"]`,
        '',
        '[plugins.sources]',
        `remote-catalog = "${marketplaceDir}"`,
      ].join('\n')
    );

    const rule = loadRuleLibrary().find((entry) => entry.id === `${pluginId}:remote-rule`);

    assert.ok(rule);
    assert.equal(fs.existsSync(rule.filePath), true);
  });
});

test('buildPluginIndex reuses a same-origin git-subdir marketplace checkout', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const marketplaceDir = path.join(asbHome, 'marketplaces', 'self-catalog');
    const pluginRoot = path.join(marketplaceDir, 'skills');
    const skillDir = path.join(pluginRoot, 'ppt-master');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'self-catalog',
        owner: { name: 'test' },
        plugins: [
          {
            name: 'ppt-master',
            source: { source: 'git-subdir', url: marketplaceDir, path: 'skills', ref: 'main' },
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ppt-master', skills: './' })
    );
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: ppt-master\ndescription: Build slides\n---\nBody'
    );
    initGitRepo(marketplaceDir);
    execFileSync('git', ['remote', 'add', 'origin', marketplaceDir], {
      cwd: marketplaceDir,
      stdio: 'ignore',
    });
    commitAll(marketplaceDir);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
      cwd: marketplaceDir,
      stdio: 'ignore',
    });
    writeConfigToml(asbHome, `[plugins.sources]\nself-catalog = "${marketplaceDir}"\n`);

    const plugin = buildPluginIndex().get('ppt-master@self-catalog');

    assert.ok(plugin);
    assert.equal(plugin.meta.sourcePath, fs.realpathSync.native(pluginRoot));
    assert.deepEqual(plugin.components.skills, ['ppt-master@self-catalog:ppt-master']);
    assert.equal(
      fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache', 'self-catalog')),
      false
    );
  });
});

test('same-origin git-subdir reuse resolves from a nested marketplace checkout root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const checkoutRoot = path.join(asbHome, 'source-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'nested-catalog',
        plugins: [
          {
            name: 'nested-plugin',
            source: {
              source: 'git-subdir',
              url: checkoutRoot,
              path: 'packages/plugin',
              ref: 'main',
            },
          },
        ],
      })
    );
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'nested.md'), '# Nested');
    initGitRepo(checkoutRoot);
    execFileSync('git', ['remote', 'add', 'origin', checkoutRoot], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    commitAll(checkoutRoot);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    writeConfigToml(asbHome, `[plugins.sources]\nnested = "${marketplaceDir}"\n`);

    const plugin = buildPluginIndex().get('nested-plugin@nested');

    assert.ok(plugin);
    assert.equal(plugin.meta.sourcePath, fs.realpathSync.native(pluginRoot));
    assert.deepEqual(plugin.components.commands, ['nested-plugin@nested:nested']);
  });
});

test('pinned same-origin entries do not reuse a dirty plugin worktree', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const checkoutRoot = path.join(asbHome, 'source-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'committed.md'), '# Committed');
    fs.writeFileSync(
      path.join(checkoutRoot, '.gitignore'),
      'packages/plugin/commands/ignored.md\n'
    );
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'dirty-catalog',
        plugins: [
          {
            name: 'pinned-plugin',
            source: {
              source: 'git-subdir',
              url: checkoutRoot,
              path: 'packages/plugin',
              ref: 'main',
            },
          },
        ],
      })
    );
    initGitRepo(checkoutRoot);
    execFileSync('git', ['remote', 'add', 'origin', checkoutRoot], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    commitAll(checkoutRoot);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'dirty.md'), '# Dirty');
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'ignored.md'), '# Ignored');
    writeConfigToml(asbHome, `[plugins.sources]\ndirty = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('pinned-plugin@dirty');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, ['pinned-plugin@dirty:committed']);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
    assert.deepEqual(refreshMarketplacePluginCache(marketplaceDir, 'dirty'), {
      refreshed: 1,
      removed: 0,
    });
    assert.equal(fs.existsSync(plugin.meta.sourcePath), true);
  });
});

test('unpinned same-origin entries do not reuse dirty checkout content', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { checkoutRoot, marketplaceDir, pluginRoot } = createPinnedSameOriginMarketplace(
      asbHome,
      'unpinned-dirty-catalog'
    );
    const manifestPath = path.join(marketplaceDir, '.claude-plugin', 'marketplace.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    delete manifest.plugins[0].source.ref;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    commitAll(checkoutRoot);
    execFileSync('git', ['push', 'origin', 'main'], { cwd: checkoutRoot, stdio: 'ignore' });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'dirty.md'), '# Dirty');
    writeConfigToml(asbHome, `[plugins.sources]\nunpinned = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('pinned-plugin@unpinned');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, ['pinned-plugin@unpinned:committed']);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('unpinned same-origin reuse rejects a dirty checkout with a current remote HEAD', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { checkoutRoot, marketplaceDir, pluginRoot } = createUnpinnedSameOriginMarketplace(
      asbHome,
      'live-dirty-catalog'
    );
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'dirty.md'), '# Dirty');
    writeConfigToml(asbHome, `[plugins.sources]\nlive-dirty = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('pinned-plugin@live-dirty');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, ['pinned-plugin@live-dirty:committed']);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
    assert.equal(fs.existsSync(path.join(checkoutRoot, '.git')), true);
  });
});

test('unpinned same-origin reuse rejects a detached default-branch checkout', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { checkoutRoot, marketplaceDir } = createUnpinnedSameOriginMarketplace(
      asbHome,
      'detached-default-catalog'
    );
    execFileSync('git', ['checkout', '--detach'], { cwd: checkoutRoot, stdio: 'ignore' });
    writeConfigToml(asbHome, `[plugins.sources]\ndetached-default = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('pinned-plugin@detached-default');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('unpinned same-origin reuse follows the live remote default branch', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { bareRepo, marketplaceDir } = createUnpinnedSameOriginMarketplace(
      asbHome,
      'stale-default-catalog'
    );
    const updater = path.join(asbHome, 'stale-default-updater');
    execFileSync('git', ['clone', bareRepo, updater], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: updater,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: updater, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(updater, 'packages', 'plugin', 'commands', 'remote-only.md'),
      '# Remote'
    );
    commitAll(updater);
    execFileSync('git', ['push', 'origin', 'main'], { cwd: updater, stdio: 'ignore' });
    writeConfigToml(asbHome, `[plugins.sources]\nstale-default = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('pinned-plugin@stale-default');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, [
      'pinned-plugin@stale-default:committed',
      'pinned-plugin@stale-default:remote-only',
    ]);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('same-origin ref validation follows the remote-tracking branch', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { checkoutRoot, marketplaceDir, pluginRoot } = createPinnedSameOriginMarketplace(
      asbHome,
      'remote-ref-catalog'
    );
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'local-only.md'), '# Local');
    commitAll(checkoutRoot);
    assert.equal(
      execFileSync('git', ['rev-parse', 'main'], { cwd: checkoutRoot, encoding: 'utf-8' }).trim(),
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot, encoding: 'utf-8' }).trim()
    );
    assert.notEqual(
      execFileSync('git', ['rev-parse', 'origin/main'], {
        cwd: checkoutRoot,
        encoding: 'utf-8',
      }).trim(),
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot, encoding: 'utf-8' }).trim()
    );
    writeConfigToml(asbHome, `[plugins.sources]\nremote-ref = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('pinned-plugin@remote-ref');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, ['pinned-plugin@remote-ref:committed']);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('short-ref reuse follows a branch that moved on the live remote', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { bareRepo, marketplaceDir } = createPinnedSameOriginMarketplace(
      asbHome,
      'moved-short-ref-catalog'
    );
    const updater = path.join(asbHome, 'moved-short-ref-updater');
    execFileSync('git', ['clone', bareRepo, updater], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: updater,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: updater, stdio: 'ignore' });
    fs.writeFileSync(path.join(updater, 'packages', 'plugin', 'commands', 'moved.md'), '# Moved');
    commitAll(updater);
    execFileSync('git', ['push', 'origin', 'main'], { cwd: updater, stdio: 'ignore' });
    writeConfigToml(asbHome, `[plugins.sources]\nmoved-short-ref = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('pinned-plugin@moved-short-ref');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, [
      'pinned-plugin@moved-short-ref:committed',
      'pinned-plugin@moved-short-ref:moved',
    ]);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('short-ref reuse falls through a deleted remote branch to its same-named tag', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const bareRepo = path.join(asbHome, 'deleted-short-ref.git');
    const checkoutRoot = path.join(asbHome, 'deleted-short-ref-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
      stdio: 'ignore',
    });
    execFileSync('git', ['clone', bareRepo, checkoutRoot], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'branch.md'), '# Branch');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'deleted-short-ref-catalog',
        plugins: [
          {
            name: 'fallback-plugin',
            source: {
              source: 'git-subdir',
              url: bareRepo,
              path: 'packages/plugin',
              ref: 'collision',
            },
          },
        ],
      })
    );
    commitAll(checkoutRoot);
    execFileSync('git', ['branch', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main', 'collision'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['checkout', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync(
      'git',
      ['fetch', 'origin', '+refs/heads/collision:refs/remotes/origin/collision'],
      {
        cwd: checkoutRoot,
        stdio: 'ignore',
      }
    );

    const updater = path.join(asbHome, 'deleted-short-ref-updater');
    execFileSync('git', ['clone', bareRepo, updater], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: updater,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: updater, stdio: 'ignore' });
    fs.rmSync(path.join(updater, 'packages', 'plugin', 'commands', 'branch.md'));
    fs.writeFileSync(path.join(updater, 'packages', 'plugin', 'commands', 'tag.md'), '# Tag');
    commitAll(updater);
    execFileSync('git', ['tag', 'collision'], { cwd: updater, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'refs/tags/collision'], {
      cwd: updater,
      stdio: 'ignore',
    });
    execFileSync('git', ['push', 'origin', ':refs/heads/collision'], {
      cwd: updater,
      stdio: 'ignore',
    });
    writeConfigToml(asbHome, `[plugins.sources]\ndeleted-branch = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('fallback-plugin@deleted-branch');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, ['fallback-plugin@deleted-branch:tag']);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('short refs resolve the same branch for reuse and materialization', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const bareRepo = path.join(asbHome, 'collision.git');
    const checkoutRoot = path.join(asbHome, 'collision-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
      stdio: 'ignore',
    });
    execFileSync('git', ['clone', bareRepo, checkoutRoot], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'branch.md'), '# Branch');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'collision-catalog',
        plugins: [
          {
            name: 'branch-plugin',
            source: {
              source: 'git-subdir',
              url: bareRepo,
              path: 'packages/plugin',
              ref: 'collision',
            },
          },
          {
            name: 'tag-plugin',
            source: {
              source: 'git-subdir',
              url: bareRepo,
              path: 'packages/plugin',
              ref: 'refs/tags/collision',
            },
          },
        ],
      })
    );
    commitAll(checkoutRoot);
    execFileSync('git', ['branch', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    fs.rmSync(path.join(pluginRoot, 'commands', 'branch.md'));
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'tag.md'), '# Tag');
    commitAll(checkoutRoot);
    execFileSync('git', ['tag', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'refs/tags/collision'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['checkout', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync(
      'git',
      ['fetch', 'origin', '+refs/heads/collision:refs/remotes/origin/collision'],
      { cwd: checkoutRoot, stdio: 'ignore' }
    );
    writeConfigToml(asbHome, `[plugins.sources]\ncollision = "${marketplaceDir}"\n`);

    const cleanIndex = buildPluginIndex();
    const cleanBranch = cleanIndex.get('branch-plugin@collision');
    const tagPlugin = cleanIndex.get('tag-plugin@collision');
    assert.ok(cleanBranch);
    assert.ok(tagPlugin);
    cleanIndex.expand([cleanBranch.id, tagPlugin.id]);
    assert.deepEqual(cleanBranch.components.commands, ['branch-plugin@collision:branch']);
    assert.deepEqual(tagPlugin.components.commands, ['tag-plugin@collision:tag']);

    fs.writeFileSync(path.join(pluginRoot, 'untracked.txt'), 'dirty');
    clearPluginIndexCache();
    const dirtyIndex = buildPluginIndex();
    const dirtyBranch = dirtyIndex.get('branch-plugin@collision');
    assert.ok(dirtyBranch);
    dirtyIndex.expand([dirtyBranch.id]);

    assert.deepEqual(dirtyBranch.components.commands, ['branch-plugin@collision:branch']);
    assert.match(dirtyBranch.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('short tag-only refs reuse a compatible same-origin checkout', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const bareRepo = path.join(asbHome, 'tag-only.git');
    const checkoutRoot = path.join(asbHome, 'tag-only-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
      stdio: 'ignore',
    });
    execFileSync('git', ['clone', bareRepo, checkoutRoot], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'tagged.md'), '# Tagged');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'tag-only-catalog',
        plugins: [
          {
            name: 'tag-only-plugin',
            source: {
              source: 'git-subdir',
              url: bareRepo,
              path: 'packages/plugin',
              ref: 'release-only',
            },
          },
        ],
      })
    );
    commitAll(checkoutRoot);
    execFileSync('git', ['tag', 'release-only'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main', 'refs/tags/release-only'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    writeConfigToml(asbHome, `[plugins.sources]\ntag-only = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('tag-only-plugin@tag-only');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.equal(plugin.meta.sourcePath, fs.realpathSync.native(pluginRoot));
    assert.deepEqual(plugin.components.commands, ['tag-only-plugin@tag-only:tagged']);
    assert.equal(fs.existsSync(path.join(asbHome, 'state', 'marketplace-plugins')), false);
  });
});

test('short refs do not reuse a local tag when the remote branch exists', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const bareRepo = path.join(asbHome, 'missing-tracking.git');
    const checkoutRoot = path.join(asbHome, 'missing-tracking-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
      stdio: 'ignore',
    });
    execFileSync('git', ['clone', bareRepo, checkoutRoot], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'branch.md'), '# Branch');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'missing-tracking-catalog',
        plugins: [
          {
            name: 'branch-plugin',
            source: {
              source: 'git-subdir',
              url: bareRepo,
              path: 'packages/plugin',
              ref: 'collision',
            },
          },
        ],
      })
    );
    commitAll(checkoutRoot);
    execFileSync('git', ['branch', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    fs.rmSync(path.join(pluginRoot, 'commands', 'branch.md'));
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'tag.md'), '# Tag');
    commitAll(checkoutRoot);
    execFileSync('git', ['tag', 'collision'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main', 'refs/tags/collision'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/collision'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    writeConfigToml(asbHome, `[plugins.sources]\nmissing-tracking = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('branch-plugin@missing-tracking');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.deepEqual(plugin.components.commands, ['branch-plugin@missing-tracking:branch']);
    assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
  });
});

test('pinned same-origin reuse rejects hidden index deviations', () => {
  for (const mode of ['skip-worktree', 'assume-unchanged'] as const) {
    withTempAsbHome((asbHome) => {
      clearPluginIndexCache();
      const { checkoutRoot, marketplaceDir, pluginRoot } = createPinnedSameOriginMarketplace(
        asbHome,
        `${mode}-catalog`
      );
      const commandPath = path.join(pluginRoot, 'commands', 'committed.md');
      execFileSync('git', ['update-index', `--${mode}`, 'packages/plugin/commands/committed.md'], {
        cwd: checkoutRoot,
        stdio: 'ignore',
      });
      if (mode === 'skip-worktree') fs.rmSync(commandPath);
      else fs.writeFileSync(commandPath, '# Local');
      const relativeCommand = 'packages/plugin/commands/committed.md';
      assert.equal(
        execFileSync('git', ['status', '--porcelain=v1', '--', relativeCommand], {
          cwd: checkoutRoot,
          encoding: 'utf-8',
        }).trim(),
        ''
      );
      assert.equal(
        execFileSync('git', ['ls-files', '-v', '--', relativeCommand], {
          cwd: checkoutRoot,
          encoding: 'utf-8',
        }).trim()[0],
        mode === 'skip-worktree' ? 'S' : 'h'
      );
      writeConfigToml(asbHome, `[plugins.sources]\nhidden = "${marketplaceDir}"\n`);

      const index = buildPluginIndex();
      const plugin = index.get('pinned-plugin@hidden');
      assert.ok(plugin);
      index.expand([plugin.id]);

      assert.deepEqual(plugin.components.commands, ['pinned-plugin@hidden:committed']);
      assert.match(plugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
      assert.equal(
        fs.readFileSync(path.join(plugin.meta.sourcePath, 'commands', 'committed.md'), 'utf-8'),
        '# Committed'
      );
    });
  }
});

test('same-origin entries with incompatible pins materialize the requested commit', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const checkoutRoot = path.join(asbHome, 'source-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'stable.md'), '# Stable');
    initGitRepo(checkoutRoot);
    execFileSync('git', ['remote', 'add', 'origin', checkoutRoot], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    commitAll(checkoutRoot);
    const pinnedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutRoot,
      encoding: 'utf-8',
    }).trim();
    execFileSync('git', ['branch', 'stable'], { cwd: checkoutRoot, stdio: 'ignore' });

    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'pinned-catalog',
        plugins: [
          {
            name: 'ref-plugin',
            source: {
              source: 'git-subdir',
              url: checkoutRoot,
              path: 'packages/plugin',
              ref: 'stable',
            },
          },
          {
            name: 'sha-plugin',
            source: {
              source: 'git-subdir',
              url: checkoutRoot,
              path: 'packages/plugin',
              sha: pinnedSha,
            },
          },
        ],
      })
    );
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'head-only.md'), '# Head');
    commitAll(checkoutRoot);
    writeConfigToml(asbHome, `[plugins.sources]\npinned = "${marketplaceDir}"\n`);

    const index = buildPluginIndex();
    const refPlugin = index.get('ref-plugin@pinned');
    const shaPlugin = index.get('sha-plugin@pinned');
    assert.ok(refPlugin);
    assert.ok(shaPlugin);
    index.expand([refPlugin.id, shaPlugin.id]);

    assert.deepEqual(refPlugin.components.commands, ['ref-plugin@pinned:stable']);
    assert.deepEqual(shaPlugin.components.commands, ['sha-plugin@pinned:stable']);
    assert.match(refPlugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
    assert.match(shaPlugin.meta.sourcePath, /state[/\\]marketplace-plugins/);
    assert.equal(fs.existsSync(path.join(pluginRoot, 'commands', 'head-only.md')), true);
  });
});

test('same-origin detection distinguishes repositories on different ports', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const marketplaceDir = path.join(asbHome, 'port-catalog');
    const pluginRoot = path.join(marketplaceDir, 'packages', 'plugin');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'wrong-repo.md'), '# Wrong');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'port-catalog',
        plugins: [
          {
            name: 'external-plugin',
            source: {
              source: 'git-subdir',
              url: 'ssh://git@example.com:3333/org/repo.git',
              path: 'packages/plugin',
            },
          },
        ],
      })
    );
    initGitRepo(marketplaceDir);
    execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@example.com:2222/org/repo.git'], {
      cwd: marketplaceDir,
      stdio: 'ignore',
    });
    commitAll(marketplaceDir);
    writeConfigToml(asbHome, `[plugins.sources]\nports = "${marketplaceDir}"\n`);

    const plugin = buildPluginIndex().get('external-plugin@ports');

    assert.ok(plugin);
    assert.equal(plugin.meta.materialized, false);
    assert.deepEqual(plugin.components.commands, []);
  });
});

test('same-origin detection distinguishes SSH principals', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const marketplaceDir = path.join(asbHome, 'ssh-principal-catalog');
    const pluginRoot = path.join(marketplaceDir, 'packages', 'plugin');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'wrong-principal.md'), '# Wrong');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'ssh-principal-catalog',
        plugins: [
          {
            name: 'external-plugin',
            source: {
              source: 'git-subdir',
              url: 'ssh://bob@example.test/org/repo.git',
              path: 'packages/plugin',
            },
          },
        ],
      })
    );
    initGitRepo(marketplaceDir);
    execFileSync('git', ['remote', 'add', 'origin', 'ssh://alice@example.test/org/repo.git'], {
      cwd: marketplaceDir,
      stdio: 'ignore',
    });
    commitAll(marketplaceDir);
    writeConfigToml(asbHome, `[plugins.sources]\nssh-principal = "${marketplaceDir}"\n`);

    const plugin = buildPluginIndex().get('external-plugin@ssh-principal');

    assert.ok(plugin);
    assert.equal(plugin.meta.materialized, false);
    assert.deepEqual(plugin.components.commands, []);
  });
});

test('same-origin detection distinguishes relative and absolute SCP paths', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const marketplaceDir = path.join(asbHome, 'scp-path-catalog');
    const pluginRoot = path.join(marketplaceDir, 'packages', 'plugin');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'wrong-path.md'), '# Wrong');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'scp-path-catalog',
        plugins: [
          {
            name: 'external-plugin',
            source: {
              source: 'git-subdir',
              url: 'git@example.test:/org/repo.git',
              path: 'packages/plugin',
              ref: 'main',
            },
          },
        ],
      })
    );
    initGitRepo(marketplaceDir);
    execFileSync('git', ['remote', 'add', 'origin', 'git@example.test:org/repo.git'], {
      cwd: marketplaceDir,
      stdio: 'ignore',
    });
    commitAll(marketplaceDir);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
      cwd: marketplaceDir,
      stdio: 'ignore',
    });
    writeConfigToml(asbHome, `[plugins.sources]\nscp-path = "${marketplaceDir}"\n`);

    const plugin = buildPluginIndex().get('external-plugin@scp-path');

    assert.ok(plugin);
    assert.equal(plugin.meta.materialized, false);
    assert.deepEqual(plugin.components.commands, []);
  });
});

test('userless SCP Git sources materialize through SSH transport', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const bareRepo = path.join(asbHome, 'userless-scp.git');
    const workDir = path.join(asbHome, 'userless-scp-work');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
      stdio: 'ignore',
    });
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: workDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(workDir, 'packages', 'plugin', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'packages', 'plugin', 'commands', 'remote.md'), '# Remote');
    commitAll(workDir);
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'ignore' });

    const marketplaceDir = path.join(asbHome, 'userless-scp-catalog');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'userless-scp-catalog',
        plugins: [
          {
            name: 'userless-plugin',
            source: {
              source: 'git-subdir',
              url: `example.test:${bareRepo}`,
              path: 'packages/plugin',
              ref: 'main',
            },
          },
        ],
      })
    );
    writeConfigToml(asbHome, `[plugins.sources]\nuserless-scp = "${marketplaceDir}"\n`);
    const sshCommand = path.join(asbHome, 'fake-ssh');
    fs.writeFileSync(sshCommand, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
    fs.chmodSync(sshCommand, 0o755);
    const previousCommand = process.env.GIT_SSH_COMMAND;
    const previousVariant = process.env.GIT_SSH_VARIANT;
    process.env.GIT_SSH_COMMAND = sshCommand;
    process.env.GIT_SSH_VARIANT = 'simple';
    try {
      const index = buildPluginIndex();
      const plugin = index.get('userless-plugin@userless-scp');
      assert.ok(plugin);
      index.expand([plugin.id]);
      assert.deepEqual(plugin.components.commands, ['userless-plugin@userless-scp:remote']);
    } finally {
      if (previousCommand === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previousCommand;
      if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT;
      else process.env.GIT_SSH_VARIANT = previousVariant;
    }
  });
});

test('relative Git origins resolve from the checkout root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const bareRepo = path.join(asbHome, 'relative-origin.git');
    const checkoutRoot = path.join(asbHome, 'relative-origin-checkout');
    const marketplaceDir = path.join(checkoutRoot, 'catalog');
    const pluginRoot = path.join(checkoutRoot, 'packages', 'plugin');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
      stdio: 'ignore',
    });
    execFileSync('git', ['clone', bareRepo, checkoutRoot], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'commands', 'relative.md'), '# Relative');
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'relative-origin-catalog',
        plugins: [
          {
            name: 'relative-origin-plugin',
            source: {
              source: 'git-subdir',
              url: bareRepo,
              path: 'packages/plugin',
              ref: 'main',
            },
          },
        ],
      })
    );
    commitAll(checkoutRoot);
    execFileSync('git', ['push', 'origin', 'main'], { cwd: checkoutRoot, stdio: 'ignore' });
    execFileSync('git', ['remote', 'set-url', 'origin', '../relative-origin.git'], {
      cwd: checkoutRoot,
      stdio: 'ignore',
    });
    writeConfigToml(asbHome, `[plugins.sources]\nrelative-origin = "${marketplaceDir}"\n`);
    fs.renameSync(bareRepo, `${bareRepo}.offline`);

    const index = buildPluginIndex();
    const plugin = index.get('relative-origin-plugin@relative-origin');
    assert.ok(plugin);
    index.expand([plugin.id]);

    assert.equal(plugin.meta.sourcePath, fs.realpathSync.native(pluginRoot));
    assert.deepEqual(plugin.components.commands, [
      'relative-origin-plugin@relative-origin:relative',
    ]);
  });
});

test('buildPluginIndex discovers standalone plugin sources', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'external', 'my-lib');
    const cmdDir = path.join(pluginDir, 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'do-thing.md'), '---\ndescription: Do thing\n---\nBody');

    writeConfigToml(asbHome, `[plugins.sources]\nmy-lib = "${pluginDir}"\n`);

    const index = buildPluginIndex();

    assert.ok(!index.get('source:my-lib'), 'old source: prefix should no longer work');
    const vp = index.get('my-lib');
    assert.ok(vp);
    assert.deepEqual(vp.components.commands, ['my-lib:do-thing']);
    assert.equal(vp.meta.sourceKind, 'plugin');
    assert.equal(vp.meta.sourceName, 'my-lib');
  });
});

test('standalone plugin discovery retains its source lifecycle read lease', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'external', 'leased-plugin');
    fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'commands', 'leased.md'), '# Leased');
    writeConfigToml(asbHome, `[plugins.sources]\nleased-plugin = "${pluginDir}"\n`);

    try {
      const index = buildPluginIndex();

      assert.ok(index.get('leased-plugin'));
      assert.equal(fs.existsSync(getPluginSourceLocksDir()), true);
      assert.equal(fs.readdirSync(getPluginSourceLocksDir()).length, 1);
    } finally {
      clearPluginIndexCache();
    }
  });
});

test('buildPluginIndex rejects duplicate canonical plugin IDs', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const directDir = path.join(asbHome, 'plugins', 'foo@bar', 'commands');
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(path.join(directDir, 'direct.md'), '# Direct');
    const marketplaceDir = createMarketplaceFixture(asbHome, 'collision-marketplace', [
      { name: 'foo', commands: ['marketplace'] },
    ]);
    writeConfigToml(asbHome, `[plugins.sources]\nbar = "${marketplaceDir}"\n`);

    assert.throws(() => buildPluginIndex(), /duplicate canonical plugin id.*foo@bar/i);
  });
});

test('bare-name aliases never overwrite another plugin canonical ID', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const canonicalMarketplace = createMarketplaceFixture(asbHome, 'canonical-owner', [
      { name: 'foo', commands: ['canonical'] },
    ]);
    const aliasMarketplace = createMarketplaceFixture(asbHome, 'alias-owner', [
      { name: 'foo@bar', commands: ['alias'] },
    ]);
    writeConfigToml(
      asbHome,
      ['[plugins.sources]', `bar = "${canonicalMarketplace}"`, `baz = "${aliasMarketplace}"`].join(
        '\n'
      )
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      const index = buildPluginIndex();
      const canonicalOwner = index.get('foo@bar');
      const aliasOwner = index.get('foo@bar@baz');

      assert.equal(canonicalOwner?.id, 'foo@bar');
      assert.equal(aliasOwner?.id, 'foo@bar@baz');
      assert.equal(aliasOwner.refs.includes('foo@bar'), false);
      assert.match(warnings.join('\n'), /ambiguous plugin ref.*foo@bar/i);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('PluginIndex.expand merges components from multiple plugins', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'test-mkt', [
      { name: 'p1', commands: ['a', 'b'] },
      { name: 'p2', commands: ['c'], agents: ['x'] },
    ]);

    writeConfigToml(asbHome, `[plugins.sources]\ntest-mkt = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const expanded = index.expand(['p1', 'p2']);

    assert.deepEqual(
      expanded.commands.sort(),
      ['p1@test-mkt:a', 'p1@test-mkt:b', 'p2@test-mkt:c'].sort()
    );
    assert.deepEqual(expanded.agents, ['p2@test-mkt:x']);
    assert.deepEqual(expanded.skills, []);
  });
});

test('resolveEffectiveSectionConfig merges plugin expansion with global active', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      { name: 'my-plugin', commands: ['plugin-cmd'] },
    ]);

    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        'enabled = ["my-plugin"]',
        '',
        '[plugins.sources]',
        `mkt = "${mktDir}"`,
        '',
        '[commands]',
        'enabled = ["local-cmd"]',
        '',
        '[applications]',
        'enabled = ["claude-code"]',
      ].join('\n')
    );

    const result = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.ok(result.enabled.includes('local-cmd'));
    assert.ok(result.enabled.includes('my-plugin@mkt:plugin-cmd'));
  });
});

test('plugins.exclude removes specific entries from expansion', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      { name: 'my-plugin', commands: ['keep-cmd', 'drop-cmd'], agents: ['keep-agent'] },
    ]);

    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        'enabled = ["my-plugin"]',
        '',
        '[plugins.sources]',
        `mkt = "${mktDir}"`,
        '',
        '[plugins.exclude]',
        'commands = ["my-plugin:drop-cmd"]',
        '',
        '[applications]',
        'enabled = ["claude-code"]',
      ].join('\n')
    );

    const result = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.ok(result.enabled.includes('my-plugin@mkt:keep-cmd'));
    assert.ok(!result.enabled.includes('my-plugin@mkt:drop-cmd'));

    const agentResult = resolveEffectiveSectionConfig('agents', 'claude-code');
    assert.ok(agentResult.enabled.includes('my-plugin@mkt:keep-agent'));
  });
});

test('enabled plugins expand to commands for all active applications', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      { name: 'p1', commands: ['p1-cmd'] },
      { name: 'p2', commands: ['p2-cmd'] },
    ]);

    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        'enabled = ["p1", "p2"]',
        '',
        '[plugins.sources]',
        `mkt = "${mktDir}"`,
        '',
        '[applications]',
        'enabled = ["claude-code", "codex"]',
      ].join('\n')
    );

    const ccResult = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.ok(ccResult.enabled.includes('p1@mkt:p1-cmd'));
    assert.ok(ccResult.enabled.includes('p2@mkt:p2-cmd'));

    const codexResult = resolveEffectiveSectionConfig('commands', 'codex');
    assert.ok(codexResult.enabled.includes('p1@mkt:p1-cmd'));
    assert.ok(codexResult.enabled.includes('p2@mkt:p2-cmd'));
  });
});

test('application plugin add and remove normalize bare and source-qualified aliases', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'app-selection', [
      { name: 'plugin-a', commands: ['a-one'] },
      { name: 'plugin-b', commands: ['b-one', 'b-two'] },
    ]);
    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[plugins]',
        'enabled = ["plugin-a"]',
        '',
        '[plugins.sources]',
        `app-selection = "${mktDir}"`,
        '',
        '[applications.codex.plugins]',
        'remove = ["plugin-a@app-selection"]',
        'add = ["plugin-b"]',
        '',
        '[applications.codex.commands]',
        'remove = ["plugin-b@app-selection:b-one"]',
        'add = ["manual-command"]',
      ].join('\n')
    );

    assert.deepEqual(resolveEffectiveSectionConfig('commands', 'claude-code').enabled, [
      'plugin-a@app-selection:a-one',
    ]);
    assert.deepEqual(resolveEffectiveSectionConfig('commands', 'codex').enabled, [
      'plugin-b@app-selection:b-two',
      'manual-command',
    ]);
  });
});

test('application removals do not materialize unselected external plugin aliases', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir } = createRemoteSkillMarketplace(asbHome);
    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'enabled = ["codex"]',
        '',
        '[plugins]',
        'enabled = ["remote-plugin"]',
        '',
        '[skills]',
        'enabled = ["remote-plugin:remote-skill"]',
        '',
        '[plugins.sources]',
        `remote-catalog = "${marketplaceDir}"`,
        '',
        '[applications.codex.plugins]',
        'remove = ["remote-plugin@remote-catalog"]',
        '',
        '[applications.codex.skills]',
        'remove = ["remote-plugin@remote-catalog:remote-skill"]',
      ].join('\n')
    );

    assert.equal(
      loadSkillLibrary().some((skill) => skill.id.includes('remote-plugin')),
      false
    );
    assert.deepEqual(resolveEffectiveSectionConfig('skills', 'codex').enabled, []);
    assert.equal(fs.existsSync(path.join(asbHome, 'state', 'marketplace-plugins')), false);
  });
});

test('plugin excludes do not remove an explicitly enabled component', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'exclude-boundary', [
      { name: 'plugin-a', commands: ['keep-explicit'] },
    ]);
    writeConfigToml(
      asbHome,
      [
        '[commands]',
        'enabled = ["plugin-a@exclude-boundary:keep-explicit"]',
        '',
        '[plugins]',
        'enabled = ["plugin-a"]',
        '',
        '[plugins.sources]',
        `exclude-boundary = "${mktDir}"`,
        '',
        '[plugins.exclude]',
        'commands = ["plugin-a@exclude-boundary:keep-explicit"]',
      ].join('\n')
    );

    assert.deepEqual(resolveEffectiveSectionConfig('commands', 'claude-code').enabled, [
      'plugin-a@exclude-boundary:keep-explicit',
    ]);
  });
});

test('plugin list JSON emits one canonical ref and recognizes bare enabled aliases', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'json-catalog', [
      { name: 'plugin-a', commands: ['command-a'] },
    ]);
    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        'enabled = ["plugin-a"]',
        '',
        '[plugins.sources]',
        `catalog = "${mktDir}"`,
      ].join('\n')
    );

    const plugins = JSON.parse(runCli(['plugin', 'list', '--json']).stdout) as Array<{
      id: string;
      ref: string;
      enabled: boolean;
      materialized?: boolean;
      componentsResolved: boolean;
    }>;

    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].id, 'plugin-a@catalog');
    assert.equal(plugins[0].ref, plugins[0].id);
    assert.equal(plugins[0].enabled, true);
    assert.equal('materialized' in plugins[0], false);
    assert.equal(plugins[0].componentsResolved, true);
  });
});

test('plugin list JSON reports effective per-application enablement', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'app-json-catalog', [
      { name: 'plugin-a', commands: ['command-a'] },
    ]);
    const list = () =>
      JSON.parse(runCli(['plugin', 'list', '--json']).stdout) as Array<{
        id: string;
        enabled: boolean;
      }>;

    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'enabled = ["codex"]',
        '',
        '[plugins.sources]',
        `catalog = "${mktDir}"`,
        '',
        '[applications.codex.plugins]',
        'add = ["plugin-a"]',
      ].join('\n')
    );
    assert.equal(list().find((plugin) => plugin.id === 'plugin-a@catalog')?.enabled, true);

    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'enabled = ["codex"]',
        '',
        '[plugins]',
        'enabled = ["plugin-a"]',
        '',
        '[plugins.sources]',
        `catalog = "${mktDir}"`,
        '',
        '[applications.codex.plugins]',
        'remove = ["plugin-a@catalog"]',
      ].join('\n')
    );
    assert.equal(list().find((plugin) => plugin.id === 'plugin-a@catalog')?.enabled, false);
  });
});

test('plugin enable and disable treat bare and canonical refs as one selection', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'alias-actions', [
      { name: 'plugin-a', commands: ['command-a'] },
    ]);
    const config = [
      '[plugins]',
      'enabled = ["plugin-a"]',
      '',
      '[plugins.sources]',
      `catalog = "${mktDir}"`,
    ].join('\n');
    writeConfigToml(asbHome, config);

    const disabled = runCli(['plugin', 'disable', 'plugin-a@catalog']);
    assert.match(disabled.stdout, /disabled/);
    assert.doesNotMatch(fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8'), /plugin-a/);

    writeConfigToml(asbHome, config);
    const enabled = runCli(['plugin', 'enable', 'plugin-a@catalog']);
    assert.match(enabled.stdout, /already enabled/);
    assert.equal(
      fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8').match(/plugin-a/g)?.length,
      1
    );
  });
});

test('plugin enable persists the canonical ID and removes equivalent aliases', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'canonical-enable', [
      { name: 'plugin-a', commands: ['command-a'] },
    ]);
    writeConfigToml(asbHome, `[plugins.sources]\ncatalog = "${mktDir}"\n`);

    runCli(['plugin', 'enable', 'plugin-a']);
    assert.deepEqual(loadSwitchboardConfig().plugins.enabled, ['plugin-a@catalog']);

    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        'enabled = ["plugin-a", "plugin-a@catalog"]',
        '',
        '[plugins.sources]',
        `catalog = "${mktDir}"`,
      ].join('\n')
    );
    runCli(['plugin', 'enable', 'plugin-a@catalog']);

    assert.deepEqual(loadSwitchboardConfig().plugins.enabled, ['plugin-a@catalog']);
  });
});

test('plugin marketplace CLI output redacts credential-bearing source URLs', () => {
  withTempAsbHome((asbHome) => {
    const binDir = path.join(asbHome, 'bin');
    const fakeGit = path.join(binDir, 'git');
    const transportRepo = path.join(asbHome, 'transport-repo');
    fs.mkdirSync(path.join(transportRepo, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(transportRepo, 'rules', 'remote.md'), '# Remote rule\n');
    initGitRepo(transportRepo);
    commitAll(transportRepo);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      fakeGit,
      [
        '#!/bin/sh',
        'if [ "$1" = "clone" ]; then',
        '  "$REAL_GIT" clone --depth 1 "$FAKE_REMOTE" "$5" || exit $?',
        '  exec "$REAL_GIT" -C "$5" remote set-url origin "$4"',
        'fi',
        'exec "$REAL_GIT" "$@"',
      ].join('\n')
    );
    fs.chmodSync(fakeGit, 0o755);
    const secretUrl =
      'https://alice:password@example.test/repo.git?access_token=query-secret#fragment-secret';
    const entry = path.join(process.cwd(), 'src', 'index.ts');
    const env = {
      ...process.env,
      FAKE_REMOTE: transportRepo,
      FORCE_COLOR: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      REAL_GIT: realGit,
    };
    const added = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--enable-source-maps',
        entry,
        'plugin',
        'marketplace',
        'add',
        secretUrl,
        'redacted-source',
      ],
      { env, encoding: 'utf-8' }
    );

    assert.equal(added.status, 0, added.stderr);
    assert.doesNotMatch(
      `${added.stdout}${added.stderr}`,
      /alice|password|query-secret|fragment-secret/
    );
    const configured = loadSwitchboardConfig().plugins.sources['redacted-source'];
    assert.equal(typeof configured === 'object' ? configured.url : undefined, secretUrl);

    const listed = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--enable-source-maps', entry, 'plugin', 'marketplace', 'list', '--json'],
      { env, encoding: 'utf-8' }
    );
    assert.equal(listed.status, 0, listed.stderr);
    assert.doesNotMatch(
      `${listed.stdout}${listed.stderr}`,
      /alice|password|query-secret|fragment-secret/
    );
  });
});

test('redactGitCredentials redacts complete URL and SCP-style principals', () => {
  assert.equal(
    redactGitCredentials(
      'https://alice:p@ss@example.test/repo.git?access_token=query-secret#fragment-secret'
    ),
    'https://<redacted>@example.test/repo.git?access_token=<redacted>#<redacted>'
  );
  assert.equal(
    redactGitCredentials('oauth2-secret@github.com:org/private.git'),
    '<redacted>@github.com:org/private.git'
  );
});

test('CLI help renders the fresh-home config path from the path resolver', () => {
  withTempAsbHome((asbHome) => {
    const freshHome = path.join(asbHome, 'fresh-home');
    fs.mkdirSync(freshHome, { recursive: true });

    const { stdout } = runCli(['--help'], {
      ASB_CONFIG: '',
      ASB_HOME: '',
      HOME: freshHome,
    });

    assert.ok(stdout.includes(path.join(freshHome, '.asb', 'config.toml')));
    assert.doesNotMatch(stdout, /\.agent-switchboard\/config\.toml/);
  });
});

test('plugin marketplace list shows only configured sources and checkout status', () => {
  withTempAsbHome((asbHome) => {
    const configuredUrl = 'https://example.test/managed.git';
    fs.mkdirSync(path.join(asbHome, 'plugins', 'direct-source', 'rules'), { recursive: true });
    const transportRepo = path.join(asbHome, 'managed-transport');
    fs.mkdirSync(path.join(transportRepo, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(transportRepo, 'rules', 'managed.md'), '# Managed rule\n');
    initGitRepo(transportRepo);
    commitAll(transportRepo);
    const managedSource = path.join(asbHome, 'plugins', 'managed-source');
    execFileSync('git', ['clone', transportRepo, managedSource], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'set-url', 'origin', configuredUrl], {
      cwd: managedSource,
      stdio: 'ignore',
    });
    writeConfigToml(
      asbHome,
      `[plugins.sources]\nmanaged-source = { url = "${configuredUrl}", type = "clone" }\n`
    );

    const json = JSON.parse(runCli(['plugin', 'marketplace', 'list', '--json']).stdout) as Array<{
      namespace: string;
    }>;
    assert.deepEqual(
      json.map((source) => source.namespace),
      ['managed-source']
    );

    const { stdout } = runCli(['plugin', 'marketplace', 'list']);
    assert.match(stdout, /Configured plugin sources:/);
    assert.doesNotMatch(stdout, /Marketplace sources:/);
    assert.match(stdout, /managed-source/);
    assert.doesNotMatch(stdout, /direct-source/);
    assert.match(stdout, /checked out/);
    assert.doesNotMatch(stdout, /\bcached\b/);
  });
});

test('plugin source CLI labels distinguish discovery from configured management', () => {
  withTempAsbHome(() => {
    const inventoryHelp = runCli(['plugin', 'list', '--help']).stdout;
    assert.match(inventoryHelp, /discoverable plugin sources/);

    const inventory = runCli(['plugin', 'list']).stdout;
    assert.match(inventory, /discoverable plugin sources/);

    const managementHelp = runCli(['plugin', 'marketplace', 'list', '--help']).stdout;
    assert.match(managementHelp, /configured plugin sources/);

    const management = runCli(['plugin', 'marketplace', 'list']).stdout;
    assert.match(management, /No configured plugin sources/);
  });
});

test('plugin marketplace remove accepts an owned checkout with invalid Git metadata', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createPinnedSameOriginMarketplace(asbHome, 'broken-source-remote');
    addRemoteSource('broken-source', { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(asbHome, 'plugins', 'broken-source');
    fs.rmSync(path.join(checkout, '.git', 'HEAD'));

    const { stdout } = runCli(['plugin', 'marketplace', 'remove', 'broken-source']);

    assert.match(stdout, /Removed source "broken-source"/);
    assert.equal(fs.existsSync(checkout), false);
    assert.deepEqual(loadSwitchboardConfig().plugins.sources, {});
  });
});

test('plugin rules are loaded into rule library', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    fs.mkdirSync(path.join(asbHome, 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(asbHome, 'rules', 'local-rule.md'),
      '---\ntitle: Local Rule\n---\nLocal rule content'
    );

    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      {
        name: 'my-plugin',
        rules: [
          { name: 'plugin-rule', content: '---\ntitle: Plugin Rule\n---\nPlugin rule content' },
        ],
      },
    ]);

    writeConfigToml(asbHome, `[plugins.sources]\nmkt = "${mktDir}"\n`);

    const rules = loadRuleLibrary();
    const ids = rules.map((r) => r.id);
    assert.ok(ids.includes('local-rule'));
    assert.ok(ids.includes('my-plugin@mkt:plugin-rule'));
  });
});

test('marketplace plugin rule parse errors include the source file', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'broken-rules', [
      {
        name: 'broken-plugin',
        rules: [{ name: 'broken-rule', content: '---\ninvalid\n' }],
      },
    ]);
    writeConfigToml(asbHome, `[plugins.sources]\nbroken-rules = "${mktDir}"\n`);

    assert.ok(buildPluginIndex().get('broken-plugin@broken-rules'));
    assert.throws(
      () => loadRuleLibrary(),
      /Failed to parse rule snippet "broken-rule\.md": Rule frontmatter is missing a closing delimiter/
    );
    assert.deepEqual(fs.readdirSync(getPluginSourceLocksDir()), []);
  });
});

test('plugin MCP servers are merged into config', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    fs.writeFileSync(
      path.join(asbHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'local-server': { url: 'http://localhost:8080' } } })
    );

    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      {
        name: 'my-plugin',
        mcp: { 'remote-api': { url: 'https://api.example.com/mcp', type: 'http' } },
      },
    ]);

    writeConfigToml(
      asbHome,
      `[plugins]\nenabled = ["my-plugin"]\n\n[plugins.sources]\nmkt = "${mktDir}"\n`
    );

    const config = loadMcpConfigWithPlugins();
    assert.ok('local-server' in config.mcpServers);
    assert.ok('my-plugin@mkt:remote-api' in config.mcpServers);
  });
});

test('buildPluginIndex silently skips valid GitHub Copilot v1 hook files', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'external', 'copilot-hook-plugin');
    fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'commands', 'do-thing.md'),
      '---\ndescription: Do thing\n---\nBody'
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'copilot-hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: 'command',
              bash: 'node "hooks/start.js"',
              powershell: 'node "hooks\\start.js"',
              timeoutSec: 5,
            },
          ],
        },
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'disabled-copilot-hooks.json'),
      JSON.stringify({ version: 1, disableAllHooks: true, hooks: {} })
    );

    writeConfigToml(asbHome, `[plugins.sources]\ncopilot-hook-plugin = "${pluginDir}"\n`);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const index = buildPluginIndex();
      const plugin = index.get('copilot-hook-plugin');

      assert.ok(plugin);
      assert.deepEqual(plugin.components.commands, ['copilot-hook-plugin:do-thing']);
      assert.deepEqual(plugin.components.hooks, []);
      assert.equal(
        warnings.some((w) => w.includes('copilot-hooks.json')),
        false
      );
      assert.equal(
        warnings.some((w) => w.includes('disabled-copilot-hooks.json')),
        false
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('buildPluginIndex warns and skips malformed single-file plugin hooks', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'external', 'broken-hook-plugin');
    fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'commands', 'do-thing.md'),
      '---\ndescription: Do thing\n---\nBody'
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ command: './hooks/session-start' }],
        },
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'broken-copilot-hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { postToolUse: [{ type: 'http', url: 'not-a-url' }] },
      })
    );

    writeConfigToml(asbHome, `[plugins.sources]\nbroken-hook-plugin = "${pluginDir}"\n`);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const index = buildPluginIndex();
      const plugin = index.get('broken-hook-plugin');

      assert.ok(plugin);
      assert.deepEqual(plugin.components.commands, ['broken-hook-plugin:do-thing']);
      assert.deepEqual(plugin.components.hooks, []);
      assert.ok(warnings.some((w) => w.includes('hooks.json')));
      assert.ok(warnings.some((w) => w.includes('broken-copilot-hooks.json')));
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('plugin MCP servers are available even when selected directly without enabling the parent plugin', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    fs.writeFileSync(path.join(asbHome, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      {
        name: 'my-plugin',
        mcp: { 'remote-api': { url: 'https://api.example.com/mcp', type: 'http' } },
      },
    ]);

    writeConfigToml(
      asbHome,
      `[mcp]\nenabled = ["my-plugin@mkt:remote-api"]\n\n[plugins.sources]\nmkt = "${mktDir}"\n`
    );

    const config = loadMcpConfigWithPlugins();
    assert.ok('my-plugin@mkt:remote-api' in config.mcpServers);
  });
});

test('project-scoped plugin sources are isolated from global cache and load project content', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    writeConfigToml(asbHome, '[applications]\nenabled = ["claude-code"]\n');

    const projectRoot = path.join(asbHome, 'project');
    const projectPluginDir = path.join(projectRoot, 'proj-lib');
    fs.mkdirSync(path.join(projectPluginDir, 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPluginDir, 'rules', 'project-rule.md'),
      '---\ntitle: Project Rule\n---\nProject rule content'
    );
    fs.writeFileSync(
      path.join(projectPluginDir, '.mcp.json'),
      JSON.stringify({
        alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
      })
    );
    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      [
        '[plugins]',
        'enabled = ["proj-lib"]',
        '',
        '[plugins.sources]',
        `proj-lib = "${projectPluginDir}"`,
      ].join('\n')
    );

    const globalIndex = buildPluginIndex();
    const projectIndex = buildPluginIndex({ project: projectRoot });
    const projectRules = loadRuleLibrary({ project: projectRoot });
    const projectMcp = loadMcpConfigWithPlugins({ project: projectRoot });

    assert.equal(globalIndex.get('proj-lib'), undefined);
    assert.ok(projectIndex.get('proj-lib'));
    assert.ok(projectRules.some((rule) => rule.id === 'proj-lib:project-rule'));
    assert.ok('proj-lib:alpha' in projectMcp.mcpServers);
  });
});

test('plugin mcpServers from marketplace entry are loaded correctly', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    fs.writeFileSync(path.join(asbHome, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      {
        name: 'mcp-plugin',
        mcp: { 'my-server': { command: 'echo', args: ['hello'], type: 'stdio' } },
      },
    ]);

    writeConfigToml(
      asbHome,
      `[plugins]\nenabled = ["mcp-plugin"]\n\n[plugins.sources]\nmkt = "${mktDir}"\n`
    );

    const config = loadMcpConfigWithPlugins();
    assert.ok('mcp-plugin@mkt:my-server' in config.mcpServers, 'server from manifest should exist');
  });
});

test('old config without plugins section works (backward compatibility)', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[commands]',
        'enabled = ["my-cmd"]',
      ].join('\n')
    );

    const result = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.deepEqual(result.enabled, ['my-cmd']);
  });
});

test('strict mode: marketplace entry commands override plugin.json', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'strict-test');
    const pluginDir = path.join(mktDir, 'my-plugin');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });

    // Custom commands path directory
    const customCmdDir = path.join(pluginDir, 'custom-commands');
    fs.mkdirSync(customCmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(customCmdDir, 'special.md'),
      '---\ndescription: special\n---\nSpecial content'
    );

    // Default commands dir (should be ignored in strict mode with custom paths)
    const defaultCmdDir = path.join(pluginDir, 'commands');
    fs.mkdirSync(defaultCmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultCmdDir, 'default.md'),
      '---\ndescription: default\n---\nDefault content'
    );

    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin' })
    );

    // Marketplace manifest with strict:true and custom commands path
    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'strict-test',
        owner: { name: 'test' },
        plugins: [
          {
            name: 'my-plugin',
            source: './my-plugin',
            strict: true,
            commands: ['custom-commands'],
          },
        ],
      })
    );

    writeConfigToml(asbHome, `[plugins.sources]\nstrict-test = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('my-plugin');
    assert.ok(plugin);
    assert.deepEqual(plugin.components.commands, ['my-plugin@strict-test:special']);
  });
});

test('non-strict mode: plugin.json values used as fallback', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'nonstrict-test');
    const pluginDir = path.join(mktDir, 'my-plugin');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });

    // Plugin.json with custom commands path
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'my-plugin',
        commands: ['alt-commands'],
      })
    );

    // Alt commands directory
    const altCmdDir = path.join(pluginDir, 'alt-commands');
    fs.mkdirSync(altCmdDir, { recursive: true });
    fs.writeFileSync(path.join(altCmdDir, 'alt.md'), '---\ndescription: alt\n---\nAlt content');

    // Marketplace manifest with strict:false
    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'nonstrict-test',
        owner: { name: 'test' },
        plugins: [
          {
            name: 'my-plugin',
            source: './my-plugin',
            strict: false,
          },
        ],
      })
    );

    writeConfigToml(asbHome, `[plugins.sources]\nnonstrict-test = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('my-plugin');
    assert.ok(plugin);
    assert.deepEqual(plugin.components.commands, ['my-plugin@nonstrict-test:alt']);
  });
});

test('marketplace plugin honors plugin.json custom skills root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'ppt-official');
    const pluginDir = path.join(mktDir, 'skills');
    const skillDir = path.join(pluginDir, 'ppt-master');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });

    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'ppt-official',
        owner: { name: 'test' },
        plugins: [{ name: 'ppt-master', source: './skills', strict: false }],
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ppt-master', skills: './' })
    );
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: ppt-master\ndescription: Build PPTX decks\n---\nSkill body'
    );
    writeConfigToml(asbHome, `[plugins.sources]\nppt-official = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('ppt-master@ppt-official');
    assert.ok(plugin);
    assert.deepEqual(plugin.components.skills, ['ppt-master@ppt-official:ppt-master']);
    assert.ok(
      loadSkillLibrary().some((skill) => skill.id === 'ppt-master@ppt-official:ppt-master')
    );
  });
});

test('strict marketplace entry supports direct SKILL.md custom path', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'strict-skills');
    const pluginDir = path.join(mktDir, 'my-plugin');
    const customSkillDir = path.join(pluginDir, 'custom-skills', 'special');
    const defaultSkillDir = path.join(pluginDir, 'skills', 'default');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.mkdirSync(defaultSkillDir, { recursive: true });

    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'strict-skills',
        owner: { name: 'test' },
        plugins: [
          {
            name: 'my-plugin',
            source: './my-plugin',
            skills: 'custom-skills/special/SKILL.md',
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin' })
    );
    fs.writeFileSync(
      path.join(customSkillDir, 'SKILL.md'),
      '---\nname: special\ndescription: Special skill\n---\nSpecial body'
    );
    fs.writeFileSync(
      path.join(defaultSkillDir, 'SKILL.md'),
      '---\nname: default\ndescription: Default skill\n---\nDefault body'
    );
    writeConfigToml(asbHome, `[plugins.sources]\nstrict-skills = "${mktDir}"\n`);

    const plugin = buildPluginIndex().get('my-plugin');
    assert.ok(plugin);
    assert.deepEqual(plugin.components.skills, ['my-plugin@strict-skills:special']);
  });
});

test('marketplace custom component paths cannot escape the plugin root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'contained-components');
    const pluginDir = path.join(mktDir, 'my-plugin');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(mktDir, 'outside.md'),
      '---\ndescription: outside\n---\nMust not load'
    );
    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'contained-components',
        plugins: [
          {
            name: 'my-plugin',
            source: './my-plugin',
            commands: ['../outside.md'],
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin' })
    );
    writeConfigToml(asbHome, `[plugins.sources]\ncontained = "${mktDir}"\n`);

    assert.throws(() => buildPluginIndex(), /component path escapes the plugin root/);
  });
});

test('marketplace component roots cannot follow symlinks outside the plugin', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'contained-symlinks');
    const pluginDir = path.join(mktDir, 'my-plugin');
    const outsideSkills = path.join(mktDir, 'outside-skills');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(outsideSkills, 'secret'), { recursive: true });
    fs.writeFileSync(
      path.join(outsideSkills, 'secret', 'SKILL.md'),
      '---\nname: secret\ndescription: Must not load\n---\nSecret'
    );
    fs.symlinkSync(outsideSkills, path.join(pluginDir, 'skills'));
    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'contained-symlinks',
        plugins: [{ name: 'my-plugin', source: './my-plugin' }],
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin' })
    );
    writeConfigToml(asbHome, `[plugins.sources]\ncontained = "${mktDir}"\n`);

    assert.throws(() => buildPluginIndex(), /component path escapes the plugin root/);
  });
});

test('plugin rules cannot follow a symlink outside the plugin root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'contained-rules', [{ name: 'my-plugin' }]);
    const pluginDir = path.join(mktDir, 'plugins', 'my-plugin');
    const outsideRules = path.join(asbHome, 'outside-rules');
    fs.mkdirSync(outsideRules, { recursive: true });
    fs.writeFileSync(path.join(outsideRules, 'secret.md'), '# Secret');
    fs.symlinkSync(outsideRules, path.join(pluginDir, 'rules'));
    writeConfigToml(asbHome, `[plugins.sources]\ncontained = "${mktDir}"\n`);

    assert.throws(() => buildPluginIndex(), /component path escapes the plugin root/);
  });
});

test('plugin MCP config cannot follow a symlink outside the plugin root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'contained-mcp', [{ name: 'my-plugin' }]);
    const pluginDir = path.join(mktDir, 'plugins', 'my-plugin');
    const outsideMcp = path.join(asbHome, 'outside-mcp.json');
    fs.writeFileSync(outsideMcp, JSON.stringify({ secret: { command: 'secret' } }));
    fs.symlinkSync(outsideMcp, path.join(pluginDir, '.mcp.json'));
    writeConfigToml(asbHome, `[plugins.sources]\ncontained = "${mktDir}"\n`);

    assert.throws(() => buildPluginIndex(), /component path escapes the plugin root/);
  });
});

test('plugin manifests cannot follow a symlink outside the plugin root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'contained-manifest', [
      { name: 'my-plugin', commands: ['safe'] },
    ]);
    const pluginDir = path.join(mktDir, 'plugins', 'my-plugin');
    const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    const outsideManifest = path.join(asbHome, 'outside-plugin.json');
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({ name: 'my-plugin', description: 'Must not load' })
    );
    fs.rmSync(manifestPath);
    fs.symlinkSync(outsideManifest, manifestPath);
    writeConfigToml(asbHome, `[plugins.sources]\ncontained = "${mktDir}"\n`);

    const plugin = buildPluginIndex().get('my-plugin@contained');
    assert.ok(plugin);
    assert.equal(plugin.meta.description, undefined);
    assert.deepEqual(plugin.components.commands, ['my-plugin@contained:safe']);
  });
});

test('marketplace manifests cannot follow a symlink outside their source root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const sourceDir = path.join(asbHome, 'catalog-source');
    const manifestDir = path.join(sourceDir, '.claude-plugin');
    const outsideManifest = path.join(asbHome, 'outside-marketplace.json');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({
        name: 'outside',
        plugins: [{ name: 'secret', source: './secret' }],
      })
    );
    fs.symlinkSync(outsideManifest, path.join(manifestDir, 'marketplace.json'));
    writeConfigToml(asbHome, `[plugins.sources]\ncontained = "${sourceDir}"\n`);

    assert.equal(buildPluginIndex().get('secret@contained'), undefined);
  });
});

test('relative marketplace plugin sources cannot escape the marketplace root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'contained-sources');
    const outsidePlugin = path.join(asbHome, 'marketplaces', 'outside-plugin');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(outsidePlugin, 'skills', 'secret'), { recursive: true });
    fs.writeFileSync(
      path.join(outsidePlugin, 'skills', 'secret', 'SKILL.md'),
      '---\nname: secret\ndescription: Must not load\n---\nSecret'
    );
    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'contained-sources',
        plugins: [{ name: 'outside-plugin', source: '../outside-plugin' }],
      })
    );
    writeConfigToml(asbHome, `[plugins.sources]\ncontained = "${mktDir}"\n`);

    assert.equal(buildPluginIndex().get('outside-plugin@contained'), undefined);
  });
});

test('marketplace default skills scan ignores non-path native skills metadata', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'native-skills-metadata');
    const pluginDir = path.join(mktDir, 'my-plugin');
    const skillRoot = path.join(pluginDir, 'skills');
    const childSkillDir = path.join(skillRoot, 'child');
    fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(childSkillDir, { recursive: true });

    fs.writeFileSync(
      path.join(mktDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'native-skills-metadata',
        owner: { name: 'test' },
        plugins: [{ name: 'my-plugin', source: './my-plugin', skills: [{ name: 'native' }] }],
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin' })
    );
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: root\ndescription: Root metadata\n---\nRoot body'
    );
    fs.writeFileSync(
      path.join(childSkillDir, 'SKILL.md'),
      '---\nname: child\ndescription: Child skill\n---\nChild body'
    );
    writeConfigToml(asbHome, `[plugins.sources]\nnative-skills-metadata = "${mktDir}"\n`);

    const plugin = buildPluginIndex().get('my-plugin');
    assert.ok(plugin);
    assert.deepEqual(plugin.components.skills, ['my-plugin@native-skills-metadata:child']);
  });
});

test('PluginIndex.get supports @source disambiguation', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'demo-mkt', [
      { name: 'context7', description: 'From marketplace', commands: ['ctx-cmd'] },
    ]);

    writeConfigToml(asbHome, `[plugins.sources]\ndemo-mkt = "${mktDir}"\n`);

    const index = buildPluginIndex();

    // Direct name lookup
    const direct = index.get('context7');
    assert.ok(direct);
    assert.equal(direct.meta.sourceName, 'demo-mkt');

    // @source disambiguation
    const bySource = index.get('context7@demo-mkt');
    assert.ok(bySource);
    assert.equal(bySource.id, 'context7@demo-mkt');

    // Wrong @source returns undefined
    assert.equal(index.get('context7@other-source'), undefined);
  });
});

test('PluginIndex.expand resolves @source references in pluginIds', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'my-mkt', [
      { name: 'p1', commands: ['cmd-a'] },
    ]);

    writeConfigToml(asbHome, `[plugins.sources]\nmy-mkt = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const expanded = index.expand(['p1@my-mkt']);
    assert.deepEqual(expanded.commands, ['p1@my-mkt:cmd-a']);
  });
});

test('legacy bare component refs normalize to source-qualified marketplace IDs', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      { name: 'my-plugin', commands: ['plugin-cmd'] },
    ]);

    writeConfigToml(
      asbHome,
      [
        '[commands]',
        'enabled = ["my-plugin:plugin-cmd"]',
        '',
        '[plugins.sources]',
        `mkt = "${mktDir}"`,
        '',
        '[applications]',
        'enabled = ["claude-code"]',
      ].join('\n')
    );

    const result = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.deepEqual(result.enabled, ['my-plugin@mkt:plugin-cmd']);
  });
});

test('legacy bare MCP refs normalize through state loading', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'mkt', [
      { name: 'my-plugin', mcp: { api: { command: 'echo', args: ['hi'], type: 'stdio' } } },
    ]);

    writeConfigToml(
      asbHome,
      ['[mcp]', 'enabled = ["my-plugin:api"]', '', '[plugins.sources]', `mkt = "${mktDir}"`].join(
        '\n'
      )
    );

    assert.deepEqual(loadMcpEnabledState(), ['my-plugin@mkt:api']);
  });
});

test('same-name marketplace plugins keep source-qualified component IDs distinct', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const communityDir = createMarketplaceFixture(asbHome, 'community', [
      { name: 'demo', commands: ['shared'], mcp: { alpha: { command: 'echo', args: ['a'] } } },
    ]);
    const internalDir = createMarketplaceFixture(asbHome, 'internal', [
      { name: 'demo', commands: ['shared'], mcp: { beta: { command: 'echo', args: ['b'] } } },
    ]);

    writeConfigToml(
      asbHome,
      [
        '[plugins]',
        'enabled = ["demo@community"]',
        '',
        '[plugins.sources]',
        `community = "${communityDir}"`,
        `internal = "${internalDir}"`,
      ].join('\n')
    );

    const index = buildPluginIndex();
    const expanded = index.expand(['demo@community', 'demo@internal']);
    assert.deepEqual(expanded.commands.sort(), ['demo@community:shared', 'demo@internal:shared']);

    const config = loadMcpConfigWithPlugins();
    assert.ok('demo@community:alpha' in config.mcpServers);
    assert.ok('demo@internal:beta' in config.mcpServers);
  });
});

test('marketplace plugins carry sourceName from their source namespace', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'acme-marketplace', [
      { name: 'cool-plugin', description: 'Cool', commands: ['cp-cmd'] },
    ]);

    writeConfigToml(asbHome, `[plugins.sources]\nacme-marketplace = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('cool-plugin');
    assert.ok(plugin);
    assert.equal(plugin.meta.sourceKind, 'marketplace');
    assert.equal(plugin.meta.sourceName, 'acme-marketplace');
  });
});

test('marketplace plugins expose Claude Code native install metadata', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'openai-codex', [
      { name: 'codex', description: 'Codex', commands: ['setup'] },
    ]);

    writeConfigToml(asbHome, `[plugins.sources]\nlocal-source = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('codex@local-source');
    assert.ok(plugin);
    assert.equal(plugin.meta.native?.target, 'claude-code');
    assert.equal(plugin.meta.native.marketplaceName, 'openai-codex');
    assert.equal(plugin.meta.native.marketplacePath, mktDir);
    assert.equal(plugin.meta.native.installRef, 'codex@openai-codex');
    assert.equal(index.getNative('codex@openai-codex')?.id, 'codex@local-source');
    assert.equal(index.get('codex@openai-codex'), undefined);
    assert.equal(plugin.refs.includes('codex@openai-codex'), false);
  });
});

test('Codex marketplace plugins expose Codex native install metadata', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createCodexMarketplaceFixture(asbHome, 'codex-canvas');

    writeConfigToml(asbHome, `[plugins.sources]\ncanvas = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('cowart@canvas');
    assert.ok(plugin);
    assert.equal(plugin.meta.native?.target, 'codex');
    assert.equal(plugin.meta.native.marketplaceName, 'codex-canvas');
    assert.equal(plugin.meta.native.marketplacePath, mktDir);
    assert.equal(plugin.meta.native.installRef, 'cowart@codex-canvas');
    assert.equal(index.getNative('cowart@codex-canvas', 'codex')?.id, 'cowart@canvas');
    assert.equal(index.getNative('cowart@codex-canvas', 'claude-code'), undefined);
  });
});

test('native-only marketplace sources remain discoverable without materialization', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createNativeOnlyMarketplace(asbHome);
    writeConfigToml(asbHome, `[plugins.sources]\nnative-source = "${mktDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('native-package@native-source');

    assert.ok(plugin);
    assert.equal(plugin.meta.materialized, false);
    assert.deepEqual(plugin.components, {
      commands: [],
      agents: [],
      skills: [],
      hooks: [],
      rules: [],
      mcp: [],
    });
    assert.equal(
      index.getNative('native-package@native-catalog', 'codex')?.id,
      'native-package@native-source'
    );
    assert.equal(plugin.meta.native?.version, '1.2.3');
    assert.equal(fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache')), false);
  });
});

test('plugin enable validates portable materialization before persisting selection', () => {
  withTempAsbHome((asbHome) => {
    const mktDir = createNativeOnlyMarketplace(asbHome);
    writeConfigToml(asbHome, `[plugins.sources]\nnative-source = "${mktDir}"\n`);

    assert.throws(
      () => runCli(['plugin', 'enable', 'native-package@native-source']),
      /Command failed/
    );
    assert.doesNotMatch(fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8'), /enabled/);
  });
});

test('remote marketplace cache paths do not use raw plugin names', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = path.join(asbHome, 'marketplaces', 'unsafe-cache');
    fs.mkdirSync(path.join(mktDir, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(mktDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'unsafe-cache',
        plugins: [
          {
            name: '../../escape/plugin',
            source: { git: 'file:///not-a-real-repo.git' },
          },
        ],
      })
    );

    writeConfigToml(asbHome, `[plugins.sources]\nunsafe-cache = "${mktDir}"\n`);

    const index = buildPluginIndex();
    assert.equal(index.plugins.length, 1);
    assert.throws(
      () => index.expand(['../../escape/plugin@unsafe-cache']),
      /Failed to materialize marketplace plugin/
    );
    assert.equal(fs.existsSync(path.join(asbHome, 'plugins', 'escape')), false);
  });
});

test('remote marketplace source paths stay inside the cloned cache root', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const remoteRepo = path.join(asbHome, 'remote-plugin-repo');
    fs.mkdirSync(remoteRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: remoteRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: remoteRepo,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: remoteRepo,
      stdio: 'ignore',
    });
    fs.writeFileSync(path.join(remoteRepo, 'README.md'), 'remote plugin\n');
    fs.symlinkSync('../escaped-plugin', path.join(remoteRepo, 'plugin-link'));
    execFileSync('git', ['add', 'README.md'], { cwd: remoteRepo, stdio: 'ignore' });
    execFileSync('git', ['add', 'plugin-link'], { cwd: remoteRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: remoteRepo, stdio: 'ignore' });

    const escapedDir = path.join(
      asbHome,
      'plugins',
      '.plugin-cache',
      'escape-source',
      'escaped-plugin'
    );
    fs.mkdirSync(path.join(escapedDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(escapedDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'escaped-plugin' })
    );

    const mktDir = path.join(asbHome, 'marketplaces', 'escape-source');
    fs.mkdirSync(path.join(mktDir, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(mktDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'escape-source',
        plugins: [
          {
            name: 'remote-plugin',
            source: { url: remoteRepo, path: '../escaped-plugin' },
          },
          {
            name: 'remote-symlink',
            source: { url: remoteRepo, path: 'plugin-link' },
          },
        ],
      })
    );

    writeConfigToml(asbHome, `[plugins.sources]\nescape-source = "${mktDir}"\n`);

    const index = buildPluginIndex();
    assert.equal(index.plugins.length, 2);
    assert.throws(
      () => index.expand(['remote-plugin@escape-source']),
      /Failed to materialize marketplace plugin/
    );
    assert.throws(
      () => index.expand(['remote-symlink@escape-source']),
      /Failed to materialize marketplace plugin/
    );
  });
});

test('bare Codex plugin sources expose Codex native install metadata', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'external', 'cowart');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cowart', description: 'Canvas', version: '0.1.0' })
    );

    writeConfigToml(asbHome, `[plugins.sources]\ncowart = "${pluginDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('cowart');
    assert.ok(plugin);
    assert.equal(plugin.meta.description, 'Canvas');
    assert.equal(plugin.meta.native?.target, 'codex');
    assert.equal(plugin.meta.native.marketplaceName, 'cowart');
    assert.equal(
      plugin.meta.native.marketplacePath,
      path.join(asbHome, 'state', 'native-plugins', 'codex', 'cowart')
    );
    assert.equal(plugin.meta.native.sourcePath, pluginDir);
    assert.equal(plugin.meta.native.installRef, 'cowart@cowart');
  });
});

test('bare plugin sources can carry both Claude metadata and Codex native metadata', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'external', 'dual-native');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'claude-name', description: 'Claude metadata' })
    );
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'codex-name', version: '0.2.0' })
    );

    writeConfigToml(asbHome, `[plugins.sources]\ndual-native = "${pluginDir}"\n`);

    const index = buildPluginIndex();
    const plugin = index.get('dual-native');
    assert.ok(plugin);
    assert.equal(plugin.meta.description, 'Claude metadata');
    assert.equal(plugin.meta.native?.target, 'codex');
    assert.equal(plugin.meta.native.pluginName, 'codex-name');
    assert.equal(plugin.meta.native.installRef, 'codex-name@dual-native');
  });
});

test('resolveApplicationNativePluginConfig keeps native plugins out of generic plugin expansion', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const mktDir = createMarketplaceFixture(asbHome, 'openai-codex', [
      { name: 'codex', description: 'Codex', commands: ['setup'] },
    ]);

    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[plugins.sources]',
        `source-alias = "${mktDir}"`,
        '',
        '[applications.claude-code.native_plugins]',
        'enabled = ["codex@source-alias"]',
        'scope = "user"',
      ].join('\n')
    );

    const nativeConfig = resolveApplicationNativePluginConfig('claude-code');
    assert.deepEqual(nativeConfig.enabled, ['codex@source-alias']);
    assert.equal(nativeConfig.scope, 'user');

    const claudeCommands = resolveEffectiveSectionConfig('commands', 'claude-code');
    const codexCommands = resolveEffectiveSectionConfig('commands', 'codex');
    assert.deepEqual(claudeCommands.enabled, []);
    assert.deepEqual(codexCommands.enabled, []);
  });
});

test('resolveApplicationNativePluginConfig resolves Codex native refs by target', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const pluginDir = path.join(asbHome, 'external', 'cowart');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cowart' })
    );

    writeConfigToml(
      asbHome,
      [
        '[plugins.sources]',
        `cowart-source = "${pluginDir}"`,
        '',
        '[applications.codex.native_plugins]',
        'enabled = ["cowart@cowart-source"]',
      ].join('\n')
    );

    const nativeConfig = resolveApplicationNativePluginConfig('codex');
    assert.deepEqual(nativeConfig.enabled, ['cowart-source']);
  });
});

test('resolveApplicationNativePluginConfig preserves source-qualified refs for duplicate native install refs', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const sourceOne = createMarketplaceFixture(asbHome, 'openai-codex', [
      { name: 'codex', description: 'Codex', commands: ['setup'] },
    ]);
    const sourceTwo = createMarketplaceFixture(asbHome, 'openai-codex-copy', [
      { name: 'codex', description: 'Codex', commands: ['setup'] },
    ]);
    fs.writeFileSync(
      path.join(sourceTwo, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'openai-codex',
        owner: { name: 'test-owner' },
        metadata: {},
        plugins: [{ name: 'codex', source: './plugins/codex' }],
      })
    );

    writeConfigToml(
      asbHome,
      [
        '[plugins.sources]',
        `source-one = "${sourceOne}"`,
        `source-two = "${sourceTwo}"`,
        '',
        '[applications.claude-code.native_plugins]',
        'enabled = ["codex@source-two"]',
      ].join('\n')
    );

    const nativeConfig = resolveApplicationNativePluginConfig('claude-code');
    assert.deepEqual(nativeConfig.enabled, ['codex@source-two']);
  });
});

test('resolveApplicationNativePluginConfig rejects unsupported native plugin scopes', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    writeConfigToml(
      asbHome,
      [
        '[applications.claude-code.native_plugins]',
        'enabled = ["codex@openai-codex"]',
        'scope = "project"',
      ].join('\n')
    );

    assert.throws(
      () => resolveApplicationNativePluginConfig('claude-code'),
      /Only "user" is currently supported/
    );
  });
});

test('resolveApplicationSectionConfig still works without plugins', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[commands]',
        'enabled = ["cmd-a", "cmd-b"]',
        '',
        '[applications.claude-code.commands]',
        'remove = ["cmd-b"]',
      ].join('\n')
    );

    const result = resolveApplicationSectionConfig('commands', 'claude-code');
    assert.deepEqual(result.enabled, ['cmd-a']);
  });
});
