import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveApplicationSectionConfig,
  resolveEffectiveSectionConfig,
} from '../src/config/application-config.js';
import { loadMcpConfigWithPlugins } from '../src/config/mcp-config.js';
import { buildPluginIndex, clearPluginIndexCache } from '../src/plugins/index.js';
import { loadRuleLibrary } from '../src/rules/library.js';
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

function writeConfigToml(asbHome: string, content: string) {
  fs.writeFileSync(path.join(asbHome, 'config.toml'), content);
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
    assert.deepEqual(a.components.commands, ['plugin-a:cmd-one', 'plugin-a:cmd-two']);
    assert.deepEqual(a.components.agents, ['plugin-a:agent-one']);
    assert.deepEqual(a.components.skills, ['plugin-a:skill-one']);
    assert.equal(a.meta.sourceKind, 'marketplace');
    assert.equal(a.meta.owner, 'test-owner');

    const b = index.get('plugin-b');
    assert.ok(b);
    assert.deepEqual(b.components.commands, ['plugin-b:cmd-three']);
    assert.deepEqual(b.components.agents, []);
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

    assert.deepEqual(expanded.commands.sort(), ['p1:a', 'p1:b', 'p2:c'].sort());
    assert.deepEqual(expanded.agents, ['p2:x']);
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
        'active = ["claude-code"]',
      ].join('\n')
    );

    const result = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.ok(result.enabled.includes('local-cmd'));
    assert.ok(result.enabled.includes('my-plugin:plugin-cmd'));
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
        'active = ["claude-code"]',
      ].join('\n')
    );

    const result = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.ok(result.enabled.includes('my-plugin:keep-cmd'));
    assert.ok(!result.enabled.includes('my-plugin:drop-cmd'));

    const agentResult = resolveEffectiveSectionConfig('agents', 'claude-code');
    assert.ok(agentResult.enabled.includes('my-plugin:keep-agent'));
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
        'active = ["claude-code", "codex"]',
      ].join('\n')
    );

    const ccResult = resolveEffectiveSectionConfig('commands', 'claude-code');
    assert.ok(ccResult.enabled.includes('p1:p1-cmd'));
    assert.ok(ccResult.enabled.includes('p2:p2-cmd'));

    const codexResult = resolveEffectiveSectionConfig('commands', 'codex');
    assert.ok(codexResult.enabled.includes('p1:p1-cmd'));
    assert.ok(codexResult.enabled.includes('p2:p2-cmd'));
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
    assert.ok(ids.includes('my-plugin:plugin-rule'));
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
    assert.ok('my-plugin:remote-api' in config.mcpServers);
  });
});

test('old config without plugins section works (backward compatibility)', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    writeConfigToml(
      asbHome,
      ['[applications]', 'active = ["claude-code"]', '', '[commands]', 'enabled = ["my-cmd"]'].join(
        '\n'
      )
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
    assert.deepEqual(plugin.components.commands, ['my-plugin:special']);
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
    assert.deepEqual(plugin.components.commands, ['my-plugin:alt']);
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
    assert.equal(bySource.id, 'context7');

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
    assert.deepEqual(expanded.commands, ['p1:cmd-a']);
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

test('resolveApplicationSectionConfig still works without plugins', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    writeConfigToml(
      asbHome,
      [
        '[applications]',
        'active = ["claude-code"]',
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
