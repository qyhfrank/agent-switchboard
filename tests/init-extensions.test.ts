import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SwitchboardConfig } from '../src/config/schemas.js';
import { loadExtensions } from '../src/extensions/loader.js';
import { initTargets, resetTargetInit } from '../src/targets/init.js';
import { clearExtensionTargets, getTargetById } from '../src/targets/registry.js';

function makeTempAsbHome(): { asbHome: string; tmpRoot: string; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-init-test-'));
  const asbHome = path.join(tmpRoot, 'asb-home');
  fs.mkdirSync(path.join(asbHome, 'extensions'), { recursive: true });

  const prevAsb = process.env.ASB_HOME;
  const prevAgents = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;

  return {
    asbHome,
    tmpRoot,
    cleanup: () => {
      clearExtensionTargets();
      resetTargetInit();
      process.env.ASB_HOME = prevAsb;
      process.env.ASB_AGENTS_HOME = prevAgents;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function writeExtension(extDir: string, filename: string, code: string): void {
  fs.writeFileSync(path.join(extDir, filename), code);
}

const SIMPLE_EXT = `
export function activate(api) {
  api.registerTarget({ id: 'ext-test' });
}
`;

// ---------------------------------------------------------------------------
// loadExtensions: basic module loading
// ---------------------------------------------------------------------------

test('loadExtensions loads .mjs module and registers target', async () => {
  const { asbHome, cleanup } = makeTempAsbHome();
  try {
    writeExtension(path.join(asbHome, 'extensions'), 'simple.mjs', SIMPLE_EXT);

    await loadExtensions({} as unknown as SwitchboardConfig);

    assert.ok(getTargetById('ext-test'), 'ext-test should be registered');
  } finally {
    cleanup();
  }
});

test('loadExtensions auto-discovers .mjs in extensions directory', async () => {
  const { asbHome, cleanup } = makeTempAsbHome();
  try {
    writeExtension(
      path.join(asbHome, 'extensions'),
      'auto.mjs',
      `export function activate(api) { api.registerTarget({ id: 'auto-ext' }); }`
    );

    await loadExtensions({} as unknown as SwitchboardConfig);

    assert.ok(getTargetById('auto-ext'), 'auto-discovered extension should register target');
  } finally {
    cleanup();
  }
});

test('loadExtensions skips disabled extensions', async () => {
  const { asbHome, cleanup } = makeTempAsbHome();
  try {
    writeExtension(
      path.join(asbHome, 'extensions'),
      'skipped.mjs',
      `export function activate(api) { api.registerTarget({ id: 'ext-skipped' }); }`
    );

    await loadExtensions({
      extensions: { skipped: false },
    } as unknown as SwitchboardConfig);

    assert.equal(getTargetById('ext-skipped'), undefined, 'disabled extension should not load');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// initTargets: config-driven targets
// ---------------------------------------------------------------------------

test('initTargets registers config-driven targets from [targets]', async () => {
  const { cleanup } = makeTempAsbHome();
  try {
    const config = {
      targets: {
        'cfg-agent': {
          rules: { format: 'markdown', file_path: '/tmp/rules.md' },
        },
      },
    } as unknown as SwitchboardConfig;

    await initTargets(config);

    const target = getTargetById('cfg-agent');
    assert.ok(target, 'config-driven target should be registered');
    assert.ok(target.rules, 'target should have rules handler');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// initTargets: idempotency
// ---------------------------------------------------------------------------

test('initTargets is idempotent: second call does not re-activate extensions', async () => {
  const { asbHome, cleanup } = makeTempAsbHome();
  try {
    const counterFile = path.join(asbHome, 'activate-count.txt');
    writeExtension(
      path.join(asbHome, 'extensions'),
      'counter.mjs',
      `
import fs from 'node:fs';

const COUNTER = ${JSON.stringify(counterFile)};

export function activate(api) {
  const prev = fs.existsSync(COUNTER) ? Number(fs.readFileSync(COUNTER, 'utf-8')) : 0;
  fs.writeFileSync(COUNTER, String(prev + 1));
  api.registerTarget({ id: 'ext-counter' });
}
`
    );

    const config = {} as unknown as SwitchboardConfig;

    await initTargets(config);
    assert.equal(fs.readFileSync(counterFile, 'utf-8'), '1');

    await initTargets(config);
    assert.equal(
      fs.readFileSync(counterFile, 'utf-8'),
      '1',
      'activate must not be called again on second initTargets()'
    );
  } finally {
    cleanup();
  }
});
