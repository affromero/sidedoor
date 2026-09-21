import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { publishPackages } from './publish-packages.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'package'));
  const artifacts = [];
  for (const name of ['thesidedoor-flock', 'thesidedoor-core', 'thesidedoor']) {
    const manifest = {
      name,
      version: '1.0.0',
      repository: { url: 'git+https://github.com/affromero/sidedoor.git' },
      ...(name === 'thesidedoor-core' ? { optionalDependencies: { 'thesidedoor-flock': '1.0.0' } } : {}),
    };
    await writeFile(join(directory, 'package/package.json'), JSON.stringify(manifest));
    const filename = `${name}-1.0.0.tgz`;
    await execute('tar', ['-czf', join(directory, filename), '-C', directory, 'package']);
    artifacts.push({
      name,
      version: '1.0.0',
      filename,
      integrity: `sha512-${createHash('sha512')
        .update(await readFile(join(directory, filename)))
        .digest('base64')}`,
    });
  }
  await writeFile(join(directory, 'artifacts.json'), JSON.stringify(artifacts));
  const published = new Map();
  const writes = [];
  const npm = async (args) => {
    if (args[0] === 'whoami') return JSON.stringify('release-test-owner');
    if (args[0] === 'view') {
      if (published.has(args[1])) return JSON.stringify(published.get(args[1]));
      throw Object.assign(new Error('Registry lookup failed'), {
        stdout: JSON.stringify({ error: { code: 'E404', summary: `${args[1]} is not in this registry` } }),
      });
    }
    assert.equal(args[0], 'publish');
    assert.ok(args.includes('--provenance'));
    const artifact = artifacts.find((item) => item.filename === basename(args[1]));
    assert.ok(artifact);
    assert.equal(args[1], join(directory, artifact.filename));
    writes.push(artifact.name);
    published.set(`${artifact.name}@${artifact.version}`, {
      name: artifact.name,
      version: artifact.version,
      dist: { integrity: artifact.integrity },
    });
    return '';
  };
  return { directory, artifacts, published, writes, npm, report: () => {} };
}

test('publishes the verified archives and resumes a partial release without repeating earlier publication', async (t) => {
  const f = await fixture(t);
  const interrupted = async (args) => {
    if (args[0] === 'publish' && basename(args[1]).startsWith('thesidedoor-core-'))
      throw new Error('Publish interrupted');
    return f.npm(args);
  };
  await assert.rejects(publishPackages(f.directory, 'v1.0.0', { ...f, npm: interrupted }), /interrupted/);
  assert.deepEqual(f.writes, ['thesidedoor-flock']);
  await publishPackages(f.directory, 'v1.0.0', f);
  assert.deepEqual(f.writes, ['thesidedoor-flock', 'thesidedoor-core', 'thesidedoor']);
  await publishPackages(f.directory, 'v1.0.0', f);
  assert.equal(f.writes.length, 3);
});

test('waits for a published archive to become visible before publishing its dependent package', async (t) => {
  const f = await fixture(t);
  const pendingViews = new Map();
  const waits = [];
  const delayedRegistry = async (args) => {
    if (args[0] === 'publish') {
      await f.npm(args);
      const artifact = f.artifacts.find((item) => item.filename === basename(args[1]));
      assert.ok(artifact);
      pendingViews.set(`${artifact.name}@${artifact.version}`, 2);
      return '';
    }
    if (args[0] === 'view') {
      const remaining = pendingViews.get(args[1]);
      if (remaining) {
        pendingViews.set(args[1], remaining - 1);
        throw Object.assign(new Error('Registry lookup failed'), {
          stdout: JSON.stringify({ error: { code: 'E404', summary: `${args[1]} is not in this registry` } }),
        });
      }
    }
    return f.npm(args);
  };
  await publishPackages(f.directory, 'v1.0.0', {
    ...f,
    npm: delayedRegistry,
    wait: async (delayMs) => waits.push(delayMs),
    visibilityAttempts: 3,
    visibilityDelayMs: 25,
  });
  assert.deepEqual(f.writes, ['thesidedoor-flock', 'thesidedoor-core', 'thesidedoor']);
  assert.deepEqual(waits, [25, 25, 25, 25, 25, 25]);
});

