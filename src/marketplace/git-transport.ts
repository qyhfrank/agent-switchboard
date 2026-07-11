export function credentialFreeGitUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed.replace(/[?#].*$/, '');
  }
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

export function redactGitCredentials(value: string): string {
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, credentialFreeGitUrl);
}
