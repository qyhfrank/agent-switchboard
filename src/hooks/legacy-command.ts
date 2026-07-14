const COMMAND_PATH_BOUNDARY = /[\s"'`=(:;&|]/;

export function commandContainsPathToken(command: string, pathPrefix: string): boolean {
  const needle = `${pathPrefix}/`;
  let offset = 0;
  while (offset <= command.length - needle.length) {
    const index = command.indexOf(needle, offset);
    if (index < 0) return false;
    if (index === 0 || COMMAND_PATH_BOUNDARY.test(command[index - 1] ?? '')) return true;
    offset = index + 1;
  }
  return false;
}
