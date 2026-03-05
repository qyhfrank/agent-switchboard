import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { compileTargetSpec } from '../src/targets/dsl/compiler.js';
import {
  clearExtensionTargets,
  getTargetById,
  registerConfigTargets,
} from '../src/targets/registry.js';
import { withTempDir } from './helpers/tmp.js';

function cleanup() {
  clearExtensionTargets();
}

// ---------------------------------------------------------------------------
// Basic compilation
// ---------------------------------------------------------------------------

test('compileTargetSpec creates target with MCP handler', () => {
  const spec = {
    mcp: {
      format: 'json',
      config_path: '/tmp/test-agent/config.json',
      root_key: 'mcpServers',
    },
  };
  const target = compileTargetSpec('test-agent', spec);
  assert.equal(target.id, 'test-agent');
  assert.ok(target.mcp);
  assert.equal(target.mcp.configPath(), '/tmp/test-agent/config.json');
});

test('compileTargetSpec creates target with rules handler', () => {
  const spec = {
    rules: {
      format: 'markdown',
      file_path: '/tmp/test-agent/RULES.md',
    },
  };
  const target = compileTargetSpec('test-agent', spec);
  assert.ok(target.rules);
  assert.equal(target.rules.resolveFilePath(), '/tmp/test-agent/RULES.md');
  assert.equal(target.rules.render('hello'), 'hello');
});

test('compileTargetSpec rules with mdc format wraps frontmatter', () => {
  const spec = {
    rules: {
      format: 'mdc',
      file_path: '/tmp/test.md',
    },
  };
  const target = compileTargetSpec('test', spec);
  const rendered = target.rules!.render('body content');
  assert.ok(rendered.includes('---'));
  assert.ok(rendered.includes('alwaysApply: true'));
  assert.ok(rendered.includes('body content'));
});

test('compileTargetSpec creates commands handler', () => {
  const spec = {
    commands: {
      target_dir: '/tmp/test/commands',
      filename_pattern: '{id}.md',
    },
  };
  const target = compileTargetSpec('test', spec);
  assert.ok(target.commands);
  assert.equal(target.commands.resolveTargetDir(), '/tmp/test/commands');
  assert.equal(target.commands.getFilename('my-cmd'), 'my-cmd.md');
});

test('compileTargetSpec creates skills handler', () => {
  const spec = {
    skills: {
      parent_dir: '/tmp/test/skills',
    },
  };
  const target = compileTargetSpec('test', spec);
  assert.ok(target.skills);
  assert.equal(target.skills.resolveParentDir(), '/tmp/test/skills');
  assert.equal(target.skills.resolveTargetDir('my-skill'), '/tmp/test/skills/my-skill');
});

test('compileTargetSpec omits sections not present in spec', () => {
  const target = compileTargetSpec('empty', {});
  assert.equal(target.mcp, undefined);
  assert.equal(target.rules, undefined);
  assert.equal(target.commands, undefined);
  assert.equal(target.agents, undefined);
  assert.equal(target.skills, undefined);
});

// ---------------------------------------------------------------------------
// MCP handler: YAML format with transforms
// ---------------------------------------------------------------------------

test('compileTargetSpec MCP writes YAML with keyed-array and env transform', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const spec = {
      mcp: {
        format: 'yaml',
        config_path: configPath,
        root_key: 'mcp_servers',
        structure: 'keyed-array',
        key_field: 'name',
        env_transform: { key_name: 'key', value_name: 'value' },
        defaults: { type: 'stdio' },
      },
    };
    const target = compileTargetSpec('custom-test', spec);

    target.mcp!.applyConfig({
      mcpServers: {
        'test-server': {
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: 'secret' },
        },
      },
    });

    assert.ok(fs.existsSync(configPath));
    const content = parseYaml(fs.readFileSync(configPath, 'utf-8'));
    assert.ok(Array.isArray(content.mcp_servers));
    assert.equal(content.mcp_servers[0].name, 'test-server');
    assert.equal(content.mcp_servers[0].command, 'node');
    assert.equal(content.mcp_servers[0].type, 'stdio');
    assert.deepEqual(content.mcp_servers[0].env, [{ key: 'API_KEY', value: 'secret' }]);
  });
});

