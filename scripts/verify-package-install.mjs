import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { ProcessRunner } from '../packages/core/dist/runtime/process.js';
import { resolveConsumerLock } from './resolve-consumer-lock.mjs';
import { checkConsumerInstall } from './check-consumer-install.mjs';
import { verifyRegistryInstall } from './verify-public-install.mjs';

const runner = new ProcessRunner(1);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'sidedoor-registry-install-'));
const packages = new Map();
const downloads = new Set();
let registry;
let server;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^npm_config_|^(NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(key)),
);
environment.npm_config_userconfig = join(directory, 'user.npmrc');
environment.npm_config_globalconfig = join(directory, 'global.npmrc');
environment.npm_config_ignore_scripts = 'false';
// Package verification does not install development hooks in the source checkout.
environment.HUSKY = '0';

function parsePackResult(output) {
  for (let offset = output.indexOf('['); offset >= 0; offset = output.indexOf('[', offset + 1)) {
    try {
      const value = JSON.parse(output.slice(offset));
      if (Array.isArray(value) && value.length === 1 && typeof value[0]?.filename === 'string')
        return value[0];
    } catch {
      // The first bracket may belong to npm's progress output, so keep scanning.
    }
  }
  throw new Error(`npm pack did not return a package manifest:\n${output}`);
}

async function run(command, args, cwd = directory, options = {}) {
  const output = { stdout: '', stderr: '' };
  try {
    for await (const chunk of runner.stream({
      command,
      args,
      cwd,
      environment: options.environment ?? environment,
      timeoutMs: options.timeoutMs ?? 240000,
      maxOutputBytes: 64 * 1024 * 1024,
    })) {
      output[chunk.channel] += chunk.text;
      if (options.stream) process[chunk.channel].write(chunk.text);
    }
    return output.stdout;
  } catch (error) {
    throw new Error(`${command} failed\n${output.stdout}\n${output.stderr}`, { cause: error });
  }
}

