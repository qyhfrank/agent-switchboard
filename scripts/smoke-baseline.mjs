#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultFixture = path.join(scriptDir, 'fixtures', 'smoke-baseline');
const expectedVersions = {
  baseline: '0.4.35',
  candidate: readJson(path.join(repoRoot, 'package.json')).version,
};
const allowedAnchors = new Set(['MIG-04', 'MIG-05', 'MIG-06', 'rules:start']);

function parseArgs(argv) {
  const options = { fixture: defaultFixture, profile: 'smoke', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') {
      options.keep = true;
      continue;
    }
    if (
      flag !== '--baseline-tarball' &&
      flag !== '--candidate-tarball' &&
      flag !== '--fixture' &&
      flag !== '--profile' &&
      flag !== '--json'
    ) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    index += 1;
    const key = {
      '--baseline-tarball': 'baselineTarball',
      '--candidate-tarball': 'candidateTarball',
      '--fixture': 'fixture',
      '--profile': 'profile',
      '--json': 'json',
    }[flag];
    options[key] = key === 'profile' ? value : path.resolve(value);
  }
  return options;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function run(command, args, options = {}) {
  const capture = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-smoke-command-'));
  const stdoutPath = path.join(capture, 'stdout');
  const stderrPath = path.join(capture, 'stderr');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  try {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const stdout = fs.readFileSync(stdoutPath, 'utf-8');
    const stderr = fs.readFileSync(stderrPath, 'utf-8');
    if (code !== 0) {
      throw new Error(
        `${command} ${args.join(' ')} failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`
      );
    }
    return { stdout, stderr };
  } finally {
    try {
      fs.closeSync(stdoutFd);
    } catch {}
    try {
      fs.closeSync(stderrFd);
    } catch {}
    fs.rmSync(capture, { recursive: true, force: true });
  }
}

async function packBaseline(destination) {
  const common = [
    'pack',
    'agent-switchboard@0.4.35',
    '--ignore-scripts',
    '--pack-destination',
    destination,
  ];
  try {
    await run('npm', [...common, '--offline'], { cwd: repoRoot });
  } catch {
    await run('npm', common, { cwd: repoRoot });
  }
  const tarball = path.join(destination, 'agent-switchboard-0.4.35.tgz');
  if (!fs.existsSync(tarball)) throw new Error('npm pack did not create the baseline tarball');
  return tarball;
}

async function packCandidate(destination) {
  await run('npm', ['run', 'build'], { cwd: repoRoot });
  const cache = path.join(destination, 'npm-cache');
  fs.mkdirSync(cache);
  const packed = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], {
    cwd: repoRoot,
    env: { ...process.env, npm_config_cache: cache },
  });
  const tarball = path.join(destination, packed.stdout.trim());
  if (!fs.existsSync(tarball)) throw new Error('npm pack did not create the candidate tarball');
  return tarball;
}

