import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scanLibrary } from '../../src/engine/library.js';
import { renderExplain } from '../../src/engine/report.js';
import type { PluginDescriptor } from '../../src/engine/sources.js';
import { withScratchHomes } from './helpers/scratch.js';

function write(root: string, relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

test('commands and agents are first-class library components', async () => {
  await withScratchHomes(async (homes) => {
    const commandPath = write(
      homes.asbHome,
      'commands/docs.md',
      '---\ndescription: Generate docs\nextras:\n  cursor:\n    model: fast\n---\nWrite docs.\n'
    );
    const agentPath = write(
      homes.asbHome,
      'agents/reviewer.markdown',
      '---\ndescription: Review changes\nmodel: precise\n---\nFind defects.\n'
    );

    const inventory = scanLibrary();
    const byKey = new Map(
      inventory.components.map((component) => [`${component.type}:${component.id}`, component])
    );

    assert.equal(byKey.get('commands:docs')?.path, commandPath);
    assert.equal(byKey.get('commands:docs')?.content, 'Write docs.\n');
    assert.equal(byKey.get('commands:docs')?.metadata.description, 'Generate docs');
    assert.deepEqual(byKey.get('commands:docs')?.metadata.extras, { cursor: { model: 'fast' } });
    assert.equal(byKey.get('agents:reviewer')?.path, agentPath);
    assert.equal(byKey.get('agents:reviewer')?.metadata.model, 'precise');
    assert.deepEqual(inventory.failed, []);
  });
});

test('plugin command and agent paths keep namespace and custom-path semantics', async () => {
  await withScratchHomes(async (homes) => {
    const root = path.join(homes.root, 'plugin');
    write(root, 'entry/ship.md', 'Ship it.\n');
    write(root, 'personas/check.md', 'Check it.\n');
    const plugin: PluginDescriptor = {
      id: 'pack@shop',
      name: 'pack',
      source: 'shop',
      root,
      customPaths: { commands: ['entry/ship.md'], agents: ['personas'] },
    };

    const inventory = scanLibrary({ plugins: [plugin] });

    assert.deepEqual(
      inventory.components
        .filter((component) => component.type === 'commands' || component.type === 'agents')
        .map((component) => `${component.type}:${component.id}`),
      ['agents:pack@shop:check', 'commands:pack@shop:ship']
    );
  });
});

test('one malformed command is contained beside a valid agent', async () => {
  await withScratchHomes(async (homes) => {
    write(homes.asbHome, 'commands/broken.md', '---\nmissing close\n');
    write(homes.asbHome, 'agents/good.md', 'Good.\n');

    const inventory = scanLibrary();

    assert.deepEqual(
      inventory.components.map((component) => `${component.type}:${component.id}`),
      ['agents:good']
    );
    assert.equal(inventory.failed.length, 1);
    assert.equal(inventory.failed[0].type, 'commands');
    assert.equal(inventory.failed[0].id, 'broken');
    assert.match(inventory.failed[0].error, /closing delimiter/);
  });
});

test('explain renders component source metadata explicitly', () => {
  const text = renderExplain(
    [
      {
        app: 'cursor',
        path: '/scratch/.cursor/commands/docs.md',
        outcome: 'unchanged',
        provenance: 'written',
        recordedHash: 'a'.repeat(64),
        currentHash: 'a'.repeat(64),
        desiredHash: 'a'.repeat(64),
        desired: 'Write docs.\n',
        components: [{ id: 'pack:docs', path: '/library/plugins/pack/commands/docs.md' }],
        sources: [
          { id: 'pack:docs', source: 'pack', path: '/library/plugins/pack/commands/docs.md' },
        ],
      },
    ],
    'pack:docs'
  );

  assert.match(text, /source: pack:docs <- pack \(\/library\/plugins\/pack\/commands\/docs\.md\)/);
});
