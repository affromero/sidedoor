import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JobOutbox,
  JobExecutionJournal,
  prepareJob,
  runJobExecution,
  JobExecutionCleanupError,
  type JobExecutionRecord,
} from '../../../src/runtime/jobs/outbox';
import { StorageReadCleanupError } from '../../../src/storage/local/owned-copy';
import { Readable } from 'node:stream';
import { withOwnedReadables } from '../../../src/storage/local/owned-readable';
import { runStorageProbe } from '../../../src/storage/probe';
import { StorageInstanceControl } from '../../../src/storage/sql/instance';
import { storageBackendBinding } from '../../../src/storage/registry/references';
import { RedisSemaphoreLease, waitForSemaphore } from '../../../src/runtime/sync/semaphore';

describe('owned durable job execution', () => {
  let database: DatabaseSync;
  let root: string;
  let fault: string | undefined;
  let afterCommit: ((stage: string | undefined) => Promise<void>) | undefined;
  const scope = { subjectId: 'profile:owner', generation: 1 };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidedoor-job-execution-'));
    database = new DatabaseSync(':memory:');
    database.exec(
      'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE Result (value TEXT NOT NULL)',
    );
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
    fault = undefined;
    afterCommit = undefined;
  });
  const executor = () => ({
    query: async (sql: string, values: readonly unknown[]) =>
      database.prepare(sql).all(...(values as SQLInputValue[])),
  });
  function record(): JobExecutionRecord | undefined {
    const row = database
      .prepare("SELECT state FROM SidedoorState WHERE json_extract(state, '$.kind') = 'job_execution'")
      .get();
    return row ? (JSON.parse(String(row.state)) as JobExecutionRecord) : undefined;
  }
  async function transaction<Value>(operation: (value: DatabaseSync) => Promise<Value>) {
    const before = record();
    database.exec('BEGIN IMMEDIATE');
    let value: Value;
    try {
      value = await operation(database);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const after = record();
    let stage: string | undefined;
    if (!before && after) stage = 'admission';
    else if (
      before?.workspace &&
      after?.workspace &&
      !('directory' in before.workspace) &&
      'directory' in after.workspace
    )
      stage = 'attachment';
    else if (before?.workspace && after && !after.workspace) stage = 'release';
    else if (before && after && before.status !== after.status) stage = after.status;
    await afterCommit?.(stage);
    if (stage && fault === stage) {
      fault = undefined;
      throw new Error('COMMIT response lost');
    }
    return value;
  }
  async function fixture() {
    const outbox = new JobOutbox(executor(), 'sqlite', 'app');
    const parent = await transaction(() =>
      outbox.enqueue(
        prepareJob({
          namespace: 'app',
          handler: 'audio',
          version: 1,
          payload: {},
          scopes: [scope],
          delivery: { attempts: 3, priority: 0, availableAt: 0 },
        }),
      ),
    );
    const controller = new AbortController();
    return {
      namespace: 'app',
      dialect: 'sqlite' as const,
      executorId: randomUUID(),
      parentId: parent.job.id,
      fingerprint: parent.fingerprint,
      signal: controller.signal,
      controller,
      transaction,
      executor,
      validate: async () => true,
      isCleanupFailure: () => false,
      workspace: { root, locationId: randomUUID() },
    };
  }
  it('retains its workspace when a nested storage probe cannot confirm upload cleanup', async () => {
    const options = await fixture();
    const instance = await transaction(() =>
      new StorageInstanceControl(executor(), 'sqlite', 'app').initialize(randomUUID()),
    );
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'probe' };
    let path = '';
    const running = runJobExecution({
      ...options,
      run: async ({ directory }) => {
        path = directory!;
        await writeFile(join(path, 'source'), 'retained input');
        await runStorageProbe({
          namespace: 'app',
          dialect: 'sqlite',
          executorId: options.executorId,
          signal: options.signal,
          transaction,
          executor,
          captureAdmission: async () => ({
            instanceId: instance.instanceId,
            scopes: [{ subjectId: instance.subjectId, generation: instance.generation }, scope],
            snapshot: 'original',
          }),
          validateAdmission: async () => {},
          capturePort: async () => ({
            descriptor: {
              kind: 'object',
              location,
              binding: storageBackendBinding(location),
              access: null,
              publicUrl: null,
              referenceEncoding: 'raw',
            },
            write: async () => {
              throw new Error('Upload response lost');
            },
            has: async () => false,
            delete: async () => {
              throw new Error('An uncertain upload must not be deleted');
            },
          }),
        });
      },
    });
    await expect(running).rejects.toBeInstanceOf(AggregateError);
    expect(record()).toMatchObject({
      status: 'cleanup-unconfirmed',
      workspace: { directory: { root: path } },
    });
    expect(await readFile(join(path, 'source'), 'utf8')).toBe('retained input');
  });
  it('retains its workspace when cancellation cannot confirm semaphore release', async () => {
    const options = await fixture();
    let path = '';
    const running = runJobExecution({
      ...options,
      run: async ({ directory }) => {
        path = directory!;
        await writeFile(join(path, 'source'), 'retained input');
        const lease = new RedisSemaphoreLease(
          {
            eval: async (...input) => {
              const args = input[2];
              if (args[1] === 'release') throw new Error('Redis response lost');
              options.controller.abort(new Error('Cancelled'));
              return Date.now() + 5000;
            },
          },
          { namespace: 'app', resource: 'tts', limit: 1, ttlMs: 5000 },
        );
        await waitForSemaphore(lease, { signal: options.signal, delaysMs: [] });
      },
    });
    await expect(running).rejects.toBeInstanceOf(AggregateError);
    expect(record()).toMatchObject({
      status: 'cleanup-unconfirmed',
      workspace: { directory: { root: path } },
    });
    expect(await readFile(join(path, 'source'), 'utf8')).toBe('retained input');
  });
  it.each(['admission', 'attachment', 'release', 'settled'])(
    'recovers a lost %s response without replaying work',
    async (stage) => {
      const options = await fixture();
      fault = stage;
      let path = '';
      const result = await runJobExecution({
        ...options,
        run: async ({ directory }) => {
          path = directory!;
          expect(record()?.workspace).toHaveProperty('directory');
          await writeFile(join(path, 'audio'), 'private bytes');
          database.prepare('INSERT INTO Result VALUES (?)').run('published');
          return 'published';
        },
      });
      expect(result).toBe('published');
      expect(database.prepare('SELECT * FROM Result').all()).toEqual([{ value: 'published' }]);
      expect(record()).toMatchObject({ status: 'settled' });
      expect(record()).not.toHaveProperty('workspace');
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it.each(['admission', 'attachment'])('cleans an unstarted cancellation after %s', async (stage) => {
    const options = await fixture();
    const reason = new Error('Stop before work');
    afterCommit = async (current) => {
      if (current === stage) options.controller.abort(reason);
    };
    await expect(
      runJobExecution({
        ...options,
        run: async () => {
          database.prepare('INSERT INTO Result VALUES (?)').run('unexpected');
        },
      }),
    ).rejects.toBe(reason);
    expect(database.prepare('SELECT * FROM Result').all()).toEqual([]);
    expect(record()).toMatchObject({ status: 'settled' });
    expect(record()).not.toHaveProperty('workspace');
    await expect(lstat(join(root, `execution-${record()!.id}`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains an existing directory and unresolved intent without adopting it', async () => {
    const options = await fixture();
    afterCommit = async (stage) => {
      if (stage !== 'admission') return;
      const path = join(root, `execution-${record()!.id}`);
      await mkdir(path);
      await writeFile(join(path, 'audio'), 'preserved');
    };
    await expect(runJobExecution({ ...options, run: async () => 'unexpected' })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(record()).toMatchObject({ status: 'cleanup-unconfirmed' });
    expect(record()?.workspace).not.toHaveProperty('directory');
    expect(await readFile(join(root, `execution-${record()!.id}`, 'audio'), 'utf8')).toBe('preserved');
  });
  it('retains published data and its workspace when source closure is unconfirmed', async () => {
    const options = await fixture();
    let release!: () => void;
    let workspace = '';
    const source = new Readable({
      read() {},
      destroy(error, callback) {
        release = () => callback(error);
      },
    });
    await expect(
      runJobExecution({
        ...options,
        run: async ({ directory }) => {
          workspace = directory!;
          await writeFile(join(workspace, 'source'), 'copied bytes');
          return withOwnedReadables([source], async () => {
            database.prepare('INSERT INTO Result VALUES (?)').run('published');
            return 'published';
          });
        },
      }),
    ).rejects.toBeInstanceOf(StorageReadCleanupError);
    expect(record()).toMatchObject({ status: 'cleanup-unconfirmed' });
    expect(await readFile(join(workspace, 'source'), 'utf8')).toBe('copied bytes');
    expect(database.prepare('SELECT * FROM Result').all()).toEqual([{ value: 'published' }]);
    release();
    await expect.poll(() => source.closed).toBe(true);
    expect(record()).toMatchObject({ status: 'cleanup-unconfirmed' });
  });
  it('preserves published application data when workspace replacement prevents cleanup', async () => {
    const options = await fixture();
    await expect(
      runJobExecution({
        ...options,
        run: async ({ directory }) => {
          database.prepare('INSERT INTO Result VALUES (?)').run('published');
          await rename(directory!, join(root, 'original'));
          await mkdir(directory!);
          await writeFile(join(directory!, 'audio'), 'replacement');
          return 'published';
        },
      }),
    ).rejects.toBeInstanceOf(JobExecutionCleanupError);
    expect(database.prepare('SELECT * FROM Result').all()).toEqual([{ value: 'published' }]);
    expect(record()).toMatchObject({ status: 'cleanup-unconfirmed' });
    const workspace = record()!.workspace!;
    expect('directory' in workspace).toBe(true);
    expect(await readFile(join(root, `execution-${record()!.id}`, 'audio'), 'utf8')).toBe('replacement');
  });
  it('retains pending I/O files even when the application classifier rejects shared cleanup errors', async () => {
    const options = await fixture();
    const failure = new StorageReadCleanupError({ cause: new Error('Pending write') });
    await expect(
      runJobExecution({
        ...options,
        run: async ({ directory }) => {
          await writeFile(join(directory!, 'audio'), 'pending');
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(record()).toMatchObject({ status: 'cleanup-unconfirmed' });
    expect(await readFile(join(root, `execution-${record()!.id}`, 'audio'), 'utf8')).toBe('pending');
    const journal = new JobExecutionJournal(executor(), 'sqlite', 'app');
    await expect(journal.requireParentDrained(options.parentId, options.fingerprint)).rejects.toThrow(
      'unresolved',
    );
  });
  it('retains provider uncertainty without a workspace after a lost journal response', async () => {
    const options = await fixture();
    fault = 'cleanup-unconfirmed';
    await expect(
      runJobExecution({
        ...options,
        workspace: undefined,
        run: async ({ markCleanupUnconfirmed }) => {
          markCleanupUnconfirmed();
          return 'provider outcome unknown';
        },
      }),
    ).rejects.toBeInstanceOf(JobExecutionCleanupError);
    expect(record()).toMatchObject({ status: 'cleanup-unconfirmed' });
    expect(record()).not.toHaveProperty('workspace');
  });
  it('retains both errors and fences execution when the application cleanup classifier fails', async () => {
    const options = await fixture();
    const primary = new Error('Work failed');
    const classification = new Error('Classifier failed');
    await expect(
      runJobExecution({
        ...options,
        isCleanupFailure: () => {
          throw classification;
        },
        run: async ({ directory }) => {
          await writeFile(join(directory!, 'audio'), 'unresolved');
          throw primary;
        },
      }),
    ).rejects.toMatchObject({ errors: [primary, classification] });
    expect(record()).toMatchObject({ status: 'cleanup-unconfirmed' });
    expect(await readFile(join(root, `execution-${record()!.id}`, 'audio'), 'utf8')).toBe('unresolved');
  });
});
