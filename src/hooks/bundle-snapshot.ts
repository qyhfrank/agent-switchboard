import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BundleFile } from '../library/distribute-bundle.js';
import type { HookEntry } from './library.js';
import { listHookBundleFiles } from './library.js';
import type { HookFile } from './schema.js';
import { hookFileSchema } from './schema.js';

interface CapturedBundleFile {
  relativePath: string;
  content: Buffer;
  mode: number;
}

export interface CapturedHookBundle {
  hash: string;
  files: CapturedBundleFile[];
  hooks: HookFile['hooks'];
}

export function captureHookDefinition(entry: HookEntry): HookFile['hooks'] {
  const first = fs.readFileSync(entry.filePath);
  const second = fs.readFileSync(entry.filePath);
  if (Buffer.compare(first, second) !== 0) {
    throw new Error(`hook definition changed while it was being captured: ${entry.id}`);
  }
  return hookFileSchema.parse(JSON.parse(second.toString('utf-8'))).hooks;
}

export function captureHookBundle(entry: HookEntry): CapturedHookBundle {
  const first = captureHookBundleOnce(entry);
  const second = captureHookBundleOnce(entry);
  if (first.hash !== second.hash) {
    throw new Error(`hook bundle changed while it was being captured: ${entry.id}`);
  }
  return second;
}

function captureHookBundleOnce(entry: HookEntry): CapturedHookBundle {
  const hash = createHash('sha256');
  const files = listHookBundleFiles(entry).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
  const captured: CapturedBundleFile[] = [];
  updateHashField(hash, String(files.length));
  for (const file of files) {
    const content = fs.readFileSync(file.sourcePath);
    const mode = fs.statSync(file.sourcePath).mode & 0o777;
    updateHashField(hash, file.relativePath);
    updateHashField(hash, content);
    const modeBuffer = Buffer.alloc(4);
    modeBuffer.writeUInt32BE(mode & 0o111 ? mode : 0);
    updateHashField(hash, modeBuffer);
    captured.push({ relativePath: file.relativePath, content, mode });
  }
  const hookJsonRelativePath = entry.dirPath
    ? path.relative(entry.dirPath, entry.filePath)
    : path.basename(entry.filePath);
  const hookJson = captured.find((file) => file.relativePath === hookJsonRelativePath);
  if (!hookJson) throw new Error(`captured hook bundle has no hook definition: ${entry.id}`);
  const parsed = hookFileSchema.parse(JSON.parse(hookJson.content.toString('utf-8')));
  return { hash: hash.digest('hex'), files: captured, hooks: parsed.hooks };
}

export function materializeHookBundleSnapshots(
  entries: readonly HookEntry[],
  snapshots: ReadonlyMap<string, CapturedHookBundle>
): { root: string; files: Map<string, BundleFile[]> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-hooks-'));
  const files = new Map<string, BundleFile[]>();
  try {
    for (const [index, entry] of entries.entries()) {
      const snapshot = snapshots.get(entry.id);
      if (!snapshot) throw new Error(`Missing bundle snapshot for ${entry.id}`);
      const entryRoot = path.join(root, String(index));
      const materialized: BundleFile[] = [];
      for (const file of snapshot.files) {
        const sourcePath = path.join(entryRoot, file.relativePath);
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, file.content, { mode: file.mode });
        fs.chmodSync(sourcePath, file.mode);
        materialized.push({ sourcePath, relativePath: file.relativePath });
      }
      files.set(entry.id, materialized);
    }
    return { root, files };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function hookBundleDeploymentKey(entry: HookEntry, bundleHash: string): string {
  return createHash('sha256').update(entry.id).update('\0').update(bundleHash).digest('hex');
}

export function requireHookBundleHash(
  hashes: ReadonlyMap<string, string>,
  entry: HookEntry
): string {
  const hash = hashes.get(entry.id);
  if (!hash) throw new Error(`Missing bundle hash for ${entry.id}`);
  return hash;
}

function updateHashField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(buffer.length));
  hash.update(length);
  hash.update(buffer);
}
