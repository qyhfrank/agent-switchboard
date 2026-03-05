/**
 * Pure data transformation operators for config-driven targets.
 *
 * These operators handle the structural differences between ASB's internal
 * representation and target-specific formats (e.g., keyed-array MCP,
 * env kv-arrays, field renaming).
 *
 * All functions are pure and composable; they are used both by the DSL
 * compiler (for config-driven targets) and directly by extension authors.
 */

/**
 * Convert a record `{ key: value }` to a keyed array `[{ keyField: key, ...value }]`.
 *
 * Example: `{ "my-server": { command: "node" } }` with keyField="name"
 *       → `[{ name: "my-server", command: "node" }]`
 */
export function recordToKeyedArray(
  record: Record<string, Record<string, unknown>>,
  keyField: string
): Array<Record<string, unknown>> {
  return Object.entries(record).map(([key, value]) => ({
    [keyField]: key,
    ...value,
  }));
}

/**
 * Convert a keyed array `[{ keyField: key, ...rest }]` back to a record.
 */
export function keyedArrayToRecord(
  array: Array<Record<string, unknown>>,
  keyField: string
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const item of array) {
    const key = String(item[keyField] ?? '');
    if (!key) continue;
    const { [keyField]: _, ...rest } = item;
    result[key] = rest;
  }
  return result;
}

/**
 * Convert a flat env map `{ KEY: "val" }` to a kv-array `[{ key: "KEY", value: "val" }]`.
 */
export function envMapToKvArray(
  env: Record<string, string>,
  keyName = 'key',
  valueName = 'value'
): Array<Record<string, string>> {
  return Object.entries(env).map(([k, v]) => ({
    [keyName]: k,
    [valueName]: v,
  }));
}

/**
 * Convert a kv-array `[{ key: "KEY", value: "val" }]` back to a flat env map.
 */
export function kvArrayToEnvMap(
  array: Array<Record<string, string>>,
  keyName = 'key',
  valueName = 'value'
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of array) {
    const k = item[keyName];
    const v = item[valueName];
    if (typeof k === 'string' && typeof v === 'string') result[k] = v;
  }
  return result;
}

/**
 * Rename fields in an object according to a mapping.
 * Keys not in the mapping are passed through unchanged.
 */
export function renameFields(
  obj: Record<string, unknown>,
  mapping: Record<string, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[mapping[k] ?? k] = v;
  }
  return result;
}

/**
 * Omit specified fields from an object.
 */
export function omitFields(
  obj: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const omitSet = new Set(fields);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!omitSet.has(k)) result[k] = v;
  }
  return result;
}

/**
 * Include only specified fields from an object.
 */
export function pickFields(
  obj: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in obj) result[f] = obj[f];
  }
  return result;
}

/**
 * Set default values for fields that are absent or undefined.
 */
export function applyDefaults(
  obj: Record<string, unknown>,
  defaults: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...obj };
  for (const [k, v] of Object.entries(defaults)) {
    if (result[k] === undefined) result[k] = v;
  }
  return result;
}

/**
 * Join array field values into a delimited string.
 * E.g., `{ tools: ["Read", "Write"] }` with `join = { tools: "," }`
 *     → `{ tools: "Read,Write" }`
 */
export function joinFields(
  obj: Record<string, unknown>,
  joinMap: Record<string, string>
): Record<string, unknown> {
  const result = { ...obj };
  for (const [field, delimiter] of Object.entries(joinMap)) {
    const val = result[field];
    if (Array.isArray(val)) {
      result[field] = val.join(delimiter);
    }
  }
  return result;
}

export interface McpTransformPipeline {
  structure?: 'record' | 'keyed-array';
  keyField?: string;
  envTransform?: { keyName?: string; valueName?: string };
  defaults?: Record<string, unknown>;
}

/**
 * Apply an MCP transform pipeline to the servers record.
 * Handles: env map→kv-array, default fields, record→keyed-array conversion.
 */
export function transformMcpServers(
  servers: Record<string, Record<string, unknown>>,
  pipeline: McpTransformPipeline
): Record<string, Record<string, unknown>> | Array<Record<string, unknown>> {
  const transformed: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    let s = { ...server };

    if (pipeline.envTransform && s.env && typeof s.env === 'object' && !Array.isArray(s.env)) {
      s.env = envMapToKvArray(
        s.env as Record<string, string>,
        pipeline.envTransform.keyName,
        pipeline.envTransform.valueName
      );
    }

    if (pipeline.defaults) {
      s = applyDefaults(s, pipeline.defaults) as Record<string, unknown>;
    }

    transformed[name] = s;
  }

  if (pipeline.structure === 'keyed-array') {
    return recordToKeyedArray(transformed, pipeline.keyField ?? 'name');
  }
  return transformed;
}

export interface FrontmatterTransformSpec {
  rename?: Record<string, string>;
  omit?: string[];
  include?: string[];
  join?: Record<string, string>;
  defaults?: Record<string, unknown>;
}

/**
 * Apply a frontmatter transform pipeline: defaults → join → omit/include → rename.
 */
export function transformFrontmatter(
  fm: Record<string, unknown>,
  spec: FrontmatterTransformSpec
): Record<string, unknown> {
  let result = { ...fm };
  if (spec.defaults) result = applyDefaults(result, spec.defaults);
  if (spec.join) result = joinFields(result, spec.join);
  if (spec.include) {
    result = pickFields(result, spec.include);
  } else if (spec.omit) {
    result = omitFields(result, spec.omit);
  }
  if (spec.rename) result = renameFields(result, spec.rename);
  return result;
}