try {
  await writeFile(environment.npm_config_userconfig, '');
  await writeFile(environment.npm_config_globalconfig, '');
  for (const location of [root, join(root, 'packages/core'), join(root, 'packages/flock')]) {
    const manifest = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
    const packed = parsePackResult(
      await run('npm', ['pack', '--json', '--pack-destination', directory], location),
    );
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, manifest.version);
    assert.ok(!packed.files.some((file) => /(^|\/)(node_modules|\.git)\//.test(file.path)));
    assert.ok(
      !packed.files.some((file) => file.path.endsWith('.node')),
      'Native binaries must be built for the consumer',
    );
    for (const entry of Object.values(manifest.exports ?? {})) {
      for (const target of typeof entry === 'string' ? [entry] : Object.values(entry))
        assert.ok(
          packed.files.some((file) => file.path === target.replace(/^\.\//, '')),
          `Missing export ${manifest.name}: ${target}`,
        );
    }
    const bytes = await readFile(join(directory, packed.filename));
    packages.set(manifest.name, {
      manifest,
      bytes,
      filename: packed.filename,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    });
  }
  server = createServer((request, response) => {
    let path;
    let packageName;
    try {
      path = new URL(request.url, 'http://127.0.0.1').pathname;
      packageName = decodeURIComponent(path.slice(1));
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    for (const [name, candidate] of packages) {
      if (path === `/artifacts/${candidate.filename}`) {
        downloads.add(name);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': candidate.bytes.length,
        });
        response.end(candidate.bytes);
        return;
      }
      if (packageName === name) {
        const { manifest } = candidate;
        const version = {
          ...manifest,
          dist: { tarball: `${registry}artifacts/${candidate.filename}`, integrity: candidate.integrity },
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            name,
            'dist-tags': { latest: manifest.version },
            versions: { [manifest.version]: version },
          }),
        );
        return;
      }
    }
    response.writeHead(307, {
      Location: `https://registry.npmjs.org${request.url.startsWith('/') ? request.url : '/'}`,
    });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  registry = `http://127.0.0.1:${server.address().port}/`;
  const dependencies = Object.fromEntries(
    ['thesidedoor', 'thesidedoor-core'].map((name) => [name, packages.get(name).manifest.version]),
  );
  for (const name of ['react', 'react-dom']) {
    const manifest = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    dependencies[name] = manifest.version;
  }
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies }),
  );
  const common = ['--registry', registry, '--cache', join(directory, 'npm-cache'), '--no-audit', '--no-fund'];
  await run('npm', ['install', ...common]);
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  assert.equal(
    lock.packages[''].dependencies['thesidedoor-flock'],
    undefined,
    'The native addon must resolve transitively',
  );
  for (const [name, candidate] of packages) {
    const resolved = lock.packages[`node_modules/${name}`];
    assert.equal(resolved.version, candidate.manifest.version);
    assert.equal(resolved.integrity, candidate.integrity);
    assert.equal(resolved.resolved, `${registry}artifacts/${candidate.filename}`);
    assert.ok(downloads.has(name), `Candidate was not fetched from the test registry: ${name}`);
  }
  await rm(join(directory, 'node_modules'), { recursive: true, force: true });
  await run('npm', ['ci', ...common]);
  for (const name of packages.keys()) await access(join(directory, 'node_modules', name, 'package.json'));
  await writeFile(join(directory, 'ai-text.mjs'), await readFile(join(root, 'examples/ai-text.mjs')));
  await writeFile(
    join(directory, 'verify-ai-example.mjs'),
    await readFile(join(root, 'scripts/verify-ai-example.mjs')),
  );
  await run(process.execPath, ['verify-ai-example.mjs']);
  process.stdout.write(
    'Installed AI example passed streaming, credential rejection and caller cancellation.\n',
  );
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { acquireFileLockSync } from 'thesidedoor-core/storage';
    import { reconcileOutboxPage } from 'thesidedoor-core/runtime/outbox';
    await import('thesidedoor/react');
    const require = createRequire(import.meta.url);
    require('thesidedoor/react');
    assert.equal(typeof reconcileOutboxPage, 'function');
      const release = acquireFileLockSync('./installed.lock');
      release();
      const commonStorage = require('thesidedoor-core/storage');
      assert.equal(typeof require('thesidedoor-core/runtime/outbox').reconcileOutboxPage, 'function');
      const commonRelease = commonStorage.acquireFileLockSync('./installed.lock');
      commonRelease();
  `,
  ]);
  process.stdout.write(
    'Registry resolution, transitive native compilation, clean npm ci, React exports and actual file locking passed.\n',
  );
  await writeFile(
    join(directory, 'artifacts.json'),
    JSON.stringify(
      [...packages].map(([name, candidate]) => ({
        name,
        version: candidate.manifest.version,
        filename: candidate.filename,
        integrity: candidate.integrity,
      })),
    ),
  );
  await verifyRegistryInstall(directory, registry);
  const argumentsList = process.argv.slice(2);
  assert.equal(argumentsList.length % 2, 0, 'Use --lock-consumer /absolute/worktree/path');
  for (let index = 0; index < argumentsList.length; index += 2) {
    if (argumentsList[index] === '--check-consumer') {
      const consumer = argumentsList[index + 1];
      await checkConsumerInstall({ consumer, directory, registry, candidates: packages, run, environment });
      process.stdout.write(`Clean consumer CI passed: ${consumer}\n`);
      continue;
    }
    if (argumentsList[index] === '--retain-artifacts') {
      const destination = argumentsList[index + 1];
      assert.ok(isAbsolute(destination), 'Artifact directory must be absolute');
      await mkdir(destination);
      const retained = [];
      for (const [name, candidate] of packages) {
        await writeFile(join(destination, candidate.filename), candidate.bytes, { flag: 'wx' });
        retained.push({
          name,
          version: candidate.manifest.version,
          filename: candidate.filename,
          integrity: candidate.integrity,
        });
      }
      await writeFile(join(destination, 'artifacts.json'), JSON.stringify(retained, null, 2) + '\n', {
        flag: 'wx',
      });
      process.stdout.write(`Retained tested package archives: ${destination}\n`);
      continue;
    }
    assert.equal(argumentsList[index], '--lock-consumer');
    const consumer = argumentsList[index + 1];
    await resolveConsumerLock({ consumer, directory, registry, candidates: packages, run });
    process.stdout.write(`Resolved candidate dependency lock: ${consumer}\n`);
  }
} finally {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await rm(directory, { recursive: true, force: true });
}
