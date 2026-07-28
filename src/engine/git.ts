import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Git transport and managed-clone provenance. Credentials travel only in a
 * child process environment, never into a URL asb persists, prints, or writes
 * into a checkout's own config. `verifyClone` is the guard that stands between
 * every destructive source operation and a user's files: it answers "is this
 * directory exactly the generation asb cloned, with nothing of the user's in
 * it" and nothing else may authorize a delete.
 *
 * Frozen 0.4.35 contracts: the credential-free URL form, the GIT_CONFIG
 * insteadOf injection, the 120s command cap, the `.git/asb-source.json`
 * marker schema, and every check `verifyClone` performs — including
 * `status --porcelain --ignored --untracked-files=all`, where ignored files
 * count, which is what protects build artifacts inside a managed checkout.
 */

export interface RemoteSource {
  url: string;
  ref?: string;
  subdir?: string;
  type?: 'subtree' | 'clone';
}

export function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Strip credentials from a git URL, keeping an ssh username (identity, not secret). */
export function credentialFreeGitUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed.replace(/[?#].*$/, '');
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'ssh:') url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1').replace(/[?#].*$/, '');
  }
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every secret-bearing token of a URL, raw and percent-decoded. */
function credentialValues(value: string): string[] {
  try {
    const url = new URL(value);
    const rawQueryValues = url.search
      .slice(1)
      .split('&')
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        return separator >= 0 ? part.slice(separator + 1) : part;
      });
    const values = [
      url.password,
      ...rawQueryValues,
      ...url.searchParams.values(),
      url.hash.slice(1),
    ];
    if (url.protocol !== 'ssh:') values.push(url.username);
    return [...new Set(values.flatMap((item) => [item, decoded(item)]).filter(Boolean))];
  } catch {
    return [];
  }
}

export function redactGitCredentials(value: string, authenticatedUrls: string[] = []): string {
  let redacted = value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, credentialFreeGitUrl);
  for (const secret of authenticatedUrls.flatMap(credentialValues)) {
    redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

/**
 * Authenticate a fetch without persisting the credential: an insteadOf rule in
 * the child process environment rewrites the credential-free URL git actually
 * sees in `.git/config`. The index is placed past anything inherited so a
 * caller's own GIT_CONFIG entries survive.
 */
export function authenticatedGitEnv(
  authenticatedUrl: string,
  persistedUrl: string
): NodeJS.ProcessEnv | undefined {
  if (authenticatedUrl === persistedUrl) return undefined;
  const inherited = process.env.GIT_CONFIG_COUNT;
  let index = inherited && /^\d+$/.test(inherited) ? Number(inherited) : 0;
  while (
    process.env[`GIT_CONFIG_KEY_${index}`] !== undefined ||
    process.env[`GIT_CONFIG_VALUE_${index}`] !== undefined
  ) {
    index++;
  }
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `url.${authenticatedUrl}.insteadOf`,
    [`GIT_CONFIG_VALUE_${index}`]: persistedUrl,
  };
}

