import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { JobOutbox, prepareJob, reconcileOutboxPage } from '../src/runtime/outbox';
import { runTaskLoop } from '../src/runtime/task-loop';
import { randomUUID } from 'node:crypto';

const databases: DatabaseSync[] = [];

it('retains immutable identity when a delivery adapter tries to change it', async () => {
  const { outbox, signal } = await fixture(1);
  const original = (await outbox.listIncomplete()).jobs[0]!;
  const result = await reconcileOutboxPage({
    cursor: null,
    signal,
    listIncomplete: (cursor) => outbox.listIncomplete(cursor),
    deliver: async (reference) => {
      reference.id = randomUUID();
      return 'delivered';
    },
  });
  expect(result.results).toEqual([expect.objectContaining({ ...original, status: 'failed' })]);
  expect((await outbox.listIncomplete()).jobs).toEqual([original]);
});

it.each(['repeated', 'reversed'] as const)('rejects a %s page before queue delivery', async (mode) => {
  const { outbox, signal } = await fixture(2);
  const page = await outbox.listIncomplete();
  const accepted: string[] = [];
  await expect(
    reconcileOutboxPage({
      cursor: mode === 'repeated' ? page.jobs[0]!.id : null,
      signal,
      listIncomplete: async () => ({
        jobs: mode === 'reversed' ? [...page.jobs].reverse() : page.jobs,
        cursor: null,
      }),
      deliver: async (reference) => {
        accepted.push(reference.id);
        return 'delivered';
      },
    }),
  ).rejects.toThrow('identity order');
  expect(accepted).toEqual([]);
});
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture(count: number) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const outbox = new JobOutbox(
    { query: async (sql, values) => database.prepare(sql).all(...(values as SQLInputValue[])) },
    'sqlite',
    'test',
  );
  for (let index = 0; index < count; index++)
    await outbox.enqueue(
      prepareJob({
        namespace: 'test',
        handler: 'audio',
        version: 1,
        payload: { index },
        scopes: [{ subjectId: 'owner', generation: 1 }],
        delivery: { attempts: 3, priority: 0, availableAt: 0 },
      }),
    );
  return { outbox, signal: new AbortController().signal };
}

it('continues past a failed delivery and revisits it after wrapping the identity pages', async () => {
  const { outbox, signal } = await fixture(101);
  const failedId = (await outbox.listIncomplete()).jobs[0]!.id;
  const accepted = new Set<string>();
  const deliver = async (reference: { id: string; fingerprint: string }) => {
    if (reference.id === failedId) throw new Error('Unsupported handler version');
    accepted.add(reference.id);
    await outbox.acknowledgeDelivery(reference.id, reference.fingerprint);
    return 'delivered' as const;
  };
  const listIncomplete = (cursor: string | null) => outbox.listIncomplete(cursor);
  const first = await reconcileOutboxPage({ cursor: null, signal, listIncomplete, deliver });
  expect(first.results.filter((result) => result.status === 'failed')).toEqual([
    expect.objectContaining({ id: failedId }),
  ]);
  expect(accepted.size).toBe(99);
  const last = await reconcileOutboxPage({ cursor: first.cursor, signal, listIncomplete, deliver });
  expect(last.cursor).toBeNull();
  expect(accepted.size).toBe(100);
  expect((await outbox.listPending()).jobs.map((job) => job.id)).toEqual([failedId]);
  const wrapped = await reconcileOutboxPage({ cursor: last.cursor, signal, listIncomplete, deliver });
  expect(wrapped.results[0]).toMatchObject({ id: failedId, status: 'failed' });
});

it('observes completion after listing without delivering stale work', async () => {
  const { outbox, signal } = await fixture(1);
  const result = await reconcileOutboxPage({
    cursor: null,
    signal,
    listIncomplete: async (cursor) => {
      const page = await outbox.listIncomplete(cursor);
      await outbox.complete(page.jobs[0]!.id, page.jobs[0]!.fingerprint);
      return page;
    },
    deliver: async (reference) => {
      const receipt = await outbox.receipt(reference.id);
      if (receipt?.status !== 'complete') throw new Error('Completion lost');
      return 'complete';
    },
  });
  expect(result.results[0]?.status).toBe('complete');
  expect((await outbox.listIncomplete()).jobs).toEqual([]);
});

it('awaits an active delivery on shutdown and resumes at the next identity', async () => {
  const { outbox } = await fixture(2);
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: string[] = [];
  let cursor: string | null = null;
  const loop = runTaskLoop({
    intervalMs: 1,
    signal: controller.signal,
    task: async (signal) => {
      const result = await reconcileOutboxPage({
        cursor,
        signal,
        listIncomplete: (after) => outbox.listIncomplete(after),
        deliver: async (reference) => {
          started();
          await pending;
          delivered.push(reference.id);
          return 'delivered';
        },
      });
      cursor = result.cursor;
    },
    onError: (error) => {
      throw error;
    },
  });
  await active;
  controller.abort();
  expect(delivered).toEqual([]);
  release();
  await loop;
  expect(delivered).toHaveLength(1);
  expect(cursor).toBe(delivered[0]);
  const resumed = await reconcileOutboxPage({
    cursor,
    signal: new AbortController().signal,
    listIncomplete: (after) => outbox.listIncomplete(after),
    deliver: async () => 'delivered',
  });
  expect(resumed.results).toHaveLength(1);
  expect(resumed.results[0]!.id).not.toBe(delivered[0]);
});

it('propagates listing failure without starting any queue delivery', async () => {
  const signal = new AbortController().signal;
  const accepted: string[] = [];
  await expect(
    reconcileOutboxPage({
      cursor: null,
      signal,
      listIncomplete: async () => {
        throw new Error('Database unavailable');
      },
      deliver: async (reference) => {
        accepted.push(reference.id);
        return 'delivered';
      },
    }),
  ).rejects.toThrow('Database unavailable');
  expect(accepted).toEqual([]);
});
