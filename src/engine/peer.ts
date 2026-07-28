import fs from 'node:fs';
import path from 'node:path';

/**
 * Hook ownership state: a peer contract, not private engine state. A 0.4.35
 * asb on another machine reads and writes the same
 * `<ASB_HOME>/state/hooks/<target>.json`, so every byte, key order and file
 * lifecycle here is frozen 0.4.35 behavior — the file lives beside the
 * library, not in the machine-local state home the ledger uses. Hook groups
 * carry no ledger entry: this record is their only ownership evidence.
 */

export type HookTarget = 'claude-code' | 'codex';

export interface PeerState {
  version: 1;
  /** Exactly the matcher groups last appended to the app config, per event. */
  events: Record<string, unknown[]>;
  /** Bundle directory names owned under `<appRoot>/hooks/managed/`. */
  bundles: string[];
  /** Failed legacy `hooks/asb/` removals awaiting retry. */
  legacyBundles: string[];
}

/** v0.4.32 wrote one copy per device under `<state dir>/<16-hex>/`. */
const DEVICE_DIR_PATTERN = /^[0-9a-f]{16}$/;

export function peerStateDir(asbHome: string): string {
  return path.join(asbHome, 'state', 'hooks');
}

export function peerStatePath(asbHome: string, target: HookTarget): string {
  return path.join(peerStateDir(asbHome), `${target}.json`);
}

export function emptyPeerState(): PeerState {
  return { version: 1, events: {}, bundles: [], legacyBundles: [] };
}

export function peerStateHasContent(state: PeerState): boolean {
  return (
    Object.keys(state.events).length > 0 ||
    state.bundles.length > 0 ||
    state.legacyBundles.length > 0
  );
}

/**
 * Bundle ids name one child of the managed parent and nothing else. Any peer
 * on the synced tree writes this file, so a name that could resolve outside
 * that parent is dropped on read rather than turned into a delete target.
 */
function bundleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is string =>
      typeof id === 'string' &&
      id.length > 0 &&
      id !== '.' &&
      id !== '..' &&
      !id.includes('/') &&
      !id.includes('\\') &&
      !id.includes('\0')
  );
}

/**
 * Strict field-by-field reconstruction: only the schema this code writes may
 * serve as deletion evidence, so a foreign version and a corrupt file both
 * load empty — no evidence, no authority — and neither aborts the run.
 */
function loadStateFile(filePath: string): PeerState {
  const state = emptyPeerState();
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return state;
    record = parsed as Record<string, unknown>;
  } catch {
    return state;
  }
  if (record.version !== 1) return state;
  if (record.events && typeof record.events === 'object' && !Array.isArray(record.events)) {
    for (const [event, groups] of Object.entries(record.events as Record<string, unknown>)) {
      if (Array.isArray(groups) && groups.length > 0) state.events[event] = groups;
    }
  }
  state.bundles = bundleIds(record.bundles);
  state.legacyBundles = bundleIds(record.legacyBundles);
  return state;
}

function deviceCopies(asbHome: string, target: HookTarget): string[] {
  const dir = peerStateDir(asbHome);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DEVICE_DIR_PATTERN.test(entry.name))
      .map((entry) => path.join(dir, entry.name, `${target}.json`))
      .filter((candidate) => {
        try {
          const stat = fs.lstatSync(candidate);
          return stat.isFile() && !stat.isSymbolicLink();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * The shared file plus every device-scoped copy. Group counts add rather than
 * de-duplicate: two machines that each appended the same group left two
 * copies in the app config, and count-bounded removal must reclaim both.
 */
export function loadPeerState(asbHome: string, target: HookTarget): PeerState {
  const merged = emptyPeerState();
  const sharedPath = peerStatePath(asbHome, target);
  const sources = [
    ...(fs.existsSync(sharedPath) ? [sharedPath] : []),
    ...deviceCopies(asbHome, target),
  ];
  for (const source of sources) {
    const state = loadStateFile(source);
    for (const [event, groups] of Object.entries(state.events)) {
      merged.events[event] = [...(merged.events[event] ?? []), ...groups];
    }
    merged.bundles.push(...state.bundles);
    merged.legacyBundles.push(...state.legacyBundles);
  }
  merged.bundles = [...new Set(merged.bundles)];
  merged.legacyBundles = [...new Set(merged.legacyBundles)];
  return merged;
}

/**
 * Publish the four-key document whole through a sibling temp file, so a peer
 * never opens a partial one and unknown fields do not survive. An empty state
 * deletes the file instead of leaving a shell that still looks like live
 * evidence. Device-scoped copies are consumed on either path, never created.
 */
export function savePeerState(asbHome: string, target: HookTarget, state: PeerState): void {
  const filePath = peerStatePath(asbHome, target);
  if (peerStateHasContent(state)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const document = {
      version: 1,
      events: state.events,
      bundles: state.bundles,
      legacyBundles: state.legacyBundles,
    };
    const temp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
      fs.renameSync(temp, filePath);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  } else {
    fs.rmSync(filePath, { force: true });
  }
  for (const copy of deviceCopies(asbHome, target)) {
    fs.rmSync(copy, { force: true });
    try {
      fs.rmdirSync(path.dirname(copy));
    } catch {
      // The device directory still holds another target's state.
    }
  }
}
