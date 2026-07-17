import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertTargetWithinRoot,
  assertUsableBundleRoot,
} from '../src/library/distribute-bundle.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-bundle-guard-test-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('assertTargetWithinRoot: accepts the root itself and nested targets', () => {
  withTempDir((root) => {
    assert.doesNotThrow(() => assertTargetWithinRoot(root, root));
    assert.doesNotThrow(() => assertTargetWithinRoot(root, path.join(root, 'hooks', 'managed')));
  });
});

test('assertTargetWithinRoot: rejects a target escaping the root', () => {
  withTempDir((root) => {
    assert.throws(
      () => assertTargetWithinRoot(path.join(root, 'app'), path.join(root, 'other', 'file')),
      /target path escapes root/
    );
  });
});

test('assertUsableBundleRoot: accepts a missing root', () => {
  withTempDir((root) => {
    assert.doesNotThrow(() => assertUsableBundleRoot(path.join(root, 'does-not-exist')));
  });
});

test('assertUsableBundleRoot: accepts a symlinked directory root', () => {
  withTempDir((root) => {
    const realDir = path.join(root, 'real-root');
    const link = path.join(root, 'linked-root');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, link);
    assert.doesNotThrow(() => assertUsableBundleRoot(link));
  });
});

test('assertUsableBundleRoot: rejects a file root', () => {
  withTempDir((root) => {
    const filePath = path.join(root, 'not-a-dir');
    fs.writeFileSync(filePath, 'file\n');
    assert.throws(() => assertUsableBundleRoot(filePath), /not a directory/);
  });
});