async function extractPackage(tarball, destination, expectedVersion) {
  fs.mkdirSync(destination, { recursive: true });
  await run('tar', ['-xzf', tarball, '-C', destination]);
  const packageRoot = path.join(destination, 'package');
  const manifest = readJson(path.join(packageRoot, 'package.json'));
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Expected package version ${expectedVersion}, received ${String(manifest.version)}`
    );
  }
  const dependencyLink = path.join(packageRoot, 'node_modules');
  if (!fs.existsSync(dependencyLink))
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), dependencyLink);
  return { packageRoot, manifest };
}

function packageBins(pkg, destination) {
  const bin = typeof pkg.manifest.bin === 'string' ? { asb: pkg.manifest.bin } : pkg.manifest.bin;
  if (!bin || typeof bin !== 'object') throw new Error('Package has no bin map');
  fs.mkdirSync(destination, { recursive: true });
  const result = {};
  for (const [alias, relative] of Object.entries(bin)) {
    if (typeof relative !== 'string') throw new Error(`Invalid bin target for ${alias}`);
    const target = path.resolve(pkg.packageRoot, relative);
    const link = path.join(destination, alias);
    fs.symlinkSync(target, link);
    result[alias] = link;
  }
  return result;
}

async function exerciseBins(bins, expectedVersion, env) {
  for (const alias of ['asb', 'agent-switchboard']) {
    const executable = bins[alias];
    if (!executable) throw new Error(`Package bin alias is missing: ${alias}`);
    const help = await run(executable, ['--help'], { env });
    if (!/Usage: asb/.test(help.stdout)) throw new Error(`${alias} --help returned no usage text`);
    const version = await run(executable, ['--version'], { env });
    if (version.stdout.trim() !== expectedVersion) {
      throw new Error(`${alias} --version returned ${version.stdout.trim()}`);
    }
  }
}

function isolatedEnv(root) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: path.join(root, 'user-home'),
    ASB_HOME: path.join(root, 'asb-home'),
    ASB_AGENTS_HOME: path.join(root, 'agents-home'),
    ASB_CACHE_HOME: path.join(root, 'cache'),
    ASB_STATE_HOME: path.join(root, 'state'),
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
  };
  for (const dir of [env.HOME, env.ASB_AGENTS_HOME, env.ASB_CACHE_HOME, env.ASB_STATE_HOME]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return env;
}

function prepareHome(fixture, root) {
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(fixture, 'asb-home'), path.join(root, 'asb-home'), { recursive: true });
  return isolatedEnv(root);
}

function loadTargets(fixture) {
  const targets = readJson(path.join(fixture, 'targets.json'));
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('targets.json is empty');
  for (const target of targets) {
    if (
      typeof target !== 'string' ||
      path.isAbsolute(target) ||
      target.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`Invalid declared target path: ${String(target)}`);
    }
  }
  return targets;
}

function loadExceptions(fixture, targets) {
  const exceptions = readJson(path.join(fixture, 'exceptions.json'));
  if (!Array.isArray(exceptions)) throw new Error('exceptions.json must be an array');
  const seen = new Set();
  for (const exception of exceptions) {
    const keys = Object.keys(exception ?? {})
      .sort()
      .join(',');
    if (keys !== 'after,anchor,before,path,reason,slice')
      throw new Error(
        'Each exception needs exact path, slice, before, after, reason, and anchor fields'
      );
    if (!targets.includes(exception.path))
      throw new Error(`Exception path is undeclared: ${exception.path}`);
    if (!exception.reason || !exception.anchor)
      throw new Error(`Incomplete exception: ${exception.path}`);
    if (![...allowedAnchors].some((anchor) => exception.anchor.includes(anchor))) {
      throw new Error(`Unratified exception anchor: ${exception.anchor}`);
    }
    const key = `${exception.path}\0${exception.slice}`;
    if (seen.has(key)) throw new Error(`Duplicate exception: ${exception.path} ${exception.slice}`);
    seen.add(key);
  }
  return exceptions;
}

function snapshot(root, targets) {
  const result = {};
  for (const relative of targets) {
    const target = path.join(root, relative);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        result[relative] = { kind: 'absent' };
        continue;
      }
      throw error;
    }
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      result[relative] = { kind: 'symlink', mode, target: fs.readlinkSync(target) };
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(target);
      result[relative] = { kind: 'file', mode, size: bytes.length, sha256: sha256(bytes) };
    } else {
      throw new Error(`Declared target is not a file or symlink: ${relative}`);
    }
  }
  return result;
}

function sliceValue(entry, slice) {
  if (slice === 'file-presence') return entry.kind;
  if (slice === 'mode' && entry.kind !== 'absent') return entry.mode;
  if (slice === 'bytes' && entry.kind === 'file') return entry.sha256;
  if (slice === 'symlink-target' && entry.kind === 'symlink') return entry.target;
  throw new Error(`Snapshot entry has no ${slice} slice`);
}

function compareSnapshots(baseline, candidate, exceptions) {
  const expected = new Map(exceptions.map((item) => [`${item.path}\0${item.slice}`, item]));
  const allowed = [];
  const unlisted = [];
  const differences = [];
  for (const target of Object.keys(baseline)) {
    const before = baseline[target];
    const after = candidate[target];
    if (before.kind !== after.kind) {
      differences.push({
        path: target,
        slice: 'file-presence',
        before: sliceValue(before, 'file-presence'),
        after: sliceValue(after, 'file-presence'),
      });
    } else if (before.kind === 'file') {
      if (before.mode !== after.mode) {
        differences.push({
          path: target,
          slice: 'mode',
          before: sliceValue(before, 'mode'),
          after: sliceValue(after, 'mode'),
        });
      }
      if (before.sha256 !== after.sha256) {
        differences.push({
          path: target,
          slice: 'bytes',
          before: sliceValue(before, 'bytes'),
          after: sliceValue(after, 'bytes'),
        });
      }
    } else if (before.kind === 'symlink') {
      if (before.mode !== after.mode) {
        differences.push({
          path: target,
          slice: 'mode',
          before: sliceValue(before, 'mode'),
          after: sliceValue(after, 'mode'),
        });
      }
      if (before.target !== after.target) {
        differences.push({
          path: target,
          slice: 'symlink-target',
          before: sliceValue(before, 'symlink-target'),
          after: sliceValue(after, 'symlink-target'),
        });
      }
    }
  }
  for (const difference of differences) {
    const exception = expected.get(`${difference.path}\0${difference.slice}`);
    if (exception?.before === difference.before && exception.after === difference.after)
      allowed.push(exception);
    else unlisted.push(difference);
  }
  const used = new Set(allowed.map((item) => `${item.path}\0${item.slice}`));
  const unused = exceptions.filter((item) => !used.has(`${item.path}\0${item.slice}`));
  return { allowed, unlisted, unused };
}

function snapshotHash(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-m8-cutover-smoke-'));
  try {
    const artifacts = path.join(scratch, 'artifacts');
    fs.mkdirSync(artifacts);
    const baselineTarball = options.baselineTarball ?? (await packBaseline(artifacts));
    const candidateTarball = options.candidateTarball ?? (await packCandidate(artifacts));
    const baselineSha256 = sha256(fs.readFileSync(baselineTarball));
    const candidateSha256 = sha256(fs.readFileSync(candidateTarball));
    const baselinePackage = await extractPackage(
      baselineTarball,
      path.join(scratch, 'baseline-package'),
      expectedVersions.baseline
    );
    const candidatePackage = await extractPackage(
      candidateTarball,
      path.join(scratch, 'candidate-package'),
      expectedVersions.candidate
    );
    const baselineBins = packageBins(baselinePackage, path.join(scratch, 'baseline-bin'));
    const candidateBins = packageBins(candidatePackage, path.join(scratch, 'candidate-bin'));
    const targets = loadTargets(options.fixture);
    const exceptions = loadExceptions(options.fixture, targets);
    const baselineRoot = path.join(scratch, 'baseline-home');
    const candidateRoot = path.join(scratch, 'candidate-home');
    const baselineEnv = prepareHome(options.fixture, baselineRoot);
    const candidateEnv = prepareHome(options.fixture, candidateRoot);
    await exerciseBins(candidateBins, expectedVersions.candidate, candidateEnv);
    const baselineVersion = await run(baselineBins.asb, ['--version'], { env: baselineEnv });
    if (baselineVersion.stdout.trim() !== expectedVersions.baseline) {
      throw new Error(`Baseline bin returned ${baselineVersion.stdout.trim()}`);
    }

    await run(baselineBins.asb, ['sync', '--profile', options.profile, '--no-update'], {
      env: baselineEnv,
    });
    await run(candidateBins.asb, ['sync', '--profile', options.profile, '--no-update'], {
      env: candidateEnv,
    });

    const baselineSnapshot = snapshot(baselineRoot, targets);
    const candidateSnapshot = snapshot(candidateRoot, targets);
    const comparison = compareSnapshots(baselineSnapshot, candidateSnapshot, exceptions);
    if (comparison.unlisted.length > 0 || comparison.unused.length > 0) {
      throw new Error(`Baseline comparison failed: ${JSON.stringify(comparison)}`);
    }

    const probePath = targets.find(
      (target) =>
        candidateSnapshot[target].kind === 'file' &&
        baselineSnapshot[target].kind === 'file' &&
        !exceptions.some((exception) => exception.path === target && exception.slice === 'bytes')
    );
    if (!probePath) throw new Error('Comparator probe needs one unexcepted shared file target');
    const exceptedProbePath = exceptions.find(
      (exception) =>
        exception.slice === 'bytes' &&
        candidateSnapshot[exception.path].kind === 'file' &&
        baselineSnapshot[exception.path].kind === 'file'
    )?.path;
    if (!exceptedProbePath)
      throw new Error('Comparator probe needs one excepted shared file target');
    const probe = (target) => {
      const filePath = path.join(candidateRoot, target);
      const original = fs.readFileSync(filePath);
      try {
        fs.writeFileSync(filePath, Buffer.concat([original, Buffer.from('!')]));
        return compareSnapshots(
          baselineSnapshot,
          snapshot(candidateRoot, targets),
          exceptions
        ).unlisted.some((difference) => difference.path === target && difference.slice === 'bytes');
      } finally {
        fs.writeFileSync(filePath, original);
      }
    };
    const probeDetected = probe(probePath);
    const exceptedProbeDetected = probe(exceptedProbePath);
    const restoredSnapshot = snapshot(candidateRoot, targets);
    const restored = snapshotHash(restoredSnapshot) === snapshotHash(candidateSnapshot);
    if (!probeDetected || !exceptedProbeDetected || !restored)
      throw new Error('Comparator byte probe did not detect and restore');

    const output = {
      version: 1,
      baseline: {
        version: expectedVersions.baseline,
        tarballSha256: baselineSha256,
        snapshotSha256: snapshotHash(baselineSnapshot),
      },
      candidate: {
        version: expectedVersions.candidate,
        tarballSha256: candidateSha256,
        snapshotSha256: snapshotHash(candidateSnapshot),
        bins: ['asb', 'agent-switchboard'],
      },
      profile: options.profile,
      targets,
      allowedDifferences: comparison.allowed,
      unlistedDifferences: [],
      comparatorProbe: {
        path: probePath,
        detected: probeDetected,
        exceptedPath: exceptedProbePath,
        exceptedDetected: exceptedProbeDetected,
        restored,
      },
      ...(options.keep ? { scratch } : {}),
    };
    const json = `${JSON.stringify(output, null, 2)}\n`;
    if (options.json) fs.writeFileSync(options.json, json);
    process.stdout.write(json);
    process.stderr.write(
      `smoke baseline: ${targets.length} targets, ${comparison.allowed.length} allowed, 0 unlisted; baseline ${baselineSha256}\n`
    );
  } finally {
    if (!options.keep) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
