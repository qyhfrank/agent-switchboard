import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function withTempDir<T>(fn: (dir: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-tmp-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function setEnv(key: string, value: string | undefined): string | undefined {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return prev;
}

export function withTempAsbHome<T>(fn: (asbHome: string) => T): T {
  return withTempDir((root) => {
    const asbHome = path.join(root, 'asb-home');
    fs.mkdirSync(asbHome, { recursive: true });
    const prevAsb = setEnv('ASB_HOME', asbHome);
    const prevAgents = setEnv('ASB_AGENTS_HOME', asbHome);
    try {
      return fn(asbHome);
    } finally {
      setEnv('ASB_HOME', prevAsb);
      setEnv('ASB_AGENTS_HOME', prevAgents);
    }
  });
}

export function withTempAgentsHome<T>(fn: (agentsHome: string) => T): T {
  return withTempDir((root) => {
    const agentsHome = path.join(root, 'agents-home');
    fs.mkdirSync(agentsHome, { recursive: true });
    const prev = setEnv('ASB_AGENTS_HOME', agentsHome);
    try {
      return fn(agentsHome);
    } finally {
      setEnv('ASB_AGENTS_HOME', prev);
    }
  });
}

export function withTempHomes<T>(fn: (ctx: { asbHome: string; agentsHome: string }) => T): T {
  return withTempDir((root) => {
    const asbHome = path.join(root, 'asb-home');
    const agentsHome = path.join(root, 'agents-home');
    fs.mkdirSync(asbHome, { recursive: true });
    fs.mkdirSync(agentsHome, { recursive: true });
    const prevAsb = setEnv('ASB_HOME', asbHome);
    const prevAgents = setEnv('ASB_AGENTS_HOME', agentsHome);
    try {
      return fn({ asbHome, agentsHome });
    } finally {
      setEnv('ASB_HOME', prevAsb);
      setEnv('ASB_AGENTS_HOME', prevAgents);
    }
  });
}
