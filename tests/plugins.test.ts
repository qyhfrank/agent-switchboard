import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveApplicationNativePluginConfig,
  resolveApplicationSectionConfig,
  resolveEffectiveSectionConfig,
} from '../src/config/application-config.js';
import { loadMcpConfigWithPlugins } from '../src/config/mcp-config.js';
import { loadMcpEnabledState } from '../src/library/state.js';
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

test('external marketplace components materialize only when selected', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const { marketplaceDir, pluginId, skillId } = createRemoteSkillMarketplace(asbHome);
    writeConfigToml(asbHome, `[plugins.sources]\nremote-catalog = "${marketplaceDir}"\n`);

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
    writeConfigToml(asbHome, `[plugins.sources]\nself-catalog = "${marketplaceDir}"\n`);

    const plugin = buildPluginIndex().get('ppt-master@self-catalog');

    assert.ok(plugin);
    assert.equal(plugin.meta.sourcePath, pluginRoot);
    assert.deepEqual(plugin.components.skills, ['ppt-master@self-catalog:ppt-master']);
    assert.equal(
      fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache', 'self-catalog')),
      false
    );
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
    }>;

    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].id, 'plugin-a@catalog');
    assert.equal(plugins[0].ref, plugins[0].id);
    assert.equal(plugins[0].enabled, true);
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
