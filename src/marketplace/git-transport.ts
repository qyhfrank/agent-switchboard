import { execFileSync } from 'node:child_process';

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

export function redactGitCredentials(value: string, authenticatedUrls: string[] = []): string {
  let redacted = value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, credentialFreeGitUrl);
  for (const secret of authenticatedUrls.flatMap(credentialValues)) {
    redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
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
