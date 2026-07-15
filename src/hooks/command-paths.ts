const COMMAND_PATH_BOUNDARY = /[\s"'`=(:;&|<>]/;

export function commandContainsPathToken(command: string, pathPrefix: string): boolean {
  return findPathTokenIndexes(command, pathPrefix).length > 0;
}

/**
 * Return the path segment immediately following each boundary-valid
 * `<pathPrefix>/` occurrence, e.g. the `<id>` in `.../hooks/managed/<id>/run.sh`.
 */
export function extractPathTokenSegments(command: string, pathPrefix: string): string[] {
  const needle = `${pathPrefix}/`;
  const segments: string[] = [];
  for (const index of findPathTokenIndexes(command, pathPrefix)) {
    const rest = command.slice(index + needle.length);
    const end = rest.search(/[/\s"'`]/);
    const segment = end >= 0 ? rest.slice(0, end) : rest;
    if (segment.length > 0) segments.push(segment);
  }
  return segments;
}

function findPathTokenIndexes(command: string, pathPrefix: string): number[] {
  const needle = `${pathPrefix}/`;
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= command.length - needle.length) {
    const index = command.indexOf(needle, offset);
    if (index < 0) break;
    if (index === 0 || COMMAND_PATH_BOUNDARY.test(command[index - 1] ?? '')) {
      indexes.push(index);
    }
    offset = index + 1;
  }
  return indexes;
}
