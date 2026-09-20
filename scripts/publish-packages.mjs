import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const registry = 'https://registry.npmjs.org/';
const order = ['thesidedoor-flock', 'thesidedoor-core', 'thesidedoor'];

async function runNpm(args) {
  const { stdout } = await execute('npm', [...args, '--registry', registry], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function registeredVersion(candidate, npm) {
  const spec = `${candidate.name}@${candidate.version}`;
  let output;
  try {
    output = await npm(['view', spec, '--json']);
  } catch (error) {
    let failure;
    try {
      failure = JSON.parse(error.stdout);
    } catch {
      throw error;
    }
    if (
      failure.error?.code !== 'E404' ||
      !`${failure.error.summary ?? ''} ${failure.error.detail ?? ''}`.includes(spec)
    )
      throw error;
    return null;
  }
  const manifest = JSON.parse(output);
  assert.equal(manifest.name, candidate.name, 'Registry returned a different package');
  assert.equal(manifest.version, candidate.version, 'Registry returned a different version');
  assert.equal(manifest.dist?.integrity, candidate.integrity, `Published archive differs: ${spec}`);
  return manifest;
}

/** Publishes only archives already exercised by the installed-consumer verifier. */
export async function publishPackages(
  directory,
  tag,
  { npm = runNpm, report = (message) => process.stdout.write(`${message}\n`) } = {},
) {
  const artifacts = JSON.parse(await readFile(join(directory, 'artifacts.json'), 'utf8'));
  assert.equal(artifacts.length, order.length, 'Release must contain all packages');
  assert.deepEqual([...artifacts.map((item) => item.name)].sort(), [...order].sort());
  const candidates = [];
  for (const name of order) {
    const candidate = artifacts.find((item) => item.name === name);
    assert.match(candidate.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.equal(candidate.filename, `${candidate.name}-${candidate.version}.tgz`);
    assert.equal(basename(candidate.filename), candidate.filename);
    const path = resolve(directory, candidate.filename);
    const bytes = await readFile(path);
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      candidate.integrity,
      `Archive changed: ${name}`,
    );
    const { stdout } = await execute('tar', ['-xOf', path, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const manifest = JSON.parse(stdout);
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, candidate.version);
    assert.equal(
      manifest.repository?.url,
      'git+https://github.com/affromero/sidedoor.git',
      'Provenance requires the matching public repository',
    );
    candidates.push({ ...candidate, path, manifest });
  }
  const [native, core, ui] = candidates;
  assert.ok(
    candidates.every((candidate) => candidate.version === ui.version),
    'All package versions must match the release version',
  );
  assert.equal(tag, `v${ui.version}`, 'Release tag must match the root package version');
  assert.equal(
    core.manifest.optionalDependencies?.[native.name],
    native.version,
    'Core must pin the release native dependency',
  );
  for (const candidate of candidates) {
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of candidates) {
        const version = candidate.manifest[group]?.[dependency.name];
        if (version !== undefined)
          assert.equal(version, dependency.version, 'Internal release dependencies must use exact versions');
      }
    }
  }
  // Authenticate before interpreting an exact package/version E404 as unpublished.
  const identity = JSON.parse(await npm(['whoami', '--json']));
  assert.ok(typeof identity === 'string' && identity.trim(), 'An authenticated npm publisher is required');
  const existing = new Set();
  for (const candidate of candidates)
    if (await registeredVersion(candidate, npm)) existing.add(candidate.name);
  for (const candidate of candidates) {
    if (existing.has(candidate.name)) {
      report(`Verified existing archive: ${candidate.name}@${candidate.version}`);
      continue;
    }
    // Recheck exact bytes immediately before publication. Never repack a verified release.
    assert.equal(
      `sha512-${createHash('sha512')
        .update(await readFile(candidate.path))
        .digest('base64')}`,
      candidate.integrity,
      'Archive changed after preflight',
    );
    await npm(['publish', candidate.path, '--provenance', '--access', 'public', '--ignore-scripts']);
    report(`Published: ${candidate.name}@${candidate.version}`);
    assert.ok(
      await registeredVersion(candidate, npm),
      'Published version is not yet visible; retain these archives and retry verification',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, tag] = process.argv.slice(2);
  assert.ok(directory && tag, 'Usage: node scripts/publish-packages.mjs ARTIFACT_DIRECTORY vVERSION');
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Release publication requires the configured GitHub Actions provenance job',
  );
  await publishPackages(directory, tag);
}