test('compileTargetSpec MCP preserves existing non-MCP fields in YAML', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, 'existing_field: keep\nversion: 2\nmcp_servers: []\n');

    const spec = {
      mcp: {
        format: 'yaml',
        config_path: configPath,
        root_key: 'mcp_servers',
        structure: 'keyed-array',
        key_field: 'name',
      },
    };
    const target = compileTargetSpec('test', spec);
    target.mcp!.applyConfig({
      mcpServers: { s1: { command: 'cmd' } },
    });

    const content = parseYaml(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(content.existing_field, 'keep');
    assert.equal(content.version, 2);
    assert.ok(Array.isArray(content.mcp_servers));
  });
});

// ---------------------------------------------------------------------------
// MCP handler: JSON format preserves non-MCP fields
// ---------------------------------------------------------------------------

test('compileTargetSpec MCP preserves existing non-MCP fields in JSON', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ model: 'gpt-4', theme: 'dark', mcpServers: {} }, null, 2)
    );

    const spec = {
      mcp: {
        format: 'json',
        config_path: configPath,
        root_key: 'mcpServers',
      },
    };
    const target = compileTargetSpec('test-json', spec);
    target.mcp!.applyConfig({
      mcpServers: { s1: { command: 'cmd' } },
    });

    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(content.model, 'gpt-4');
    assert.equal(content.theme, 'dark');
    assert.ok(content.mcpServers.s1);
    assert.equal(content.mcpServers.s1.command, 'cmd');
  });
});

// ---------------------------------------------------------------------------
// MCP handler: fail-fast on parse errors (file must not be modified)
// ---------------------------------------------------------------------------

test('compileTargetSpec MCP YAML parse error: does not modify file', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const corrupt = '{ unclosed: [bracket';
    fs.writeFileSync(configPath, corrupt);

    const spec = {
      mcp: {
        format: 'yaml',
        config_path: configPath,
        root_key: 'mcp_servers',
      },
    };
    const target = compileTargetSpec('test-corrupt-yaml', spec);

    assert.throws(
      () =>
        target.mcp!.applyConfig({
          mcpServers: { s1: { command: 'cmd' } },
        }),
      (err: Error) =>
        err.message.includes('Cannot parse') && err.message.includes('test-corrupt-yaml')
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), corrupt);
  });
});

test('compileTargetSpec MCP JSON parse error: does not modify file', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.json');
    const corrupt = '{ bad json !!!';
    fs.writeFileSync(configPath, corrupt);

    const spec = {
      mcp: {
        format: 'json',
        config_path: configPath,
        root_key: 'mcpServers',
      },
    };
    const target = compileTargetSpec('test-corrupt-json', spec);

    assert.throws(
      () =>
        target.mcp!.applyConfig({
          mcpServers: { s1: { command: 'cmd' } },
        }),
      (err: Error) =>
        err.message.includes('Cannot parse') && err.message.includes('test-corrupt-json')
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), corrupt);
  });
});

// ---------------------------------------------------------------------------
// MCP handler: fail-fast on non-object root (file must not be modified)
// ---------------------------------------------------------------------------

test('compileTargetSpec MCP YAML scalar root: throws and does not modify file', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const content = 'just a string\n';
    fs.writeFileSync(configPath, content);

    const target = compileTargetSpec('test-scalar', {
      mcp: { format: 'yaml', config_path: configPath, root_key: 'servers' },
    });

    assert.throws(
      () => target.mcp!.applyConfig({ mcpServers: { s: { command: 'x' } } }),
      (err: Error) => err.message.includes('must be an object') && err.message.includes('string')
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), content);
  });
});

test('compileTargetSpec MCP YAML array root: throws and does not modify file', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const content = '- item1\n- item2\n';
    fs.writeFileSync(configPath, content);

    const target = compileTargetSpec('test-arr', {
      mcp: { format: 'yaml', config_path: configPath, root_key: 'servers' },
    });

    assert.throws(
      () => target.mcp!.applyConfig({ mcpServers: { s: { command: 'x' } } }),
      (err: Error) => err.message.includes('must be an object') && err.message.includes('array')
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), content);
  });
});

test('compileTargetSpec MCP JSON array root: throws and does not modify file', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.json');
    const content = '[1, 2, 3]';
    fs.writeFileSync(configPath, content);

    const target = compileTargetSpec('test-arr', {
      mcp: { format: 'json', config_path: configPath, root_key: 'mcpServers' },
    });

    assert.throws(
      () => target.mcp!.applyConfig({ mcpServers: { s: { command: 'x' } } }),
      (err: Error) => err.message.includes('must be an object') && err.message.includes('array')
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), content);
  });
});

