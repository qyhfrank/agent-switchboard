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
