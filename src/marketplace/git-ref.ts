import { execFileSync } from 'node:child_process';

export function normalizeMarketplaceGitRef(value: string | undefined): string | undefined {
  const ref = value?.trim();
  if (!ref) return undefined;
  if (ref === 'HEAD') return ref;
  if (ref.startsWith('refs/remotes/')) {
    throw new Error(`Marketplace plugin ref must not be a remote-tracking ref: ${ref}`);
  }

  const normalized = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  try {
    execFileSync('git', ['check-ref-format', normalized], {
      stdio: 'pipe',
      timeout: 5_000,
    });
  } catch {
    throw new Error(`Invalid marketplace plugin ref: ${ref}`);
  }
  return ref;
}

export function localCheckoutRefsForMarketplaceRef(ref: string): string[] {
  if (ref === 'HEAD') return ['refs/remotes/origin/HEAD'];
  if (ref.startsWith('refs/heads/')) {
    return [`refs/remotes/origin/${ref.slice('refs/heads/'.length)}`];
  }
  if (!ref.startsWith('refs/')) {
    return [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`];
  }
  return [ref];
}

export function marketplaceGitFetchTargets(ref: string): string[] {
  if (ref === 'HEAD' || ref.startsWith('refs/')) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`];
}
