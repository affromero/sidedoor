import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, glob } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';

/** Resolve candidate packages without mutating the consumer's installed modules or running scripts. */
export async function resolveConsumerLock({ consumer, directory, registry, candidates, run }) {
  assert.ok(isAbsolute(consumer), 'Consumer path must be absolute');
  const staged = await mkdtemp(join(directory, 'consumer-lock-'));
  const paths = (
    await run(
      'git',
      [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        'package.json',
        '**/package.json',
      ],
      consumer,
    )
  )
    .split('\0')
    .filter(Boolean);
  assert.ok(paths.includes('package.json'), 'Consumer must contain a root package manifest');
  const rootManifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'));
  const workspaces = rootManifest.workspaces?.packages ?? rootManifest.workspaces ?? [];
  for await (const path of glob(
    workspaces.map((workspace) => `${workspace}/package.json`),
    { cwd: consumer, exclude: ['**/node_modules/**'] },
  ))
    if (!paths.includes(path)) paths.push(path);
  const stagedManifests = new Set();
  for (const path of paths) {
    let contents;
    try {
      contents = await readFile(join(consumer, path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await mkdir(dirname(join(staged, path)), { recursive: true });
    await writeFile(join(staged, path), contents);
    stagedManifests.add(path);
  }
  const original = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  for (const path of Object.keys(original.packages))
    if (
      [...candidates.keys()].some(
        (name) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
      )
    )
      delete original.packages[path];
  await writeFile(join(staged, 'package-lock.json'), JSON.stringify(original, null, 2) + '\n');
  await run(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry',
      registry,
      '--cache',
      join(directory, 'npm-cache'),
    ],
    staged,
  );
  const lock = JSON.parse(await readFile(join(staged, 'package-lock.json'), 'utf8'));
  for (const [name, candidate] of candidates) {
    const entries = Object.entries(lock.packages).filter(
      ([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
    );
    assert.ok(entries.length, `Consumer did not resolve ${name}`);
    for (const [, entry] of entries) {
      assert.equal(entry.version, candidate.manifest.version);
      assert.equal(entry.integrity, candidate.integrity);
      assert.equal(entry.resolved, `${registry}artifacts/${candidate.filename}`);
      entry.resolved = `https://registry.npmjs.org/${name}/-/${candidate.filename}`;
    }
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!entry.resolved) continue;
    assert.ok(
      !entry.resolved.includes(registry) && !entry.resolved.includes(directory),
      `Temporary resolution remains: ${path}`,
    );
    assert.ok(!entry.resolved.startsWith('file:'), `Unstaged file dependency: ${path}`);
    if (entry.link)
      assert.ok(stagedManifests.has(`${entry.resolved}/package.json`), `Unstaged workspace: ${path}`);
  }
  const temporary = join(consumer, `.package-lock.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, join(consumer, 'package-lock.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}
