import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isScpGitUrl(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return /^(?:[^@/:\\\s]+@)?[^@/:\\\s]+:.+$/.test(value);
}

export function normalizeLocalGitPath(value: string): string {
  let current = path.resolve(value);
  const missingSegments: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...missingSegments);
  } catch {
    return path.resolve(value);
  }
}

export function credentialFreeGitUrl(value: string): string {
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return trimmed;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1').replace(/[?#].*$/, '');
    }
  }

  return isScpGitUrl(trimmed) ? trimmed.replace(/[?#].*$/, '') : trimmed;
}

export function authenticatedGitEnv(
  authenticatedUrl: string,
  persistedUrl: string
): NodeJS.ProcessEnv | undefined {
  if (authenticatedUrl === persistedUrl) return undefined;

  const inheritedCount = process.env.GIT_CONFIG_COUNT;
  let index = inheritedCount && /^\d+$/.test(inheritedCount) ? Number(inheritedCount) : 0;
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

export function normalizeGitIdentity(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('file://')) {
    return normalizeLocalGitPath(fileURLToPath(trimmed));
  }
  if (path.isAbsolute(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return normalizeLocalGitPath(path.resolve(cwd, trimmed));
  }

  const scp = isScpGitUrl(trimmed) ? trimmed.match(/^(?:([^@/:\\\s]+)@)?([^:]+):(.+)$/) : null;
  if (scp) {
    const principal = scp[1] ? `${scp[1]}@` : '';
    return `ssh-scp://${principal}${scp[2].toLowerCase()}:${stripScpGitSuffix(scp[3])}`;
  }

  try {
    const url = new URL(trimmed);
    const principal = url.username ? `${url.username}@` : '';
    const authority = url.port
      ? `${url.hostname.toLowerCase()}:${url.port}`
      : url.hostname.toLowerCase();
    return `${url.protocol.toLowerCase()}//${principal}${authority}/${stripGitSuffix(url.pathname)}`;
  } catch {
    return stripGitSuffix(trimmed);
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

function stripScpGitSuffix(value: string): string {
  return value.replace(/\/+$/g, '').replace(/\.git$/, '');
}
