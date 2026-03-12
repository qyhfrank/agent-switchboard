/**
 * Stable extension API.
 *
 * Extensions are `.mjs` modules loaded from `~/.asb/extensions/` that can
 * register custom ApplicationTargets. This module defines the stable types
 * and registration functions exposed to extensions.
 *
 * API versioning: extensions receive an `AsbExtensionApi` object. Breaking
 * changes bump the `apiVersion` field so extensions can guard compatibility.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  applyDefaults,
  envMapToKvArray,
  joinFields,
  keyedArrayToRecord,
  kvArrayToEnvMap,
  omitFields,
  pickFields,
  recordToKeyedArray,
  renameFields,
  transformFrontmatter,
  transformMcpServers,
} from '../targets/dsl/transforms.js';
import { registerExtensionTarget } from '../targets/registry.js';
import type { ApplicationTarget } from '../targets/types.js';
import { wrapFrontmatter } from '../util/frontmatter.js';

export const API_VERSION = 1;

export interface AsbExtensionApi {
  readonly apiVersion: number;
  registerTarget(target: ApplicationTarget): void;
  readonly util: {
    readonly yaml: {
      parse: typeof parseYaml;
      stringify: typeof stringifyYaml;
    };
    readonly frontmatter: {
      wrap: typeof wrapFrontmatter;
    };
    readonly transforms: {
      recordToKeyedArray: typeof recordToKeyedArray;
      keyedArrayToRecord: typeof keyedArrayToRecord;
      envMapToKvArray: typeof envMapToKvArray;
      kvArrayToEnvMap: typeof kvArrayToEnvMap;
      renameFields: typeof renameFields;
      omitFields: typeof omitFields;
      pickFields: typeof pickFields;
      applyDefaults: typeof applyDefaults;
      joinFields: typeof joinFields;
      transformMcpServers: typeof transformMcpServers;
      transformFrontmatter: typeof transformFrontmatter;
    };
  };
}

const sharedUtil: AsbExtensionApi['util'] = {
  yaml: { parse: parseYaml, stringify: stringifyYaml },
  frontmatter: { wrap: wrapFrontmatter },
  transforms: {
    recordToKeyedArray,
    keyedArrayToRecord,
    envMapToKvArray,
    kvArrayToEnvMap,
    renameFields,
    omitFields,
    pickFields,
    applyDefaults,
    joinFields,
    transformMcpServers,
    transformFrontmatter,
  },
};

export function createExtensionApi(): AsbExtensionApi {
  return {
    apiVersion: API_VERSION,
    registerTarget: (target) => {
      registerExtensionTarget(target);
    },
    util: sharedUtil,
  };
}

/**
 * Create a staging extension API that buffers registrations.
 * Call `commit()` after successful activate() to apply them to the global registry.
 * If activate() throws, staged registrations are discarded.
 */
export function createStagingExtensionApi(): {
  api: AsbExtensionApi;
  commit: () => void;
} {
  const staged: ApplicationTarget[] = [];
  const api: AsbExtensionApi = {
    apiVersion: API_VERSION,
    registerTarget: (target) => {
      staged.push(target);
    },
    util: sharedUtil,
  };
  return {
    api,
    commit: () => {
      for (const target of staged) {
        registerExtensionTarget(target);
      }
    },
  };
}

/**
 * Expected shape of an extension module's default export.
 * Extensions must export `activate(api: AsbExtensionApi): void | Promise<void>`.
 */
export interface ExtensionModule {
  activate(api: AsbExtensionApi): void | Promise<void>;
}
