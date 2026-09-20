import assert from 'node:assert/strict';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { URL } from 'node:url';

/** Copy source-controlled inputs, including current submodule changes, without installed artifacts. */
async function copySource(source, destination, run) {
  const sourceRoot = await realpath(source);
  const paths = (await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], source))
    .split('\0')
    .filter(Boolean);
  for (const path of paths) {
    if (
      path
        .split('/')
        .some(
          (part) =>
            part === '.git' ||
            part === 'node_modules' ||
            (part.startsWith('.env') && !part.endsWith('.example')),
        )
    )
      continue;
    const input = join(source, path);
    const output = join(destination, path);
    let info;
    try {
      info = await lstat(input);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const actual = relative(sourceRoot, await realpath(input));
    assert.ok(
      actual !== '..' && !actual.startsWith('../') && !isAbsolute(actual),
      `Source input escapes its repository: ${path}`,
    );
    await mkdir(dirname(output), { recursive: true });
    if (info.isSymbolicLink()) {
      const target = await readlink(input);
      const local = relative(destination, resolve(dirname(output), target));
      assert.ok(
        !isAbsolute(target) && local !== '..' && !local.startsWith('../'),
        `External source symlink: ${path}`,
      );
      await symlink(target, output);
    } else if (info.isDirectory()) {
      await mkdir(output, { recursive: true });
      await copySource(input, output, run);
    } else if (info.isFile()) await copyFile(input, output);
    else throw new Error(`Unsupported source input: ${path}`);
  }
}

export async function checkConsumerInstall({ consumer, directory, registry, candidates, run, environment }) {
  assert.ok(isAbsolute(consumer), 'Consumer path must be absolute');
  const staged = await mkdtemp(join(directory, 'consumer-ci-'));
  await copySource(consumer, staged, run);
  const lockPath = join(staged, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const found = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry.resolved && !entry.link) {
      assert.ok(
        !entry.resolved.startsWith('file:') && !isAbsolute(entry.resolved),
        `Local dependency resolution: ${path}`,
      );
      if (/^https?:/.test(entry.resolved))
        assert.ok(
          !['localhost', '127.0.0.1', '[::1]'].includes(new URL(entry.resolved).hostname),
          `Loopback dependency resolution: ${path}`,
        );
    }
    for (const [name, candidate] of candidates) {
      if (path !== `node_modules/${name}` && !path.endsWith(`/node_modules/${name}`)) continue;
      assert.equal(entry.version, candidate.manifest.version);
      assert.equal(entry.integrity, candidate.integrity);
      assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${candidate.filename}`);
      entry.resolved = `${registry}artifacts/${candidate.filename}`;
      found.add(name);
    }
  }
  assert.equal(found.size, candidates.size, 'Consumer must lock all candidate packages');
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'NODE_EXTRA_CA_CERTS',
  ]);
  const testEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => allowed.has(key.toUpperCase()) || /^npm_config_/i.test(key),
    ),
  );
  testEnvironment.CI = 'true';
  testEnvironment.NEXT_TELEMETRY_DISABLED = '1';
  if (environment.SIDEDOOR_TEST_APP_URL) {
    const url = new URL(environment.SIDEDOOR_TEST_APP_URL);
    assert.ok(
      ['http:', 'https:'].includes(url.protocol) &&
        (['localhost', '127.0.0.1', '[::1]', 'example.com'].includes(url.hostname) ||
          url.hostname.endsWith('.example.com')) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/',
      'Consumer CI requires a local or reserved example application origin',
    );
    testEnvironment.NEXT_PUBLIC_APP_URL = url.origin;
  }
  for (const [input, target] of [
    ['SIDEDOOR_TEST_DATABASE_URL', 'DATABASE_URL'],
    ['SIDEDOOR_TEST_REDIS_URL', 'REDIS_URL'],
  ]) {
    if (!environment[input]) continue;
    const url = new URL(environment[input]);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
      'Consumer CI requires disposable local services',
    );
    assert.ok(
      input.includes('REDIS') ? url.pathname === '/15' : /test/i.test(url.pathname),
      'Consumer CI requires a test database',
    );
    testEnvironment[input] = environment[input];
    testEnvironment[target] = environment[input];
  }
  const options = { timeoutMs: 1200000, environment: testEnvironment, stream: true };
  await run(
    'npm',
    ['ci', '--registry', registry, '--cache', join(directory, 'npm-cache'), '--no-audit', '--no-fund'],
    staged,
    options,
  );
  const manifest = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
  if (manifest.scripts?.['db:generate']) await run('npm', ['run', 'db:generate'], staged, options);
  await run('npm', ['run', 'ci'], staged, options);
}