test('stops before dependent publication when registry visibility never arrives', async (t) => {
  const f = await fixture(t);
  const hidden = new Set();
  const unavailableRegistry = async (args) => {
    if (args[0] === 'publish') {
      await f.npm(args);
      const artifact = f.artifacts.find((item) => item.filename === basename(args[1]));
      assert.ok(artifact);
      hidden.add(`${artifact.name}@${artifact.version}`);
      return '';
    }
    if (args[0] === 'view' && hidden.has(args[1]))
      throw Object.assign(new Error('Registry lookup failed'), {
        stdout: JSON.stringify({ error: { code: 'E404', summary: `${args[1]} is not in this registry` } }),
      });
    return f.npm(args);
  };
  await assert.rejects(
    publishPackages(f.directory, 'v1.0.0', {
      ...f,
      npm: unavailableRegistry,
      wait: async () => {},
      visibilityAttempts: 3,
      visibilityDelayMs: 1,
    }),
    /not visible after 3 attempts: thesidedoor-flock@1.0.0/,
  );
  assert.deepEqual(f.writes, ['thesidedoor-flock']);
});

test('refuses every publication when any retained archive changed', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, f.artifacts[2].filename), 'changed');
  await assert.rejects(publishPackages(f.directory, 'v1.0.0', f), /Archive changed/);
  assert.deepEqual(f.writes, []);
});

test('preflights all versions before publishing a missing earlier dependency', async (t) => {
  const f = await fixture(t);
  f.published.set('thesidedoor@1.0.0', {
    name: 'thesidedoor',
    version: '1.0.0',
    dist: { integrity: 'sha512-conflict' },
  });
  await assert.rejects(publishPackages(f.directory, 'v1.0.0', f), /Published archive differs/);
  assert.deepEqual(f.writes, []);
});

test('does not interpret an authorization failure as an unpublished package', async (t) => {
  const f = await fixture(t);
  const denied = async (args) => {
    if (args[0] === 'view')
      throw Object.assign(new Error('Denied'), {
        stdout: JSON.stringify({ error: { code: 'E403', summary: args[1] } }),
      });
    return f.npm(args);
  };
  await assert.rejects(publishPackages(f.directory, 'v1.0.0', { ...f, npm: denied }), /Denied/);
  assert.deepEqual(f.writes, []);
});

test('refuses a mismatched release tag before contacting the publisher', async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishPackages(f.directory, 'v2.0.0', f), /tag must match/);
  assert.deepEqual(f.writes, []);
});

test('refuses package versions that do not match each other', async (t) => {
  const f = await fixture(t);
  const core = f.artifacts.find((item) => item.name === 'thesidedoor-core');
  assert.ok(core);
  const manifest = {
    name: core.name,
    version: '1.0.1',
    repository: { url: 'git+https://github.com/affromero/sidedoor.git' },
    optionalDependencies: { 'thesidedoor-flock': '1.0.0' },
  };
  await writeFile(join(f.directory, 'package/package.json'), JSON.stringify(manifest));
  core.version = manifest.version;
  core.filename = `${core.name}-${core.version}.tgz`;
  await execute('tar', ['-czf', join(f.directory, core.filename), '-C', f.directory, 'package']);
  core.integrity = `sha512-${createHash('sha512')
    .update(await readFile(join(f.directory, core.filename)))
    .digest('base64')}`;
  await writeFile(join(f.directory, 'artifacts.json'), JSON.stringify(f.artifacts));
  await assert.rejects(publishPackages(f.directory, 'v1.0.0', f), /package versions must match/i);
  assert.deepEqual(f.writes, []);
});
