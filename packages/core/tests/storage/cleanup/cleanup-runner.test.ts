import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CleanupExecutionJournal,
  prepareStorageBackend,
  prepareStorageCleanup,
  prepareStorageReference,
  prepareStorageWrite,
  runStorageCleanup,
  StorageBackendRegistry,
  StorageCleanupJournal,
  StorageReferenceRegistry,
  StorageWriteJournal,
  storageBackendBinding,
  type StorageCleanupBackendPort,
} from '../../../src/storage';
import { StorageTargetFence } from '../../../src/storage/execution/target-fence';
import { registerFailedDeleteCase } from './cases/runner-failure';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

export async function fixture(retention = false) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (value: typeof executor) => Promise<Result>) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await run(executor);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const location = {
    kind: 'object' as const,
    endpoint: 'https://storage.example',
    bucket: 'private',
  };
  const backend = prepareStorageBackend('app', {
    kind: 'object',
    location,
    binding: storageBackendBinding(location),
  });
  const job = prepareStorageCleanup({
    namespace: 'app',
    subjectId: 'episode:one',
    generation: 1,
    ...(retention ? { retentionPolicy: 'job-id-snapshots-v1' as const } : {}),
  });
  await transaction(async (tx) => {
    await new StorageBackendRegistry(tx, 'sqlite', 'app').register(backend);
    const journal = new StorageCleanupJournal(tx, 'sqlite', 'app');
    await journal.createJob(job);
    await journal.registerCollectors(job.id, job.epoch, [
      {
        id: 'references',
        kind: 'references',
        backendIds: [backend.id],
        scope: job.subjectId,
      },
      {
        id: 'inventory',
        kind: 'inventory',
        backendIds: [backend.id],
        scope: 'episodes/one/',
        match: 'prefix',
      },
    ]);
  });
  const target = {
    backendId: backend.id,
    binding: backend.binding,
    key: 'episodes/one/audio.mp3',
  };
  return { database, executor, transaction, backend, job, target };
}

