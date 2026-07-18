import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { getAgentsHome } from './paths.js';

/** Stable local namespace for ownership state stored in a shared ASB_HOME. */
export function deviceStateId(): string {
  const device = process.env.ASB_DEVICE_ID?.trim() || os.hostname();
  return createHash('sha256')
    .update(`${device}\0${path.resolve(getAgentsHome())}`)
    .digest('hex')
    .slice(0, 16);
}