export function runGit(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; sensitiveUrls?: string[] } = {}
): string {
  try {
    return execFileSync('git', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
  } catch (error) {
    const execError = error as { stderr?: Buffer | string };
    const stderr =
      typeof execError.stderr === 'string'
        ? execError.stderr.trim()
        : (execError.stderr?.toString().trim() ?? '');
    throw new Error(
      redactGitCredentials(
        `git ${args[0]} failed: ${stderr || (error instanceof Error ? error.message : String(error))}`,
        options.sensitiveUrls
      )
    );
  }
}

export function ensureGitAvailable(): void {
  try {
    runGit(['--version']);
  } catch {
    throw new Error('git is not available. Install git to use remote sources.');
  }
}

function tryGit(repoDir: string, args: string[]): string | undefined {
  try {
    return runGit(args, { cwd: repoDir });
  } catch {
    return undefined;
  }
}

export function isGitRepoRoot(dir: string): boolean {
  try {
    const toplevel = runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    return fs.realpathSync.native(toplevel) === fs.realpathSync.native(dir);
  } catch {
    return false;
  }
}

export function ensureCleanTree(dir: string): void {
  if (runGit(['status', '--porcelain'], { cwd: dir }).length > 0) {
    throw new Error(
      'ASB_HOME has uncommitted changes. Commit or stash them before subtree operations.'
    );
  }
}

// ---------------------------------------------------------------------------
// Clone provenance marker
// ---------------------------------------------------------------------------

interface CloneMarker {
  version: 1;
  namespace: string;
  url: string;
  ref?: string;
  commit: string;
  branch?: string;
  upstream?: string;
  topology?: string;
}

/** Inside `.git`, so it is never committed and invisible to `git status`. */
function cloneMarkerPath(repoDir: string): string {
  return path.join(repoDir, '.git', 'asb-source.json');
}

/** Whether a directory carries the ownership marker asb writes into every clone. */
export function hasCloneMarker(repoDir: string): boolean {
  return fs.lstatSync(cloneMarkerPath(repoDir), { throwIfNoEntry: false })?.isFile() === true;
}

/** Whether a directory holds a git checkout, the shape every managed clone has. */
export function isGitCheckout(dir: string): boolean {
  return fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Every ref and the whole reflog: a rewritten history fails verification. */
function cloneTopology(repoDir: string): string {
  const refs = runGit(
    [
      'for-each-ref',
      '--sort=refname',
      '--format=%(refname)%00%(objectname)',
      'refs/heads',
      'refs/tags',
    ],
    { cwd: repoDir }
  );
  const reflog = runGit(['reflog', 'show', '--all', '--format=%gD%x00%H'], { cwd: repoDir });
  return JSON.stringify([refs, reflog]);
}

export function writeCloneMarker(repoDir: string, namespace: string, remote: RemoteSource): void {
  const marker: CloneMarker = {
    version: 1,
    namespace,
    url: credentialFreeGitUrl(expandHome(remote.url)),
    commit: runGit(['rev-parse', 'HEAD'], { cwd: repoDir }),
  };
  if (remote.ref) marker.ref = remote.ref;
  const branch = tryGit(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch) marker.branch = branch;
  const upstream = tryGit(repoDir, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  if (upstream) marker.upstream = upstream;
  marker.topology = cloneTopology(repoDir);
  fs.writeFileSync(cloneMarkerPath(repoDir), `${JSON.stringify(marker)}\n`);
}

/**
 * Whether the checkout is exactly the generation asb produced and carries
 * nothing of the user's. `undefined` means do not touch it.
 *
 * Every clause is load-bearing: symlinked roots would let a delete escape the
 * tree, a credential-bearing origin means the URL leaked into `.git/config`,
 * topology equality catches a rewritten or fetched-into history, `ls-files -v`
 * catches assume-unchanged edits the status call cannot see, and the status
 * call itself counts ignored and untracked files — a user's build output or
 * `.env` inside a managed checkout blocks its deletion.
 */
export function verifyClone(
  repoDir: string,
  namespace: string,
  remote: RemoteSource
): 'branch' | 'detached' | undefined {
  try {
    const rootStat = fs.lstatSync(repoDir);
    const gitStat = fs.lstatSync(path.join(repoDir, '.git'));
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !gitStat.isDirectory() ||
      gitStat.isSymbolicLink()
    ) {
      return undefined;
    }

    const markerPath = cloneMarkerPath(repoDir);
    let marker: CloneMarker | undefined;
    try {
      const stat = fs.lstatSync(markerPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      marker = parsed as CloneMarker;
    } catch (error) {
      // A markerless checkout drops to the legacy identity path; anything else
      // (unreadable, malformed) is unverifiable.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    }

    const expectedUrl = credentialFreeGitUrl(expandHome(remote.url));
    const rawOrigin = runGit(['remote', 'get-url', 'origin'], { cwd: repoDir });
    const origin = credentialFreeGitUrl(rawOrigin);
    const branch = tryGit(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const upstream = tryGit(repoDir, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    const head = runGit(['rev-parse', 'HEAD'], { cwd: repoDir });

    const markerIdentity =
      marker &&
      marker.version === 1 &&
      marker.namespace === namespace &&
      marker.url === expectedUrl &&
      marker.ref === remote.ref &&
      marker.commit === head &&
      marker.branch === branch &&
      marker.upstream === upstream;
    const legacyIdentity = branch
      ? (remote.ref === undefined || branch === remote.ref) &&
        upstream === `origin/${branch}` &&
        head === runGit(['rev-parse', '@{upstream}'], { cwd: repoDir })
      : remote.ref !== undefined &&
        upstream === undefined &&
        head ===
          runGit(['rev-parse', '--verify', `refs/tags/${remote.ref}^{commit}`], { cwd: repoDir });

    if (
      rawOrigin !== origin ||
      origin !== expectedUrl ||
      !(marker ? markerIdentity : legacyIdentity)
    ) {
      return undefined;
    }

    const topology = cloneTopology(repoDir);
    if (marker?.topology) {
      if (marker.topology !== topology) return undefined;
    } else {
      const expectedRefs = branch
        ? `refs/heads/${branch}\0${head}`
        : remote.ref
          ? `refs/tags/${remote.ref}\0${runGit(['rev-parse', `refs/tags/${remote.ref}`], { cwd: repoDir })}`
          : undefined;
      if (JSON.parse(topology)[0] !== expectedRefs) return undefined;
    }

    const allowedCommit = marker?.commit ?? (branch ? undefined : head);
    const exclusions = ['--not', '--remotes=origin', ...(allowedCommit ? [allowedCommit] : [])];
    return (marker?.topology ||
      runGit(['rev-list', '--all', '--reflog', ...exclusions], { cwd: repoDir }) === '') &&
      runGit(['ls-files', '-v'], { cwd: repoDir })
        .split('\n')
        .every((line) => line === '' || line.startsWith('H ')) &&
      runGit(['status', '--porcelain', '--ignored', '--untracked-files=all'], { cwd: repoDir }) ===
        ''
      ? branch
        ? 'branch'
        : 'detached'
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Clone, update, subtree
// ---------------------------------------------------------------------------

/**
 * Clone into a staging sibling and rename into place, so an interrupted clone
 * never leaves a half-materialized directory that later reads would trust.
 */
export function gitClone(url: string, targetDir: string, namespace: string, ref?: string): void {
  if (fs.existsSync(targetDir)) {
    throw new Error(`Source target already exists: ${targetDir}`);
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const stagedDir = path.join(
    path.dirname(targetDir),
    `.${path.basename(targetDir)}.${randomUUID()}`
  );
  const persistedUrl = credentialFreeGitUrl(url);
  try {
    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push(persistedUrl, stagedDir);
    runGit(args, { env: authenticatedGitEnv(url, persistedUrl), sensitiveUrls: [url] });
    writeCloneMarker(stagedDir, namespace, { url: persistedUrl, type: 'clone', ref });
    fs.renameSync(stagedDir, targetDir);
  } catch (error) {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    throw error;
  }
}

function mergeInProgress(repoDir: string): boolean {
  try {
    const mergeHeadPath = runGit(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: repoDir });
    return fs.existsSync(path.resolve(repoDir, mergeHeadPath));
  } catch {
    return false;
  }
}

export function abortMerge(repoDir: string): void {
  try {
    if (mergeInProgress(repoDir)) runGit(['merge', '--abort'], { cwd: repoDir });
  } catch {
    // Preserve the original git failure when no merge can be aborted.
  }
}

/**
 * Refresh a managed checkout in place. A detached ref re-fetches that ref; a
 * branch fast-forwards only. A merge this call started is aborted on failure,
 * while one already in progress beforehand is left for the user.
 */
export function gitUpdate(
  repoDir: string,
  url: string,
  ref: string | undefined,
  detachedRef: boolean
): void {
  const persistedUrl = credentialFreeGitUrl(url);
  const gitOptions = {
    cwd: repoDir,
    env: authenticatedGitEnv(url, persistedUrl),
    sensitiveUrls: [url],
  };
  if (detachedRef && ref) {
    runGit(['fetch', '--depth', '1', 'origin', ref], gitOptions);
    runGit(['checkout', '--detach', 'FETCH_HEAD'], gitOptions);
    return;
  }
  const mergeAlreadyActive = mergeInProgress(repoDir);
  try {
    runGit(['pull', '--ff-only'], gitOptions);
  } catch (error) {
    if (!mergeAlreadyActive) abortMerge(repoDir);
    throw error;
  }
}

export function gitSubtreeAdd(repoRoot: string, prefix: string, url: string, ref: string): void {
  const persistedUrl = credentialFreeGitUrl(url);
  runGit(['subtree', 'add', '--prefix', prefix, persistedUrl, ref], {
    cwd: repoRoot,
    env: authenticatedGitEnv(url, persistedUrl),
    sensitiveUrls: [url],
  });
}

export function gitSubtreePull(repoRoot: string, prefix: string, url: string, ref: string): void {
  const persistedUrl = credentialFreeGitUrl(url);
  runGit(['subtree', 'pull', '--prefix', prefix, persistedUrl, ref], {
    cwd: repoRoot,
    env: authenticatedGitEnv(url, persistedUrl),
    sensitiveUrls: [url],
  });
}
