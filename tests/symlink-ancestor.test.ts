import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertNoSymlinkAncestor } from '../src/library/distribute-bundle.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-symlink-test-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('assertNoSymlinkAncestor: allows symlink ancestor resolving under trusted root', () => {
  withTempDir((root) => {
    const realRoot = fs.realpathSync(root);
    const appRoot = path.join(root, 'app');
    const backupHooks = path.join(root, 'backup', 'hooks');
    fs.mkdirSync(backupHooks, { recursive: true });
    fs.mkdirSync(appRoot, { recursive: true });
    fs.symlinkSync(backupHooks, path.join(appRoot, 'hooks'));
    fs.mkdirSync(path.join(backupHooks, 'asb', 'my-hook'), { recursive: true });

    assert.doesNotThrow(() =>
      assertNoSymlinkAncestor(appRoot, path.join(appRoot, 'hooks', 'asb', 'my-hook'), {
        trustedRoots: [realRoot],
      })
    );
  });
});

test('assertNoSymlinkAncestor: rejects symlink ancestor resolving outside trusted root', () => {
  withTempDir((root) => {
    const realRoot = fs.realpathSync(root);
    const appRoot = path.join(root, 'app');
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(appRoot, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(appRoot, 'hooks'));

    assert.throws(
      () =>
        assertNoSymlinkAncestor(appRoot, path.join(appRoot, 'hooks', 'asb', 'my-hook'), {
          trustedRoots: [path.join(realRoot, 'safe-zone')],
        }),
      /refusing to follow symlinked path/
    );
  });
});

test('assertNoSymlinkAncestor: rejects dangling symlink ancestor', () => {
  withTempDir((root) => {
    const realRoot = fs.realpathSync(root);
    const appRoot = path.join(root, 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    fs.symlinkSync(path.join(root, 'nonexistent'), path.join(appRoot, 'hooks'));

    assert.throws(
      () =>
        assertNoSymlinkAncestor(appRoot, path.join(appRoot, 'hooks', 'asb', 'my-hook'), {
          trustedRoots: [realRoot],
        }),
      /refusing to follow symlinked path/
    );
  });
});

test('assertNoSymlinkAncestor: allows final symlink with allowFinalSymlink', () => {
  withTempDir((root) => {
    const realRoot = fs.realpathSync(root);
    const appRoot = path.join(root, 'app');
    const backupSkill = path.join(root, 'backup', 'my-skill');
    fs.mkdirSync(path.join(appRoot, 'skills'), { recursive: true });
    fs.mkdirSync(backupSkill, { recursive: true });
    fs.symlinkSync(backupSkill, path.join(appRoot, 'skills', 'my-skill'));

    assert.doesNotThrow(() =>
      assertNoSymlinkAncestor(appRoot, path.join(appRoot, 'skills', 'my-skill'), {
        allowFinalSymlink: true,
        trustedRoots: [realRoot],
      })
    );
  });
});

test('assertNoSymlinkAncestor: uses homedir as default trusted root', () => {
  withTempDir((root) => {
    const appRoot = path.join(root, 'app');
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(appRoot, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(appRoot, 'hooks'));

    // Temp dir is under os.tmpdir(), not $HOME, so default trust boundary rejects
    assert.throws(
      () => assertNoSymlinkAncestor(appRoot, path.join(appRoot, 'hooks', 'asb', 'my-hook')),
      /refusing to follow symlinked path/
    );
  });
});

test('assertNoSymlinkAncestor: no symlinks passes without error', () => {
  withTempDir((root) => {
    const appRoot = path.join(root, 'app');
    fs.mkdirSync(path.join(appRoot, 'hooks', 'asb', 'my-hook'), { recursive: true });

    assert.doesNotThrow(() =>
      assertNoSymlinkAncestor(appRoot, path.join(appRoot, 'hooks', 'asb', 'my-hook'))
    );
  });
});

test('assertNoSymlinkAncestor: rejects target escaping root', () => {
  withTempDir((root) => {
    const appRoot = path.join(root, 'app');
    fs.mkdirSync(appRoot, { recursive: true });

    assert.throws(
      () => assertNoSymlinkAncestor(appRoot, path.join(root, 'other', 'file')),
      /target path escapes root/
    );
  });
});

test('assertNoSymlinkAncestor: nonexistent intermediate path does not throw', () => {
  withTempDir((root) => {
    const appRoot = path.join(root, 'app');
    fs.mkdirSync(appRoot, { recursive: true });

    assert.doesNotThrow(() =>
      assertNoSymlinkAncestor(appRoot, path.join(appRoot, 'does', 'not', 'exist'))
    );
  });
});