test('compileTargetSpec MCP JSON number root: throws and does not modify file', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.json');
    const content = '42';
    fs.writeFileSync(configPath, content);

    const target = compileTargetSpec('test-num', {
      mcp: { format: 'json', config_path: configPath, root_key: 'mcpServers' },
    });

    assert.throws(
      () => target.mcp!.applyConfig({ mcpServers: { s: { command: 'x' } } }),
      (err: Error) => err.message.includes('must be an object') && err.message.includes('number')
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), content);
  });
});

// ---------------------------------------------------------------------------
// MCP handler: creates nested parent directories
// ---------------------------------------------------------------------------

test('compileTargetSpec MCP creates nested parent directories for config file', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'a', 'b', 'config.json');

    const target = compileTargetSpec('test-nested', {
      mcp: { format: 'json', config_path: configPath, root_key: 'mcpServers' },
    });

    target.mcp!.applyConfig({ mcpServers: { s1: { command: 'cmd' } } });

    assert.ok(fs.existsSync(configPath));
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(content.mcpServers.s1.command, 'cmd');
  });
});

// ---------------------------------------------------------------------------
// MCP handler: empty YAML treated as empty object
// ---------------------------------------------------------------------------

test('compileTargetSpec MCP empty YAML file: treated as empty object, writes normally', () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, '');

    const target = compileTargetSpec('test-empty', {
      mcp: { format: 'yaml', config_path: configPath, root_key: 'servers' },
    });

    target.mcp!.applyConfig({ mcpServers: { s1: { command: 'cmd' } } });

    const result = parseYaml(fs.readFileSync(configPath, 'utf-8'));
    assert.ok(result.servers);
  });
});

// ---------------------------------------------------------------------------
// Library handler: frontmatter transforms
// ---------------------------------------------------------------------------

test('compileTargetSpec commands handler applies frontmatter rename', () => {
  const spec = {
    commands: {
      target_dir: '/tmp',
      frontmatter: {
        rename: { allowed_tools: 'allowed-tools' },
      },
    },
  };
  const target = compileTargetSpec('test', spec);
  const entry = {
    id: 'my-cmd',
    bareId: 'my-cmd',
    metadata: { description: 'test', extras: { test: { allowed_tools: ['Read'] } } },
    content: 'body',
  };
  const rendered = target.commands!.render(entry);
  assert.ok(rendered.includes('allowed-tools'));
  assert.ok(!rendered.includes('allowed_tools'));
});

test('compileTargetSpec agents handler applies join + rename', () => {
  const spec = {
    agents: {
      target_dir: '/tmp',
      frontmatter: {
        join: { allowed_tools: ',' },
        rename: { allowed_tools: 'tools' },
      },
    },
  };
  const target = compileTargetSpec('test', spec);
  const entry = {
    id: 'my-agent',
    bareId: 'my-agent',
    metadata: { description: 'test', extras: { test: { allowed_tools: ['Read', 'Write'] } } },
    content: 'body',
  };
  const rendered = target.agents!.render(entry);
  assert.ok(
    rendered.includes('tools:') && rendered.includes('Read,Write'),
    `Expected rendered output to contain "tools:" and "Read,Write", got:\n${rendered}`
  );
});

// ---------------------------------------------------------------------------
// registerConfigTargets integration
// ---------------------------------------------------------------------------

test('registerConfigTargets compiles and registers targets from config', () => {
  cleanup();
  const targets = {
    'my-agent': {
      rules: { format: 'markdown', file_path: '/tmp/rules.md' },
      skills: { parent_dir: '/tmp/skills' },
    },
  };
  registerConfigTargets(targets);
  const found = getTargetById('my-agent');
  assert.ok(found);
  assert.ok(found.rules);
  assert.ok(found.skills);
  cleanup();
});

test('registerConfigTargets warns on invalid specs', () => {
  cleanup();
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warned.push(msg);
  try {
    registerConfigTargets({
      bad: { mcp: { format: 'json' } },
    });
    assert.ok(warned.some((w) => w.includes('bad')));
  } finally {
    console.warn = origWarn;
  }
  cleanup();
});
