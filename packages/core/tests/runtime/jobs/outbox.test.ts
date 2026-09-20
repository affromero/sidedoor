import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JobOutbox,
  JobSnapshot,
  JobErasedError,
  JobExecutionJournal,
  prepareJob,
} from '../../../src/runtime/jobs/outbox';
import { randomUUID } from 'node:crypto';
import { StorageCleanupJournal, prepareStorageCleanup } from '../../../src/storage/index';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE Result (id TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  const outbox = new JobOutbox(executor, 'sqlite', 'app');
  async function transaction<Result>(run: () => Promise<Result>) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const value = await run();
      database.exec('COMMIT');
      return value;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const prepare = () =>
    prepareJob({
      namespace: 'app',
      handler: 'audio',
      version: 1,
      payload: { text: 'hello', episode: 'episode' },
      scopes: [{ subjectId: 'profile:owner', generation: 1 }],
      delivery: { attempts: 3, priority: 0, availableAt: 0 },
    });
  return { database, executor, outbox, transaction, prepare };
}

describe('durable job delivery and completion', () => {
  it('retains workspace recovery identity until verified removal and fences settlement', async () => {
    const { executor, outbox, transaction, prepare } = fixture();
    const journal = new JobExecutionJournal(executor, 'sqlite', 'app');
    const parent = await transaction(() => outbox.enqueue(prepare()));
    const execution = {
      id: randomUUID(),
      executorId: randomUUID(),
      parentId: parent.job.id,
      fingerprint: parent.fingerprint,
    };
    const plan = {
      locationId: randomUUID(),
      executionId: execution.id,
      root: { root: '/private/worker', device: '1', inode: '2', binding: 'root-binding' },
    };
    await transaction(() => journal.begin(execution, plan));
    await expect(transaction(() => journal.settle(execution))).rejects.toThrow(
      'workspace cleanup is unresolved',
    );
    expect((await journal.listUnresolved(parent.job.scopes[0]!)).executions[0]?.workspace).toEqual(plan);
    const workspace = {
      ...plan,
      directory: { ...plan.root, root: `/private/worker/execution-${execution.id}`, inode: '3' },
    };
    await expect(
      transaction(() => journal.attachWorkspace(execution, { ...workspace, locationId: randomUUID() })),
    ).rejects.toThrow('intent changed');
    await transaction(() => journal.attachWorkspace(execution, workspace));
    await transaction(() => journal.attachWorkspace(execution, workspace));
    await expect(
      transaction(() =>
        journal.attachWorkspace(execution, {
          ...workspace,
          directory: { ...workspace.directory, inode: '4' },
        }),
      ),
    ).rejects.toThrow('directory changed');
    await transaction(() => journal.markCleanupUnconfirmed(execution));
    await expect(transaction(() => journal.releaseWorkspace(execution, plan))).rejects.toThrow(
      'identity mismatch',
    );
    expect((await journal.read(execution)).workspace).toEqual(workspace);
    await transaction(() => journal.releaseWorkspace(execution, workspace));
    await transaction(() => journal.settle(execution));
    expect(await journal.read(execution)).not.toHaveProperty('workspace');
    expect((await journal.listUnresolved(parent.job.scopes[0]!)).executions).toEqual([]);
  });
  it('retains unresolved execution evidence across queue completion and rejects overlapping execution', async () => {
    const { executor, outbox, transaction, prepare } = fixture();
    const journal = new JobExecutionJournal(executor, 'sqlite', 'app');
    const parent = await transaction(() => outbox.enqueue(prepare()));
    const execution = {
      id: randomUUID(),
      executorId: randomUUID(),
      parentId: parent.job.id,
      fingerprint: parent.fingerprint,
    };
    await transaction(() => journal.begin(execution));
    await expect(transaction(() => journal.begin({ ...execution, id: randomUUID() }))).rejects.toThrow(
      'cleanup is unresolved',
    );
    await transaction(() => journal.markCleanupUnconfirmed(execution));
    await transaction(() => outbox.complete(parent.job.id, parent.fingerprint));
    const page = await journal.listUnresolved(parent.job.scopes[0]!);
    expect(page.executions).toMatchObject([{ ...execution, status: 'cleanup-unconfirmed' }]);
    await expect(
      transaction(() => outbox.erase(parent.job.id, parent.fingerprint, parent.job.scopes[0]!)),
    ).rejects.toThrow('cleanup is unresolved');
    await expect(
      transaction(() => journal.settle({ ...execution, executorId: randomUUID() })),
    ).rejects.toThrow('identity mismatch');
    await transaction(() => journal.settle(execution));
    await transaction(() => journal.settle(execution));
    expect((await journal.listUnresolved(parent.job.scopes[0]!)).executions).toEqual([]);
    expect((await journal.read(execution)).status).toBe('settled');
    await expect(transaction(() => journal.markCleanupUnconfirmed(execution))).rejects.toThrow('Settled');
  });

  it('rolls back execution admission and settlement with application transactions', async () => {
    const { executor, outbox, transaction, prepare } = fixture();
    const journal = new JobExecutionJournal(executor, 'sqlite', 'app');
    const parent = await transaction(() => outbox.enqueue(prepare()));
    const execution = {
      id: randomUUID(),
      executorId: randomUUID(),
      parentId: parent.job.id,
      fingerprint: parent.fingerprint,
    };
    await expect(
      transaction(async () => {
        await journal.begin(execution);
        throw new Error('Application admission failed');
      }),
    ).rejects.toThrow('Application admission failed');
    expect((await journal.listUnresolved(parent.job.scopes[0]!)).executions).toEqual([]);
    await transaction(() => journal.begin(execution));
    await expect(
      transaction(async () => {
        await journal.settle(execution);
        throw new Error('Application settlement failed');
      }),
    ).rejects.toThrow('Application settlement failed');
    expect((await journal.read(execution)).status).toBe('active');
    await expect(journal.requireParentDrained(parent.job.id, parent.fingerprint)).rejects.toThrow(
      'unresolved',
    );
    await transaction(() => journal.settle(execution));
    await expect(transaction(() => journal.begin(execution))).rejects.toThrow('already exists');
    const replacement = { ...execution, id: randomUUID() };
    await transaction(() => journal.begin(replacement));
    expect((await journal.listUnresolved(parent.job.scopes[0]!)).executions).toMatchObject([replacement]);
    await transaction(() => journal.settle(execution));
    await expect(journal.requireParentDrained(parent.job.id, parent.fingerprint)).rejects.toThrow(
      'unresolved',
    );
  });
  it('fences a job snapshot erased before its creation without accepting another binding', async () => {
    const { executor, transaction } = fixture();
    const snapshots = new JobSnapshot(executor, 'sqlite', 'app');
    const job = { id: randomUUID(), fingerprint: 'a'.repeat(64) };
    expect(await transaction(() => snapshots.eraseNext(job.id, job.fingerprint))).toEqual({ complete: true });
    await expect(transaction(() => snapshots.createForJob(job))).rejects.toThrow('already exists');
    await expect(transaction(() => snapshots.eraseNext(job.id, 'b'.repeat(64)))).rejects.toThrow(
      'binding mismatch',
    );
  });
  it.each([false, true])(
    'resumes bounded snapshot erasure with sealed=%s and blocks reuse',
    async (sealed) => {
      const { database, executor, transaction } = fixture();
      const snapshots = new JobSnapshot(executor, 'sqlite', 'app');
      const id = randomUUID();
      await transaction(async () => {
        await snapshots.create(id, 'parent');
        for (let page = 0; page < 12; page++)
          await snapshots.append(id, 'parent', page, [`private-device-${page}`]);
        if (sealed) await snapshots.seal(id, 'parent');
      });
      const pages = () =>
        Number(
          database
            .prepare(
              "SELECT count(*) AS count FROM SidedoorState WHERE json_extract(state, '$.kind') = 'snapshot_page'",
            )
            .get()!.count,
        );
      await expect(
        transaction(async () => {
          await snapshots.eraseNext(id, 'parent');
          throw new Error('Checkpoint failed');
        }),
      ).rejects.toThrow('Checkpoint failed');
      expect(pages()).toBe(12);
      expect(await transaction(() => snapshots.eraseNext(id, 'parent'))).toEqual({ complete: false });
      expect(pages()).toBe(2);
      await expect(snapshots.read(id, 'parent', 11)).rejects.toThrow('being erased');
      await expect(transaction(() => snapshots.append(id, 'parent', 12, ['new']))).rejects.toThrow(
        'being erased',
      );
      await expect(transaction(() => snapshots.seal(id, 'parent'))).rejects.toThrow('being erased');
      expect(await transaction(() => snapshots.eraseNext(id, 'parent'))).toEqual({ complete: true });
      expect(pages()).toBe(0);
      expect(JSON.stringify(database.prepare('SELECT state FROM SidedoorState').all())).not.toContain(
        'private-device',
      );
      expect(await transaction(() => snapshots.eraseNext(id, 'parent'))).toEqual({ complete: true });
      await expect(transaction(() => snapshots.eraseNext(id, 'wrong-parent'))).rejects.toThrow(
        'binding mismatch',
      );
      await expect(transaction(() => snapshots.create(id, 'parent'))).rejects.toThrow('already exists');
    },
  );

  it('erases an empty snapshot while retaining its identity', async () => {
    const { executor, transaction } = fixture();
    const snapshots = new JobSnapshot(executor, 'sqlite', 'app');
    const id = randomUUID();
    await transaction(() => snapshots.create(id, 'parent'));
    expect(await transaction(() => snapshots.eraseNext(id, 'parent'))).toEqual({ complete: true });
    await expect(snapshots.read(id, 'parent', 0)).rejects.toThrow('being erased');
  });
  it('erases private payloads while retaining distinct cancellation and replay identities', async () => {
    const { database, executor, outbox, transaction, prepare } = fixture();
    const original = prepare();
    original.payload = { text: 'private text to erase' };
    const record = await transaction(() => outbox.enqueue(original));
    const captured = { subjectId: 'profile:owner', generation: 1 };
    await expect(
      transaction(() => outbox.erase(record.job.id, record.fingerprint, captured)),
    ).rejects.toThrow('deletion admission');
    const cleanup = new StorageCleanupJournal(executor, 'sqlite', 'app');
    await transaction(() => cleanup.createJob(prepareStorageCleanup({ namespace: 'app', ...captured })));
    await expect(
      transaction(() => outbox.erase(record.job.id, record.fingerprint, captured)),
    ).rejects.toThrow('completed work');
    await transaction(async () => {
      await outbox.complete(record.job.id, record.fingerprint);
      await outbox.erase(record.job.id, record.fingerprint, captured);
    });
    expect(JSON.stringify(database.prepare('SELECT state FROM SidedoorState').all())).not.toContain(
      'private text to erase',
    );
    expect(await outbox.receipt(record.job.id)).toEqual({
      status: 'erased',
      id: record.job.id,
      handler: record.job.handler,
      version: record.job.version,
      fingerprint: record.fingerprint,
    });
    const parentContract = {
      fingerprint: record.fingerprint,
      handler: record.job.handler,
      version: record.job.version,
      scopes: record.job.scopes,
    };
    expect(await outbox.readParent(record.job.id, parentContract)).toEqual({ status: 'erased' });
    for (const mismatch of [
      { fingerprint: '0'.repeat(64) },
      { handler: 'wrong' },
      { version: 2 },
      { scopes: [{ subjectId: 'profile:other', generation: 1 }] },
    ])
      await expect(outbox.readParent(record.job.id, { ...parentContract, ...mismatch })).rejects.toThrow(
        'does not match',
      );
    await expect(outbox.read(record.job.id)).rejects.toBeInstanceOf(JobErasedError);
    await expect(transaction(() => outbox.enqueue(original))).rejects.toBeInstanceOf(JobErasedError);
    await transaction(() => outbox.erase(record.job.id, record.fingerprint, captured));
    expect((await outbox.listForScope(captured.subjectId, captured.generation)).jobs).toHaveLength(1);
    expect((await outbox.listIncomplete()).jobs).toEqual([]);
    await transaction(() => outbox.backfillScopeIndex());
  });
  it('backfills old completed work in bounded restartable transactions', async () => {
    const { database, outbox, transaction, prepare } = fixture();
    const records = [];
    for (let index = 0; index < 12; index++) {
      const record = await transaction(() => outbox.enqueue(prepare()));
      await transaction(() => outbox.complete(record.job.id, record.fingerprint));
      records.push(record);
    }
    database.exec("DELETE FROM SidedoorState WHERE id GLOB 'sd-jsc:1:*'");
    expect((await outbox.listForScope('profile:owner', 1)).jobs).toEqual([]);
    await expect(
      transaction(async () => {
        await outbox.backfillScopeIndex();
        throw new Error('Migration checkpoint failed');
      }),
    ).rejects.toThrow('Migration checkpoint failed');
    expect((await outbox.listForScope('profile:owner', 1)).jobs).toEqual([]);
    const first = await transaction(() => outbox.backfillScopeIndex());
    expect(first.indexed).toBe(10);
    expect(first.cursor).not.toBeNull();
    expect(await transaction(() => outbox.backfillScopeIndex())).toEqual(first);
    expect(await transaction(() => outbox.backfillScopeIndex(first.cursor))).toEqual({
      indexed: 2,
      cursor: null,
    });
    const indexed = await outbox.listForScope('profile:owner', 1);
    const tail = await outbox.listForScope('profile:owner', 1, indexed.cursor);
    expect([...indexed.jobs, ...tail.jobs].map((job) => job.id)).toEqual(
      records.map((record) => record.job.id).sort(),
    );
    for (const record of records)
      expect(await outbox.read(record.job.id)).toEqual({ ...record, complete: true });
  });
  it('rejects fresh work after erasure admission while preserving an existing immutable receipt', async () => {
    const { outbox, executor, transaction, prepare } = fixture();
    const original = prepare();
    const record = await transaction(() => outbox.enqueue(original));
    const cleanup = new StorageCleanupJournal(executor, 'sqlite', 'app');
    await transaction(() =>
      cleanup.createJob(
        prepareStorageCleanup({
          namespace: 'app',
          subjectId: 'profile:owner',
          generation: 1,
        }),
      ),
    );
    await expect(transaction(() => outbox.enqueue(prepare()))).rejects.toThrow('being erased');
    expect(await transaction(() => outbox.enqueue(original))).toEqual(record);
    expect((await outbox.listForScope('profile:owner', 1)).jobs).toHaveLength(1);
  });
  it('retains completed jobs in their exact captured scope for payload erasure', async () => {
    const { outbox, transaction, prepare } = fixture();
    const record = await transaction(() => outbox.enqueue(prepare()));
    await transaction(() => outbox.complete(record.job.id, record.fingerprint));
    expect((await outbox.listIncomplete()).jobs).toEqual([]);
    expect((await outbox.listForScope('profile:owner', 1)).jobs).toEqual([
      { id: record.job.id, fingerprint: record.fingerprint },
    ]);
    expect((await outbox.listForScope('profile:owner', 2)).jobs).toEqual([]);
    expect((await outbox.listForScope('profile:other', 1)).jobs).toEqual([]);
  });

  it('pages retained scope work without duplicates or crossing the page bound', async () => {
    const { outbox, transaction, prepare } = fixture();
    const expected: string[] = [];
    await transaction(async () => {
      for (let index = 0; index < 105; index++) {
        const record = await outbox.enqueue(prepare());
        expected.push(record.job.id);
      }
    });
    let cursor: string | null = null;
    const found: string[] = [];
    do {
      const page = await outbox.listForScope('profile:owner', 1, cursor);
      expect(page.jobs.length).toBeLessThanOrEqual(10);
      found.push(...page.jobs.map((job) => job.id));
      cursor = page.cursor;
    } while (cursor !== null);
    expect(found).toEqual(expected.sort());
  });
  it('rejects an oversized stored snapshot page before returning its items', async () => {
    const { database, executor, transaction } = fixture();
    const snapshot = new JobSnapshot(executor, 'sqlite', 'app');
    const id = randomUUID();
    await transaction(async () => {
      await snapshot.create(id, 'notification');
      await snapshot.append(id, 'notification', 0, ['valid']);
      await snapshot.seal(id, 'notification');
    });
    database
      .prepare("UPDATE SidedoorState SET state = ? WHERE json_extract(state, '$.kind') = 'snapshot_page'")
      .run(
        JSON.stringify({
          kind: 'snapshot_page',
          binding: 'notification',
          index: 0,
          items: ['x'.repeat(1_048_576)],
        }),
      );
    await expect(snapshot.read(id, 'notification', 0)).rejects.toThrow('exceeds one MiB');
  });
  it('exposes only sealed immutable snapshot pages with matching bindings', async () => {
    const { executor, transaction } = fixture();
    const snapshot = new JobSnapshot(executor, 'sqlite', 'app');
    const id = randomUUID();
    await transaction(async () => {
      await snapshot.create(id, 'notification');
      await snapshot.append(id, 'notification', 0, [{ id: 'first', version: 'captured' }]);
    });
    await expect(snapshot.read(id, 'notification', 0)).rejects.toThrow('not sealed');
    await transaction(async () => {
      await snapshot.append(id, 'notification', 1, [{ id: 'second', version: 'captured' }]);
      expect(await snapshot.seal(id, 'notification')).toBe(2);
    });
    expect(await snapshot.read(id, 'notification', 0)).toEqual({
      items: [{ id: 'first', version: 'captured' }],
      pages: 2,
      next: 1,
    });
    expect(await snapshot.read(id, 'notification', 1)).toEqual({
      items: [{ id: 'second', version: 'captured' }],
      pages: 2,
      next: null,
    });
    await expect(snapshot.read(id, 'other', 0)).rejects.toThrow('binding mismatch');
    await expect(transaction(() => snapshot.append(id, 'notification', 2, ['third']))).rejects.toThrow(
      'not the next',
    );
  });

  it('rolls back a partial snapshot and permits a fresh atomic retry', async () => {
    const { executor, transaction } = fixture();
    const snapshot = new JobSnapshot(executor, 'sqlite', 'app');
    const id = randomUUID();
    await expect(
      transaction(async () => {
        await snapshot.create(id, 'notification');
        await snapshot.append(id, 'notification', 0, ['first']);
        throw new Error('Application write failed');
      }),
    ).rejects.toThrow('Application write failed');
    await expect(snapshot.read(id, 'notification', 0)).rejects.toThrow('missing');
    await transaction(async () => {
      await snapshot.create(id, 'notification');
      await snapshot.append(id, 'notification', 0, ['replacement']);
      await snapshot.seal(id, 'notification');
    });
    expect((await snapshot.read(id, 'notification', 0)).items).toEqual(['replacement']);
  });

  it('rejects oversized or out-of-order snapshot pages without changing the snapshot', async () => {
    const { executor, transaction } = fixture();
    const snapshot = new JobSnapshot(executor, 'sqlite', 'app');
    const id = randomUUID();
    await transaction(() => snapshot.create(id, 'notification'));
    for (const items of [Array.from({ length: 101 }, () => 'item'), ['x'.repeat(1_048_576)]])
      await expect(transaction(() => snapshot.append(id, 'notification', 0, items))).rejects.toThrow();
    await expect(transaction(() => snapshot.append(id, 'notification', 1, ['item']))).rejects.toThrow(
      'not the next',
    );
    await transaction(async () => {
      await snapshot.append(id, 'notification', 0, ['valid']);
      expect(await snapshot.seal(id, 'notification')).toBe(1);
    });
  });
  it('rolls back application changes and pending work together', async () => {
    const { database, outbox, transaction, prepare } = fixture();
    const job = prepare();
    await expect(
      transaction(async () => {
        database.prepare('INSERT INTO Result VALUES (?, ?)').run('attempt', 1);
        await outbox.enqueue(job);
        throw new Error('Application update rejected');
      }),
    ).rejects.toThrow('Application update rejected');
    expect(database.prepare('SELECT * FROM Result').all()).toEqual([]);
    expect(await outbox.read(job.id)).toBeNull();
    expect((await outbox.listPending()).jobs).toEqual([]);
  });
  it('accepts identical retries after JSON key reordering but rejects conflicting work', async () => {
    const { outbox, transaction, prepare } = fixture();
    const job = prepare();
    const first = await transaction(() => outbox.enqueue(job));
    const again = await transaction(() =>
      outbox.enqueue({ ...job, payload: { episode: 'episode', text: 'hello' } }),
    );
    expect(again).toEqual(first);
    await expect(
      transaction(() => outbox.enqueue({ ...job, payload: { text: 'different' } })),
    ).rejects.toThrow('different work');
    expect((await outbox.listPending()).jobs).toEqual([{ id: job.id, fingerprint: first.fingerprint }]);
  });
  it('resumes undelivered work after partial queue acceptance with bounded payload-free pages', async () => {
    const { outbox, transaction, prepare } = fixture();
    const records = [];
    for (let index = 0; index < 101; index++)
      records.push(await transaction(() => outbox.enqueue(prepare())));
    const first = await outbox.listPending();
    expect(first.jobs).toHaveLength(100);
    const last = await outbox.listPending(first.cursor);
    expect(last.jobs).toHaveLength(1);
    expect(last.cursor).toBeNull();
    expect([...first.jobs, ...last.jobs].map((job) => job.id).sort()).toEqual(
      records.map((record) => record.job.id).sort(),
    );
    for (const record of records.slice(0, 50))
      await transaction(() => outbox.acknowledgeDelivery(record.job.id, record.fingerprint));
    expect((await outbox.listPending()).jobs.map((job) => job.id).sort()).toEqual(
      records
        .slice(50)
        .map((record) => record.job.id)
        .sort(),
    );
    expect((await outbox.read(records[0]!.job.id))?.complete).toBe(false);
    await expect(outbox.listPending('invalid')).rejects.toThrow();
  });
  it('commits an application result once even after queue retention and repeated delivery', async () => {
    const { database, outbox, transaction, prepare } = fixture();
    const record = await transaction(() => outbox.enqueue(prepare()));
    const apply = () =>
      transaction(async () => {
        if (!(await outbox.complete(record.job.id, record.fingerprint))) return;
        database.prepare('INSERT INTO Result VALUES (?, ?)').run(record.job.id, 1);
      });
    await apply();
    await transaction(() => outbox.acknowledgeDelivery(record.job.id, record.fingerprint));
    await apply();
    expect(database.prepare('SELECT * FROM Result').all()).toEqual([{ id: record.job.id, value: 1 }]);
    expect(await transaction(() => outbox.enqueue(record.job))).toMatchObject({
      complete: true,
      delivered: true,
    });
    expect((await outbox.listPending()).jobs).toEqual([]);
    expect((await outbox.listIncomplete()).jobs).toEqual([]);
  });
  it('keeps accepted work discoverable until completion if the queue loses its data', async () => {
    const { outbox, transaction, prepare } = fixture();
    const record = await transaction(() => outbox.enqueue(prepare()));
    await transaction(() => outbox.acknowledgeDelivery(record.job.id, record.fingerprint));
    expect((await outbox.listPending()).jobs).toEqual([]);
    expect((await outbox.listIncomplete()).jobs).toEqual([
      { id: record.job.id, fingerprint: record.fingerprint },
    ]);
    expect(await outbox.read(record.job.id)).toMatchObject({
      job: record.job,
      delivered: true,
      complete: false,
    });
    await transaction(() => outbox.complete(record.job.id, record.fingerprint));
    expect((await outbox.listIncomplete()).jobs).toEqual([]);
  });
  it('rolls back a completion receipt when the final application update fails', async () => {
    const { outbox, transaction, prepare } = fixture();
    const record = await transaction(() => outbox.enqueue(prepare()));
    await expect(
      transaction(async () => {
        await outbox.complete(record.job.id, record.fingerprint);
        throw new Error('Final commit failed');
      }),
    ).rejects.toThrow('Final commit failed');
    expect(await outbox.read(record.job.id)).toMatchObject({ complete: false });
    expect((await outbox.listPending()).jobs).toHaveLength(1);
    await expect(transaction(() => outbox.complete(record.job.id, 'wrong'))).rejects.toThrow(
      'identity mismatch',
    );
  });
  it('isolates namespaces and rejects oversized work and duplicate resource scopes', async () => {
    const { outbox, executor, transaction, prepare } = fixture();
    const record = await transaction(() => outbox.enqueue(prepare()));
    const other = new JobOutbox(executor, 'sqlite', 'other');
    expect(await other.read(record.job.id)).toBeNull();
    expect((await other.listPending()).jobs).toEqual([]);
    await expect(transaction(() => other.enqueue(record.job))).rejects.toThrow('namespace');
    expect(() => prepareJob({ ...record.job, payload: 'é'.repeat(524288) })).toThrow('MiB');
    expect(() =>
      prepareJob({ ...record.job, scopes: [record.job.scopes[0]!, record.job.scopes[0]!] }),
    ).toThrow('distinct');
  });
});
