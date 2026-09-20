import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const directory = await mkdtemp(join(tmpdir(), 'sidedoor-artifact-'));
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', directory], root));
  const artifact = packed[0]?.filename;
  assert.ok(artifact, 'npm pack must produce an artifact');
  const nativePacked = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', directory], join(root, '..', 'flock')),
  );
  const nativeArtifact = nativePacked[0]?.filename;
  assert.ok(nativeArtifact, 'npm pack must produce the native source artifact');
  assert.ok(
    !nativePacked[0].files.some((file) => file.path.startsWith('build/')),
    'native archive must not include local build output',
  );
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    join(directory, nativeArtifact),
    join(directory, artifact),
  ]);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const entry of Object.keys(manifest.exports)) {
    const specifier = `${manifest.name}/${entry.slice(2)}`;
    run(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);', specifier]);
    run(process.execPath, ['-e', 'require(process.argv[1]);', specifier]);
  }
  run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { FileStateStore } from 'thesidedoor-core/storage';
    import { AccessService, initialAccessState, accessStateSchema } from 'thesidedoor-core/access';
    const store = new FileStateStore({ path: './access.json', initial: initialAccessState, parse: value => accessStateSchema.parse(value) });
    const access = new AccessService({ store });
    const claim = await access.issueOperatorToken();
    const session = await access.claimOwner(claim, 'Owner', 'artifact verification password', 'individual');
    assert.equal((await access.authenticate(session, true)).principal.name, 'Owner');
  `,
  ]);
  process.stdout.write('Package exports and standalone access persistence passed.\n');
  run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    const source = \`
      const { localEncryptionKey } = require('thesidedoor-core/storage');
      const { createHash } = require('node:crypto');
      const { setTimeout: delay } = require('node:timers/promises');
      (async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const key = localEncryptionKey('./concurrent.key', { create: true });
            process.stdout.write(createHash('sha256').update(key).digest('hex'));
            return;
          } catch (error) {
            if (error.code !== 'lock_busy') throw error;
            await delay(10);
          }
        }
        throw new Error('Key remained busy');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    \`;
    const keys = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    })));
    assert.equal(new Set(keys).size, 1);
    assert.match(keys[0], /^[a-f0-9]{64}$/);
  `,
  ]);
  process.stdout.write('Concurrent processes retained one local encryption key.\n');
  run('mkfifo', ['fifo.key']);
  const fifo = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const { localEncryptionKey } = require('thesidedoor-core/storage');
    assert.throws(() => localEncryptionKey('./fifo.key', {create:false}), /regular 32-byte file/);
  `,
    ],
    { cwd: directory, encoding: 'utf8', timeout: 3000 },
  );
  assert.ifError(fifo.error);
  assert.equal(fifo.status, 0, fifo.stderr);
  process.stdout.write('Nonregular key files fail without blocking.\n');
  for (const format of ['esm', 'cjs']) {
    run(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(process.cwd() + '/consumer.cjs');
      const load = ${JSON.stringify(format)} === 'cjs' ? async name => require(name) : async name => import(name);
      const usage = await load('thesidedoor-core/ai/usage');
      const otherUsage = ${JSON.stringify(format)} === 'cjs' ? await import('thesidedoor-core/ai/usage') : require('thesidedoor-core/ai/usage');
      const failure = new usage.IncompleteGenerationError('length', { inputTokens: 17, outputTokens: 4 });
      assert.equal(otherUsage.usageFromGenerationError(failure).inputTokens, 17);
      assert.equal(otherUsage.usageFromGenerationError(failure).outputTokens, 4);
      const { FileStateStore } = await load('thesidedoor-core/storage');
      const { AccessService, initialAccessState, accessStateSchema, hashPassword } = await load('thesidedoor-core/access');
      const { createAccessHandler } = await load('thesidedoor-core/access/http');
      const access = new AccessService({ store: new FileStateStore({ path: './${format}-http.json', initial: initialAccessState, parse: value => accessStateSchema.parse(value) }) });
      const handler = createAccessHandler({ access, origin: 'https://private.example', name: 'Artifact' });
      const post = (action, body, cookie = '') => handler(new Request('https://private.example/access/' + action, { method: 'POST', headers: { origin: 'https://private.example', 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }), action);
      assert.equal((await handler(new Request('https://private.example/access/session'), 'session')).status, 401);
      const code = await access.issueOperatorToken();
      assert.equal((await post('claim', { token: code, name: 'Owner', password: 'short', mode: 'household' })).status, 400);
      const owner = await post('claim', { token: code, name: 'Owner', password: 'artifact owner password', mode: 'household' });
      assert.equal(owner.status, 200);
      const cookie = owner.headers.get('set-cookie');
      const invitation = await post('issue-invitation', {}, cookie);
      const admitted = await post('redeem-invitation', { code: (await invitation.json()).code });
      assert.equal((await post('issue-invitation', {}, admitted.headers.get('set-cookie'))).status, 403);
      let busy;
      await Promise.all(Array.from({ length: 5 }, async () => { try { await hashPassword('artifact concurrency password'); } catch (error) { busy = error; } }));
      assert.ok(busy);
      const unavailable = createAccessHandler({ access: new AccessService({ store: { read: async () => { throw busy; }, transact: async () => { throw busy; } } }), origin: 'https://private.example', name: 'Busy' });
      assert.equal((await unavailable(new Request('https://private.example/access/session'), 'session')).status, 429);
    `,
    ]);
  }
  process.stdout.write('ESM and CJS HTTP authorization and password errors passed.\n');
  run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { Worker } from 'node:worker_threads';
    import { once } from 'node:events';
    import { acquireFileLockSync } from 'thesidedoor-core/storage';
    const source = \`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const api = workerData.esm ? await import('thesidedoor-core/storage') : require('thesidedoor-core/storage');
        api.acquireFileLockSync(workerData.path, 'shared');
        parentPort.postMessage('locked');
        setInterval(() => {}, 1000);
      })().catch(error => { throw error; });
    \`;
    for (let iteration = 0; iteration < 4; iteration++) {
      const workers = [];
      try {
        const ready = [];
        for (let i = 0; i < 8; i++) {
          const worker = new Worker(source, { eval: true, execArgv: [], workerData: { esm: i % 2 === 0, path: './worker.guard' } });
          workers.push(worker);
          ready.push(once(worker, 'message'));
        }
        await Promise.all(ready);
        assert.throws(() => acquireFileLockSync('./worker.guard', 'exclusive'), { code: 'lock_busy' });
        await Promise.all(workers.slice(1).map(worker => worker.terminate()));
        assert.throws(() => acquireFileLockSync('./worker.guard', 'exclusive'), { code: 'lock_busy' });
        await workers[0].terminate();
        acquireFileLockSync('./worker.guard', 'exclusive')();
      } finally {
        await Promise.all(workers.map(worker => worker.terminate()));
      }
    }
  `,
  ]);
  process.stdout.write('Concurrent ESM/CJS worker locks and termination cleanup passed.\n');
  await rm(join(directory, 'node_modules', 'thesidedoor-flock'), { recursive: true, force: true });
  for (const specifier of ['storage', 'storage/sql', 'storage/optimistic', 'storage/instance']) {
    const name = `thesidedoor-core/${specifier}`;
    run(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);', name]);
    run(process.execPath, ['-e', 'require(process.argv[1]);', name]);
  }
  for (const esm of [true, false]) {
    run(process.execPath, [
      ...(esm ? ['--input-type=module'] : []),
      '-e',
      `${esm ? "import assert from 'node:assert/strict'; import { acquireFileLockSync } from 'thesidedoor-core/storage';" : "const assert = require('node:assert/strict'); const { acquireFileLockSync } = require('thesidedoor-core/storage');"}
       assert.throws(() => acquireFileLockSync('./missing-native.guard'), /Native file locking is unavailable/);`,
    ]);
  }
  process.stdout.write('Database storage imports work without optional native filesystem locking.\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}
