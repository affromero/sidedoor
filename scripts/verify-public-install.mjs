import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function verifyRegistryInstall(artifactDirectory, registry = 'https://registry.npmjs.org/') {
  const artifacts = JSON.parse(await readFile(join(artifactDirectory, 'artifacts.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-public-install-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'TEMP',
        'TMP',
        'LANG',
        'LC_ALL',
        'NODE_EXTRA_CA_CERTS',
        'SDKROOT',
      ].includes(key),
    ),
  );
  Object.assign(environment, {
    npm_config_userconfig: join(directory, 'npmrc'),
    npm_config_globalconfig: join(directory, 'global-npmrc'),
    npm_config_ignore_scripts: 'false',
  });
  async function run(command, args) {
    try {
      return (
        await execute(command, args, {
          cwd: directory,
          env: environment,
          encoding: 'utf8',
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      throw new Error(`${command} failed\n${error.stdout}\n${error.stderr}`, { cause: error });
    }
  }
  try {
    await writeFile(environment.npm_config_userconfig, '');
    await writeFile(environment.npm_config_globalconfig, '');
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    const dependencies = Object.fromEntries(
      artifacts.filter((item) => item.name !== 'thesidedoor-flock').map((item) => [item.name, item.version]),
    );
    for (const name of ['react', 'react-dom'])
      dependencies[name] = lock.packages[`node_modules/${name}`].version;
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ private: true, type: 'module', dependencies }),
    );
    const options = [
      '--registry',
      registry,
      '--cache',
      join(directory, 'empty-cache'),
      '--no-audit',
      '--no-fund',
    ];
    await run('npm', ['install', ...options]);
    const installed = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    for (const artifact of artifacts) {
      assert.equal(installed.packages[`node_modules/${artifact.name}`].integrity, artifact.integrity);
      assert.equal(installed.packages[`node_modules/${artifact.name}`].version, artifact.version);
    }
    assert.equal(installed.packages[''].dependencies['thesidedoor-flock'], undefined);
    await rm(join(directory, 'node_modules'), { recursive: true, force: true });
    await run('npm', ['ci', ...options]);
    for (const artifact of artifacts) {
      const manifest = JSON.parse(
        await readFile(join(directory, 'node_modules', artifact.name, 'package.json'), 'utf8'),
      );
      for (const [entry, target] of Object.entries(manifest.exports ?? {})) {
        if (typeof target === 'string') continue;
        const spec = artifact.name + entry.slice(1);
        await run(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', spec]);
        await run(process.execPath, ['-e', 'require(process.argv[1])', spec]);
      }
    }
    await run(process.execPath, [
      '--input-type=module',
      '-e',
      "import { acquireFileLockSync } from 'thesidedoor-core/storage'; const release = acquireFileLockSync('./public-install.lock'); release();",
    ]);
    await writeFile(join(directory, 'ai-text.mjs'), await readFile(join(root, 'examples/ai-text.mjs')));
    await writeFile(
      join(directory, 'verify-ai-example.mjs'),
      await readFile(join(root, 'scripts/verify-ai-example.mjs')),
    );
    await run(process.execPath, ['verify-ai-example.mjs']);
    process.stdout.write(
      'Exact registry archives, transitive native locking, ESM/CJS exports and the AI example passed.\n',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], 'Usage: node scripts/verify-public-install.mjs ARTIFACT_DIRECTORY');
  await verifyRegistryInstall(process.argv[2]);
}
