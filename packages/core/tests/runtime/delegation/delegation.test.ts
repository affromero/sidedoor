import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DelegationConflictError,
  DelegationDeniedError,
  DelegationStore,
  type DelegationAttemptInput,
  type DelegationGrant,
  type DelegationStoreOptions,
} from '../../../src/runtime/delegation/index';
import { sqlStateBackend } from '../../../src/storage/sql/sql';
import type { AtomicStateBackend } from '../../../src/storage/sql/optimistic';

describe('durable delegation', () => {
  let database: DatabaseSync;
  let now: number;
  let authorized: boolean;
  let grant: DelegationGrant;
  let store: DelegationStore;
  let backend: AtomicStateBackend;
  const request = (): DelegationAttemptInput => ({ id: randomUUID(), fingerprint: 'a'.repeat(64) });

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
    );
    now = 1000;
    authorized = true;
    grant = {
      id: randomUUID(),
      revision: randomUUID(),
      instanceId: randomUUID(),
      subject: { id: 'learner:one', generation: 3 },
      resource: { id: 'course:one', generation: 4 },
      operationId: randomUUID(),
      action: 'prepare-class',
      expiresAt: 2000,
      maxRequests: 2,
    };
    backend = sqlStateBackend(
      { query: async (sql, values) => database.prepare(sql).all(...(values as SQLInputValue[])) },
      'sqlite',
      `delegation:${grant.id}`,
    );
    store = build();
  });
  afterEach(() => database.close());

  function build(overrides: Partial<DelegationStoreOptions> = {}) {
    return new DelegationStore({
      backend,
      authorize: async () => {
        if (!authorized) throw new Error('Current application authority denied');
      },
      now: () => now,
      ...overrides,
    });
  }

  function loseCommitResponse() {
    return build({
      backend: {
        read: () => backend.read(),
        async compareAndSwap(previous, next) {
          const saved = await backend.compareAndSwap(previous, next);
          if (saved) throw new Error('Commit response lost');
          return saved;
        },
      },
    });
  }

  it('retains the exact immutable grant after application restart and input mutation', async () => {
    const captured = structuredClone(grant);
    const created = await store.create(grant);
    grant.subject.generation += 1;
    created.grant.resource.generation += 1;
    const restarted = build();
    expect((await restarted.read(created.binding)).grant).toEqual(captured);
    expect((await restarted.create(captured)).binding).toEqual(created.binding);
    await expect(restarted.create(grant)).rejects.toMatchObject({ code: 'binding' });
  });

  it.each([
    'revision',
    'instanceId',
    'subject',
    'resource',
    'operationId',
    'action',
    'expiresAt',
    'maxRequests',
  ] as const)('rejects replacing the admitted %s', async (field) => {
    await store.create(grant);
    const changed = { ...grant };
    if (field === 'subject' || field === 'resource') changed[field] = { ...grant[field], generation: 9 };
    else if (field === 'expiresAt' || field === 'maxRequests') changed[field] += 1;
    else if (field === 'action') changed.action = 'send-message';
    else changed[field] = randomUUID();
    await expect(store.create(changed)).rejects.toMatchObject({ code: 'binding' });
  });

  it('checks live application authority for reads, dispatch, cancellation and settlement', async () => {
    const { binding } = await store.create(grant);
    const attempt = request();
    await store.admit(binding, attempt);
    authorized = false;
    await expect(store.read(binding)).rejects.toThrow('authority');
    await expect(store.validate(binding)).rejects.toThrow('authority');
    await expect(store.admit(binding, request())).rejects.toThrow('authority');
    await expect(store.settle(binding, attempt, 'succeeded')).rejects.toThrow('authority');
    await expect(store.revoke(binding)).rejects.toThrow('authority');
    await expect(store.complete(binding)).rejects.toThrow('authority');
    await expect(store.activity(binding)).rejects.toThrow('authority');
    await expect(store.create(grant)).rejects.toThrow('authority');
    authorized = true;
    expect((await store.read(binding)).attempts).toHaveLength(1);
  });

  it('gives authorization the captured scope without allowing callback mutation to widen it', async () => {
    let generation = 4;
    const guarded = build({
      authorize: async ({ grant: captured }) => {
        if (captured.resource.generation !== generation) throw new Error('Resource generation changed');
        captured.maxRequests = 1000;
      },
    });
    const { binding } = await guarded.create(grant);
    await guarded.admit(binding, request());
    await guarded.admit(binding, request());
    await expect(guarded.admit(binding, request())).rejects.toMatchObject({ code: 'budget' });
    generation += 1;
    await expect(guarded.validate(binding)).rejects.toThrow('generation');
  });

  it('charges failed and unknown attempts and never releases their request budget', async () => {
    const { binding } = await store.create(grant);
    const first = request();
    const second = request();
    expect((await store.admit(binding, first)).dispatch).toBe(true);
    await store.settle(binding, first, 'failed');
    await store.admit(binding, second);
    await store.settle(binding, second, 'unknown');
    await expect(store.admit(binding, request())).rejects.toMatchObject({ code: 'budget' });
    expect((await store.read(binding)).attempts.map((attempt) => attempt.outcome)).toEqual([
      'failed',
      'unknown',
    ]);
  });

  it('returns a non-dispatchable replay after an admission commit response is lost', async () => {
    const { binding } = await store.create(grant);
    const attempt = request();
    const uncertain = loseCommitResponse();
    await expect(uncertain.admit(binding, attempt)).rejects.toThrow('response lost');
    const replay = await build().admit(binding, attempt);
    expect(replay).toMatchObject({ dispatch: false, attempt: { number: 1, outcome: 'admitted' } });
    await expect(store.admit(binding, { ...attempt, fingerprint: 'b'.repeat(64) })).rejects.toMatchObject({
      code: 'attempt',
    });
    expect((await store.read(binding)).attempts).toHaveLength(1);
  });

  it('keeps revocation durable after a lost response and does not reactivate on create replay', async () => {
    const { binding } = await store.create(grant);
    const attempt = request();
    await store.admit(binding, attempt);
    await expect(loseCommitResponse().revoke(binding)).rejects.toThrow('response lost');
    expect((await build().create(grant)).status).toBe('revoked');
    expect((await build().revoke(binding)).status).toBe('revoked');
    await expect(store.admit(binding, request())).rejects.toMatchObject({ code: 'closed' });
    await expect(store.validate(binding)).rejects.toMatchObject({ code: 'closed' });
    expect((await store.admit(binding, attempt)).dispatch).toBe(false);
    expect((await store.settle(binding, attempt, 'succeeded')).outcome).toBe('succeeded');
    expect((await store.read(binding)).status).toBe('revoked');
  });

  it('recovers exact creation and settlement after their commit responses are lost', async () => {
    await expect(loseCommitResponse().create(grant)).rejects.toThrow('response lost');
    const { binding } = await store.create(grant);
    const attempt = request();
    await store.admit(binding, attempt);
    await expect(loseCommitResponse().settle(binding, attempt, 'succeeded')).rejects.toThrow('response lost');
    const settled = await build().settle(binding, attempt, 'succeeded');
    expect(settled.outcome).toBe('succeeded');
    expect((await store.activity(binding)).events.map((event) => event.type)).toEqual([
      'created',
      'admitted',
      'succeeded',
    ]);
  });

  it('rejects admission when revocation wins while authority is being checked', async () => {
    const { binding } = await store.create(grant);
    const racing = build({
      authorize: async ({ operation }) => {
        if (operation === 'admit') await store.revoke(binding);
      },
    });
    await expect(racing.admit(binding, request())).rejects.toBeInstanceOf(DelegationConflictError);
    await expect(store.admit(binding, request())).rejects.toMatchObject({ code: 'closed' });
    expect((await store.read(binding)).attempts).toEqual([]);
  });

  it('requires the current reader to own the captured recipient even with a valid binding', async () => {
    const { binding } = await store.create(grant);
    const otherLearner = build({
      authorize: async ({ grant: captured }) => {
        if (captured.subject.id !== 'learner:other') throw new Error('Recipient mismatch');
      },
    });
    await expect(otherLearner.read(binding)).rejects.toThrow('Recipient');
    await expect(otherLearner.activity(binding)).rejects.toThrow('Recipient');
    await expect(otherLearner.admit(binding, request())).rejects.toThrow('Recipient');
  });

  it('rejects invalid or expired grants without storing authority', async () => {
    await expect(store.create({ ...grant, expiresAt: now })).rejects.toMatchObject({ code: 'expired' });
    await expect(store.create({ ...grant, maxRequests: 0 })).rejects.toThrow();
    await expect(store.create({ ...grant, maxRequests: 1001 })).rejects.toThrow();
    await expect(
      store.create({ ...grant, resource: { ...grant.resource, generation: -1 } }),
    ).rejects.toThrow();
    expect(await backend.read()).toBeNull();
  });

  it('expires precisely at the deadline but permits observing already admitted effects', async () => {
    const { binding } = await store.create(grant);
    const attempt = request();
    await store.admit(binding, attempt);
    now = grant.expiresAt;
    await expect(store.validate(binding)).rejects.toMatchObject({ code: 'expired' });
    await expect(store.admit(binding, request())).rejects.toMatchObject({ code: 'expired' });
    expect((await store.admit(binding, attempt)).dispatch).toBe(false);
    await store.settle(binding, attempt, 'succeeded');
    expect((await store.complete(binding)).status).toBe('completed');
  });

  it('checks expiry after waiting for application authorization', async () => {
    const { binding } = await store.create(grant);
    const delayed = build({
      authorize: async () => {
        now = grant.expiresAt;
      },
    });
    await expect(delayed.admit(binding, request())).rejects.toMatchObject({ code: 'expired' });
    expect((await store.read(binding)).attempts).toEqual([]);
  });

  it('settles an exact attempt once and rejects changing its observation or request', async () => {
    const { binding } = await store.create(grant);
    const attempt = request();
    await store.admit(binding, attempt);
    const result = await store.settle(binding, attempt, 'succeeded');
    now += 50;
    expect(await build().settle(binding, attempt, 'succeeded')).toEqual(result);
    await expect(store.settle(binding, attempt, 'failed')).rejects.toMatchObject({ code: 'attempt' });
    await expect(
      store.settle(binding, { ...attempt, fingerprint: 'b'.repeat(64) }, 'succeeded'),
    ).rejects.toMatchObject({ code: 'attempt' });
    await expect(store.settle(binding, request(), 'succeeded')).rejects.toMatchObject({ code: 'attempt' });
  });

  it('does not mark unresolved provider outcomes complete', async () => {
    const { binding } = await store.create(grant);
    const attempt = request();
    await store.admit(binding, attempt);
    await expect(store.complete(binding)).rejects.toMatchObject({ code: 'unsettled' });
    await store.settle(binding, attempt, 'unknown');
    await expect(store.complete(binding)).rejects.toMatchObject({ code: 'unsettled' });
    expect((await store.revoke(binding)).status).toBe('revoked');
  });

  it('completes known effects idempotently and prevents further requests', async () => {
    const { binding } = await store.create(grant);
    const attempt = request();
    await store.admit(binding, attempt);
    await store.settle(binding, attempt, 'succeeded');
    await store.complete(binding);
    expect((await store.complete(binding)).status).toBe('completed');
    expect((await store.revoke(binding)).status).toBe('revoked');
    await expect(store.admit(binding, request())).rejects.toMatchObject({ code: 'closed' });
  });

  it('keeps activity bounded, signals a cursor gap, and excludes request fingerprints and free text', async () => {
    grant.maxRequests = 70;
    const { binding } = await store.create(grant);
    for (let index = 0; index < 70; index++) {
      const attempt = request();
      await store.admit(binding, attempt);
      await store.settle(binding, attempt, 'succeeded');
    }
    const first = await store.activity(binding, { limit: 50 });
    expect(first.truncated).toBe(true);
    expect(first.events).toHaveLength(50);
    const second = await store.activity(binding, { after: first.next, limit: 100 });
    expect(second.truncated).toBe(false);
    expect(second.next).toBe(second.latest);
    expect([...first.events, ...second.events]).toHaveLength(128);
    expect(JSON.stringify(first)).not.toContain('a'.repeat(64));
    expect(first.events[0]).toEqual({
      sequence: expect.any(Number),
      at: now,
      type: expect.any(String),
      attemptId: expect.any(String),
    });
    expect((await store.activity(binding, { after: second.next })).events).toEqual([]);
    await expect(store.activity(binding, { after: second.next + 1 })).rejects.toMatchObject({
      code: 'binding',
    });
    await expect(store.activity(binding, { limit: 101 })).rejects.toThrow();
  });

  it('rejects unknown data fields rather than storing private request bodies or errors', async () => {
    await expect(store.create({ ...grant, prompt: 'private prompt' } as DelegationGrant)).rejects.toThrow();
    const { binding } = await store.create(grant);
    await expect(
      store.admit(binding, { ...request(), body: 'secret' } as DelegationAttemptInput),
    ).rejects.toThrow();
    expect(JSON.stringify(await store.read(binding))).not.toContain('private prompt');
    expect((await store.read(binding)).attempts).toEqual([]);
  });

  it('rejects another grant identity and missing rows before admitting a request', async () => {
    const { binding } = await store.create(grant);
    await expect(store.admit({ ...binding, id: randomUUID() }, request())).rejects.toMatchObject({
      code: 'binding',
    });
    await expect(store.admit({ ...binding, revision: randomUUID() }, request())).rejects.toMatchObject({
      code: 'binding',
    });
    await expect(store.admit({ ...binding, fingerprint: 'b'.repeat(64) }, request())).rejects.toMatchObject({
      code: 'binding',
    });
    database.exec('DELETE FROM SidedoorState');
    await expect(store.read(binding)).rejects.toMatchObject({ code: 'missing' });
  });

  it('rolls grant admission back with the application claim in a caller-owned transaction', async () => {
    database.exec('CREATE TABLE Claim (id TEXT PRIMARY KEY)');
    database.exec('BEGIN IMMEDIATE');
    try {
      await store.create(grant);
      database.prepare('INSERT INTO Claim VALUES (?)').run(grant.operationId);
      throw new Error('Application precondition failed');
    } catch {
      database.exec('ROLLBACK');
    }
    expect(await backend.read()).toBeNull();
    expect(database.prepare('SELECT * FROM Claim').all()).toEqual([]);
    database.exec('BEGIN IMMEDIATE');
    const created = await store.create(grant);
    database.prepare('INSERT INTO Claim VALUES (?)').run(grant.operationId);
    database.exec('COMMIT');
    expect((await store.read(created.binding)).status).toBe('active');
    expect(database.prepare('SELECT * FROM Claim').all()).toEqual([{ id: grant.operationId }]);
  });

  it('allows only one contender to consume the final slot', async () => {
    const concurrent = build();
    grant.maxRequests = 1;
    const { binding } = await concurrent.create(grant);
    const results = await Promise.allSettled([
      concurrent.admit(binding, request()),
      concurrent.admit(binding, request()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(DelegationConflictError) });
    await expect(concurrent.admit(binding, request())).rejects.toBeInstanceOf(DelegationDeniedError);
    expect((await concurrent.read(binding)).attempts).toHaveLength(1);
  });
});