describe('storage cleanup runner', () => {
  it('refuses a collector spanning multiple backends before deleting anything', async () => {
    const item = await fixture();
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'other' };
    const other = prepareStorageBackend('app', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
    });
    await item.transaction(async (tx) => {
      await new StorageBackendRegistry(tx, 'sqlite', 'app').register(other);
      await new StorageCleanupJournal(tx, 'sqlite', 'app').registerCollectors(item.job.id, item.job.epoch, [
        {
          id: 'ambiguous',
          kind: 'inventory',
          backendIds: [item.backend.id, other.id],
          scope: 'episodes/one/',
          match: 'prefix',
        },
      ]);
    });
    const objects = new Set([item.target.key]);
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [item.backend, other].map((backend) => ({
          backendId: backend.id,
          binding: backend.binding,
          collect: async () => ({ targets: [], next: null }),
          delete: async (key: string) => {
            objects.delete(key);
          },
        })),
      }),
    ).rejects.toThrow('one backend per collector');
    expect(objects.has(item.target.key)).toBe(true);
  });

  it('records uncertainty before dispatching inventory and deletion', async () => {
    const item = await fixture();
    const objects = new Set([item.target.key]);
    const observed: string[] = [];
    const assertUnconfirmed = async (operation: string) => {
      const execution = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
        item.backend.binding,
      );
      expect(execution?.status).toBe('unconfirmed');
      observed.push(operation);
    };
    await runStorageCleanup({
      namespace: 'app',
      dialect: 'sqlite',
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx) => tx,
      ports: [
        {
          backendId: item.backend.id,
          binding: item.backend.binding,
          collect: async () => {
            await assertUnconfirmed('collect');
            return { targets: objects.has(item.target.key) ? [item.target] : [], next: null };
          },
          delete: async (key) => {
            await assertUnconfirmed('delete');
            objects.delete(key);
          },
        },
      ],
    });
    expect(observed).toContain('collect');
    expect(observed).toContain('delete');
    expect(objects.size).toBe(0);
  });

  it('does not accept old completion if another job takes over during lost settlement', async () => {
    const item = await fixture();
    const next = prepareStorageCleanup({ namespace: 'app', subjectId: 'episode:other', generation: 1 });
    await item.transaction(async (tx) => {
      const journal = new StorageCleanupJournal(tx, 'sqlite', 'app');
      await journal.createJob(next);
      await journal.registerCollectors(next.id, next.epoch, [
        {
          id: 'inventory',
          kind: 'inventory',
          backendIds: [item.backend.id],
          scope: 'episodes/other/',
          match: 'prefix',
        },
      ]);
    });
    const successor = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: next.id,
      backendBinding: item.backend.binding,
    };
    const controller = new AbortController();
    const objects = new Set<string>();
    let interrupted = false;
    const options = {
      namespace: 'app',
      dialect: 'sqlite' as const,
      jobId: item.job.id,
      signal: controller.signal,
      transaction: async <Result>(run: (tx: typeof item.executor) => Promise<Result>) => {
        const result = await item.transaction(run);
        const job = await new StorageCleanupJournal(item.executor, 'sqlite', 'app').get(item.job.id);
        const current = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
          item.backend.binding,
        );
        if (!interrupted && job.phase === 'complete' && current?.status === 'settled') {
          interrupted = true;
          objects.add(item.target.key);
          controller.abort(new Error('backend lock lost during settlement commit'));
          await item.transaction((tx) => new CleanupExecutionJournal(tx, 'sqlite', 'app').begin(successor));
        }
        return result;
      },
      executor: (tx: typeof item.executor) => tx,
      ports: [
        {
          backendId: item.backend.id,
          binding: item.backend.binding,
          collect: async () => ({ targets: objects.has(item.target.key) ? [item.target] : [], next: null }),
          delete: async (key: string) => {
            objects.delete(key);
          },
        },
      ],
    };
    await expect(runStorageCleanup(options)).rejects.toThrow();
    await expect(
      runStorageCleanup({ ...options, signal: new AbortController().signal, transaction: item.transaction }),
    ).rejects.toThrow('requires confirmed backend execution');
  });

  it('does not accept stale completion when ownership is lost during settlement commit', async () => {
    const item = await fixture();
    const controller = new AbortController();
    const objects = new Set<string>();
    let interrupted = false;
    const options = {
      namespace: 'app',
      dialect: 'sqlite' as const,
      jobId: item.job.id,
      signal: controller.signal,
      transaction: <Result>(run: (tx: typeof item.executor) => Promise<Result>) =>
        item.transaction(async (tx) => {
          const result = await run(tx);
          const job = await new StorageCleanupJournal(tx, 'sqlite', 'app').get(item.job.id);
          const execution = await new CleanupExecutionJournal(tx, 'sqlite', 'app').current(
            item.backend.binding,
          );
          if (!interrupted && job.phase === 'complete' && execution?.status === 'settled') {
            interrupted = true;
            objects.add(item.target.key);
            controller.abort(new Error('backend lock lost during settlement commit'));
          }
          return result;
        }),
      executor: (tx: typeof item.executor) => tx,
      ports: [
        {
          backendId: item.backend.id,
          binding: item.backend.binding,
          collect: async () => ({ targets: objects.has(item.target.key) ? [item.target] : [], next: null }),
          delete: async (key: string) => {
            objects.delete(key);
          },
        },
      ],
    };
    await expect(runStorageCleanup(options)).rejects.toThrow('backend lock lost during settlement commit');
    const current = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
      item.backend.binding,
    );
    if (!current) throw new Error('Cleanup execution is missing');
    expect(current.status).toBe('unconfirmed');
    const { executionId, executorId, jobId, backendBinding } = current;
    await item.transaction((tx) =>
      new CleanupExecutionJournal(tx, 'sqlite', 'app').resolveUnconfirmed(
        { executionId, executorId, jobId, backendBinding },
        { id: randomUUID(), kind: 'remote-operations-settled' },
      ),
    );
    await runStorageCleanup({
      ...options,
      signal: new AbortController().signal,
      transaction: item.transaction,
    });
    expect(objects.has(item.target.key)).toBe(false);
  });

  it.each(['collecting', 'verifying'] as const)(
    'rechecks a %s inventory page committed during backend lock loss',
    async (phase) => {
      const item = await fixture();
      const controller = new AbortController();
      const objects = new Set<string>();
      let interrupted = false;
      const options = {
        namespace: 'app',
        dialect: 'sqlite' as const,
        jobId: item.job.id,
        signal: controller.signal,
        transaction: <Result>(run: (tx: typeof item.executor) => Promise<Result>) =>
          item.transaction(async (tx) => {
            const result = await run(tx);
            const journal = new StorageCleanupJournal(tx, 'sqlite', 'app');
            const job = await journal.get(item.job.id);
            const page = await journal.listCollectors(item.job.id);
            if (
              !interrupted &&
              job.phase === phase &&
              page.collectors.some((item) => item.kind === 'inventory' && item.complete)
            ) {
              interrupted = true;
              objects.add(item.target.key);
              controller.abort(new Error('backend lock lost during inventory commit'));
            }
            return result;
          }),
        executor: (tx: typeof item.executor) => tx,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => ({ targets: objects.has(item.target.key) ? [item.target] : [], next: null }),
            delete: async (key: string) => {
              objects.delete(key);
            },
          },
        ],
      };
      await expect(runStorageCleanup(options)).rejects.toThrow('backend lock lost during inventory commit');
      const current = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
        item.backend.binding,
      );
      if (!current) throw new Error('Cleanup execution is missing');
      const { executionId, executorId, jobId, backendBinding } = current;
      await item.transaction((tx) =>
        new CleanupExecutionJournal(tx, 'sqlite', 'app').resolveUnconfirmed(
          { executionId, executorId, jobId, backendBinding },
          { id: randomUUID(), kind: 'remote-operations-settled' },
        ),
      );
      await runStorageCleanup({
        ...options,
        signal: new AbortController().signal,
        transaction: item.transaction,
      });
      expect(objects.has(item.target.key)).toBe(false);
    },
  );

  it('keeps retention cleanup unresolved when verification ownership is uncertain', async () => {
    const item = await fixture(true);
    const controller = new AbortController();
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        signal: controller.signal,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async (collector) => {
              if (collector.verification > 0) controller.abort(new Error('backend lock lost'));
              return { targets: [], next: null };
            },
            delete: async () => {
              throw new Error('unexpected deletion');
            },
          },
        ],
      }),
    ).rejects.toThrow('backend lock lost');
    const current = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
      item.backend.binding,
    );
    if (!current) throw new Error('Cleanup execution is missing');
    const { executionId, executorId, jobId, backendBinding } = current;
    await expect(
      item.transaction((tx) =>
        new CleanupExecutionJournal(tx, 'sqlite', 'app').resolveUnconfirmed(
          { executionId, executorId, jobId, backendBinding },
          { id: randomUUID(), kind: 'remote-operations-settled' },
        ),
      ),
    ).rejects.toThrow('requires reviewed recovery');
    expect(
      (await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(item.backend.binding))
        ?.status,
    ).toBe('unconfirmed');
  });

  it('rechecks inventory after lock loss during completion commit', async () => {
    const item = await fixture();
    const controller = new AbortController();
    const objects = new Set<string>();
    let interrupted = false;
    const options = {
      namespace: 'app',
      dialect: 'sqlite' as const,
      jobId: item.job.id,
      signal: controller.signal,
      transaction: <Result>(run: (tx: typeof item.executor) => Promise<Result>) =>
        item.transaction(async (tx) => {
          const result = await run(tx);
          const job = await new StorageCleanupJournal(tx, 'sqlite', 'app').get(item.job.id);
          if (!interrupted && job.phase === 'complete') {
            interrupted = true;
            objects.add(item.target.key);
            controller.abort(new Error('backend lock lost during commit'));
          }
          return result;
        }),
      executor: (tx: typeof item.executor) => tx,
      ports: [
        {
          backendId: item.backend.id,
          binding: item.backend.binding,
          collect: async () => ({ targets: objects.has(item.target.key) ? [item.target] : [], next: null }),
          delete: async (key: string) => {
            objects.delete(key);
          },
        },
      ],
    };
    await expect(runStorageCleanup(options)).rejects.toThrow('backend lock lost during commit');
    const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
    const current = await executions.current(item.backend.binding);
    if (!current) throw new Error('Cleanup execution is missing');
    const { executionId, executorId, jobId, backendBinding } = current;
    await item.transaction((tx) =>
      new CleanupExecutionJournal(tx, 'sqlite', 'app').resolveUnconfirmed(
        { executionId, executorId, jobId, backendBinding },
        { id: randomUUID(), kind: 'remote-operations-settled' },
      ),
    );
    await runStorageCleanup({
      ...options,
      signal: new AbortController().signal,
      transaction: item.transaction,
    });
    expect(objects.has(item.target.key)).toBe(false);
  });

  it.each([
    { next: 'collecting', previous: 'waiting' },
    { next: 'verifying', previous: 'deleting' },
  ])('rolls back $next when backend ownership is lost during the change', async ({ next, previous }) => {
    const item = await fixture();
    const controller = new AbortController();
    const executor = {
      async query(sql: string, values: readonly unknown[]) {
        const result = await item.executor.query(sql, values);
        if (
          sql.startsWith('UPDATE "SidedoorState"') &&
          String(values[2]).startsWith('sd-c:1:') &&
          typeof values[1] === 'string' &&
          values[1].includes(`"phase":"${next}"`)
        )
          controller.abort(new Error('backend lock lost during phase change'));
        return result;
      },
    };
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        signal: controller.signal,
        transaction: item.transaction,
        executor: () => executor,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {
              throw new Error('unexpected deletion');
            },
          },
        ],
      }),
    ).rejects.toThrow('backend lock lost during phase change');
    expect((await new StorageCleanupJournal(item.executor, 'sqlite', 'app').get(item.job.id)).phase).toBe(
      previous,
    );
  });

  it('recognizes a completed cleanup after another job reuses the backend gate', async () => {
    const item = await fixture();
    const port: StorageCleanupBackendPort = {
      backendId: item.backend.id,
      binding: item.backend.binding,
      collect: async () => ({ targets: [], next: null }),
      delete: async () => {
        throw new Error('unexpected deletion');
      },
    };
    const options = {
      namespace: 'app',
      dialect: 'sqlite' as const,
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx: typeof item.executor) => tx,
      ports: [port],
    };
    await runStorageCleanup(options);
    const next = prepareStorageCleanup({ namespace: 'app', subjectId: 'episode:two', generation: 1 });
    await item.transaction(async (tx) => {
      const journal = new StorageCleanupJournal(tx, 'sqlite', 'app');
      await journal.createJob(next);
      await journal.registerCollectors(next.id, next.epoch, [
        {
          id: 'inventory',
          kind: 'inventory',
          backendIds: [item.backend.id],
          scope: 'episodes/two/',
          match: 'prefix',
        },
      ]);
    });
    await runStorageCleanup({ ...options, jobId: next.id });
    await expect(runStorageCleanup(options)).resolves.toBeUndefined();
    item.database
      .prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-ce:1:%' AND json_extract(state, '$.jobId') = ?")
      .run(item.job.id);
    await expect(runStorageCleanup(options)).rejects.toThrow('requires confirmed backend execution');
  });

  it('does not commit completion if backend ownership is lost during the transition', async () => {
    const item = await fixture();
    const controller = new AbortController();
    const executor = {
      async query(sql: string, values: readonly unknown[]) {
        const result = await item.executor.query(sql, values);
        if (
          sql.startsWith('UPDATE "SidedoorState"') &&
          String(values[2]).startsWith('sd-c:1:') &&
          typeof values[1] === 'string' &&
          values[1].includes('"phase":"complete"')
        )
          controller.abort(new Error('backend lock lost during completion'));
        return result;
      },
    };
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        signal: controller.signal,
        transaction: item.transaction,
        executor: () => executor,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {
              throw new Error('unexpected deletion');
            },
          },
        ],
      }),
    ).rejects.toThrow('backend lock lost during completion');
    expect((await new StorageCleanupJournal(item.executor, 'sqlite', 'app').get(item.job.id)).phase).toBe(
      'verifying',
    );
    expect(
      (await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(item.backend.binding))
        ?.status,
    ).toBe('unconfirmed');
  });

  it.each(['completion', 'settlement'] as const)(
    'recovers a completed cleanup after the %s response is lost',
    async (boundary) => {
      const item = await fixture();
      const journal = new StorageCleanupJournal(item.executor, 'sqlite', 'app');
      let lost = false;
      const options = {
        namespace: 'app',
        dialect: 'sqlite' as const,
        jobId: item.job.id,
        transaction: async <Result>(run: (tx: typeof item.executor) => Promise<Result>) => {
          const result = await item.transaction(run);
          const execution = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
            item.backend.binding,
          );
          if (
            !lost &&
            (await journal.get(item.job.id)).phase === 'complete' &&
            (boundary === 'completion' || execution?.status === 'settled')
          ) {
            lost = true;
            throw new Error('committed response lost');
          }
          return result;
        },
        executor: (tx: typeof item.executor) => tx,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {
              throw new Error('unexpected deletion');
            },
          },
        ],
      };
      await expect(runStorageCleanup(options)).rejects.toThrow('committed response lost');
      expect((await journal.get(item.job.id)).phase).toBe('complete');
      await expect(runStorageCleanup(options)).resolves.toBeUndefined();
    },
  );

  it('leaves only the affected backend unresolved after a failed collection', async () => {
    const item = await fixture();
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'other' };
    const other = prepareStorageBackend('app', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
    });
    await item.transaction(async (tx) => {
      await new StorageBackendRegistry(tx, 'sqlite', 'app').register(other);
      await new StorageCleanupJournal(tx, 'sqlite', 'app').registerCollectors(item.job.id, item.job.epoch, [
        {
          id: 'other',
          kind: 'inventory',
          backendIds: [other.id],
          scope: 'other/',
          match: 'prefix',
        },
      ]);
    });
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {},
          },
          {
            backendId: other.id,
            binding: other.binding,
            collect: async () => {
              throw new Error('inventory response lost');
            },
            delete: async () => {},
          },
        ],
      }),
    ).rejects.toThrow('inventory response lost');
    const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
    expect((await executions.current(item.backend.binding))?.status).toBe('settled');
    expect((await executions.current(other.binding))?.status).toBe('unconfirmed');
  });

  it('rolls back an inventory page if backend ownership is lost while recording it', async () => {
    const item = await fixture();
    const controller = new AbortController();
    const executor = {
      async query(sql: string, values: readonly unknown[]) {
        const result = await item.executor.query(sql, values);
        if (sql.startsWith('UPDATE "SidedoorState"') && String(values[2]).startsWith('sd-i:1:'))
          controller.abort(new Error('backend lock lost during page commit'));
        return result;
      },
    };
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        signal: controller.signal,
        transaction: item.transaction,
        executor: () => executor,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {
              throw new Error('unexpected deletion');
            },
          },
        ],
      }),
    ).rejects.toThrow('backend lock lost during page commit');
    const page = await new StorageCleanupJournal(item.executor, 'sqlite', 'app').listCollectors(item.job.id);
    expect(page.collectors.every((collector) => !collector.complete)).toBe(true);
    const execution = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
      item.backend.binding,
    );
    expect(execution?.status).toBe('unconfirmed');
  });

  it('does not record a collection result after backend ownership is lost', async () => {
    const item = await fixture();
    const controller = new AbortController();
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        signal: controller.signal,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => {
              controller.abort(new Error('backend lock lost'));
              return { targets: [], next: null };
            },
            delete: async () => {
              throw new Error('unexpected deletion');
            },
          },
        ],
      }),
    ).rejects.toThrow('backend lock lost');
    const journal = new StorageCleanupJournal(item.executor, 'sqlite', 'app');
    const page = await journal.listCollectors(item.job.id);
    expect(page.collectors.every((collector) => !collector.complete)).toBe(true);
    const execution = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
      item.backend.binding,
    );
    expect(execution?.status).toBe('unconfirmed');
  });

  it('keeps an object directory marker distinct from its non-slash key', async () => {
    const item = await fixture();
    const target = { ...item.target, key: 'episodes/one/' };
    const deleted: string[] = [];
    await runStorageCleanup({
      namespace: 'app',
      dialect: 'sqlite',
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx) => tx,
      ports: [
        {
          backendId: item.backend.id,
          binding: item.backend.binding,
          collect: async (collector) => ({
            targets: collector.verification === 0 ? [target] : [],
            next: null,
          }),
          delete: async (key) => {
            deleted.push(key);
          },
        },
      ],
    });
    expect(deleted).toEqual(['episodes/one/']);
    await expect(
      item.transaction((tx) =>
        new StorageTargetFence(tx, 'sqlite').admit({ binding: target.binding, key: 'episodes/one' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('cleans a target after all foreign write intents are settled as unreferenced', async () => {
    const item = await fixture();
    const writes = new StorageWriteJournal(item.executor, 'sqlite', 'app');
    for (const subjectId of ['profile:one', 'profile:two']) {
      const intent = prepareStorageWrite({ namespace: 'app', subjectId, generation: 1, target: item.target });
      await item.transaction(async () => {
        await writes.begin(intent, 1);
        await writes.finish(intent, { kind: 'unreferenced' });
      });
    }
    const deleted: string[] = [];
    await runStorageCleanup({
      namespace: 'app',
      dialect: 'sqlite',
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx) => tx,
      ports: [
        {
          backendId: item.backend.id,
          binding: item.backend.binding,
          collect: async (collector) => ({
            targets: collector.verification === 0 ? [item.target] : [],
            next: null,
          }),
          delete: async (key) => {
            deleted.push(key);
          },
        },
      ],
    });
    expect(deleted).toEqual([item.target.key]);
  });

  it('does not treat a stopped writer as proof that a remote write settled', async () => {
    const item = await fixture();
    const writes = new StorageWriteJournal(item.executor, 'sqlite', 'app');
    const intent = prepareStorageWrite({
      namespace: 'app',
      subjectId: 'profile:foreign',
      generation: 1,
      target: item.target,
    });
    await item.transaction(async () => {
      await writes.begin(intent, 1);
      await writes.finish(intent, { kind: 'uncertain' });
      await writes.resolveUncertain(intent, { kind: 'stopped_writer', id: 'process-stopped' });
    });
    const deleted: string[] = [];
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async (collector) => ({
              targets: collector.verification === 0 ? [item.target] : [],
              next: null,
            }),
            delete: async (key) => {
              deleted.push(key);
            },
          },
        ],
      }),
    ).rejects.toThrow('retained writes');
    expect(deleted).toEqual([]);
  });

  it('does not delete a target used by a learner in another namespace', async () => {
    const item = await fixture();
    const backend = prepareStorageBackend('other', item.backend.descriptor);
    const registry = new StorageReferenceRegistry(item.executor, 'sqlite', 'other');
    const reference = prepareStorageReference({
      namespace: 'other',
      operationId: randomUUID(),
      reference: item.target.key,
      target: { ...item.target, backendId: backend.id },
      scopes: [{ subjectId: 'profile:survivor', generation: 1 }],
    });
    await item.transaction(async (tx) => {
      await new StorageBackendRegistry(tx, 'sqlite', 'other').register(backend);
      await registry.replace({ consumer: 'survivor:audio', previousReference: null, next: reference });
    });
    const deleted: string[] = [];
    const port: StorageCleanupBackendPort = {
      backendId: item.backend.id,
      binding: item.backend.binding,
      collect: async (collector) => ({
        targets: collector.verification === 0 ? [item.target] : [],
        next: null,
      }),
      delete: async (key) => {
        deleted.push(key);
      },
    };
    const failure: unknown = await runStorageCleanup({
      namespace: 'app',
      dialect: 'sqlite',
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx) => tx,
      ports: [port],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(deleted).toEqual([]);
    expect(failure).toMatchObject({ message: expect.stringContaining('live consumers') });
    expect(
      await registry.resolve({ consumer: 'survivor:audio', reference: reference.reference }),
    ).toMatchObject({
      prepared: reference,
    });
    expect(
      await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(item.backend.binding),
    ).toMatchObject({ status: 'settled' });
    await item.transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'survivor:audio',
        previousReference: reference.reference,
      }),
    );
    await runStorageCleanup({
      namespace: 'app',
      dialect: 'sqlite',
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx) => tx,
      ports: [port],
    });
    expect(deleted).toEqual([item.target.key]);
  });

  it('drains, deletes, verifies, and completes an admitted cleanup', async () => {
    const item = await fixture();
    const deleted: string[] = [];
    const port: StorageCleanupBackendPort = {
      backendId: item.backend.id,
      binding: item.backend.binding,
      collect: async (collector) => ({
        targets: collector.verification === 0 ? [item.target] : [],
        next: null,
      }),
      delete: async (key) => {
        deleted.push(key);
      },
    };
    await runStorageCleanup({
      namespace: 'app',
      dialect: 'sqlite',
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx) => tx,
      ports: [port],
    });
    expect(deleted).toEqual(['episodes/one/audio.mp3']);
    expect(await new StorageCleanupJournal(item.executor, 'sqlite', 'app').get(item.job.id)).toMatchObject({
      phase: 'complete',
      pending: 0,
      deleted: 1,
      verification: 1,
    });
    const otherBackend = prepareStorageBackend('other', item.backend.descriptor);
    await item.transaction((tx) => new StorageBackendRegistry(tx, 'sqlite', 'other').register(otherBackend));
    const later = prepareStorageReference({
      namespace: 'other',
      operationId: randomUUID(),
      reference: item.target.key,
      target: { ...item.target, backendId: otherBackend.id },
      scopes: [{ subjectId: 'profile:later', generation: 1 }],
    });
    await expect(
      item.transaction((tx) =>
        new StorageReferenceRegistry(tx, 'sqlite', 'other').replace({
          consumer: 'later:audio',
          previousReference: null,
          next: later,
        }),
      ),
    ).rejects.toThrow('target is retired');
  });

  registerFailedDeleteCase(fixture);
});
