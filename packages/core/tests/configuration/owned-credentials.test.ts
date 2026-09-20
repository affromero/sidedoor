import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { OwnedCredentials, OwnedCredentialConflictError } from '../../src/configuration/owned-credentials';
import type { CredentialValidation } from '../../src/ai/browser';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)');
  const store = new OwnedCredentials(
    {
      async query(sql, values) {
        return db.prepare(sql).all(...(values as SQLInputValue[]));
      },
    },
    'sqlite',
    {
      namespace: 'test',
      instanceId: randomUUID(),
      encryptionKey: randomBytes(32),
      descriptors: () => [
        {
          id: 'test',
          label: 'Test',
          transport: 'api',
          capabilities: ['text'],
          models: [],
          fields: [
            { id: 'apiKey', label: 'Key', secret: true, required: true, kind: 'string' },
            { id: 'baseUrl', label: 'Endpoint', secret: false, required: false, kind: 'string' },
          ],
        },
      ],
    },
  );
  const target = { owner: { subjectId: 'alice', generation: 1 }, modality: 'ai', provider: 'test' };
  function prepare(
    expectedHeadRevision: string | null = null,
    key = 'personal-secret',
    credentialRevision: string = randomUUID(),
  ) {
    return store.prepareReplacement(target, {
      expectedHeadRevision,
      credentialRevision,
      values: { apiKey: key },
      binding: { protocol: 'openai', endpoint: 'https://example.com/v1' },
      availability: 'enabled',
      label: null,
      metadata: { createdAt: 1, updatedAt: 1, lastUsedAt: null },
    });
  }
  return { db, store, target, prepare };
}
const inconclusive: CredentialValidation = {
  status: 'inconclusive',
  readiness: { code: 'unreachable', checkedAt: 100 },
};

it.each(['', '   '])(
  'rejects a blank required key without replacing the current credential: %j',
  async (key) => {
    const { store, target, prepare } = fixture();
    const current = prepare();
    await store.replace(current);
    expect(() => prepare(current.record.credentialRevision, key)).toThrow('required credential');
    expect((await store.resolve(target))?.values.apiKey).toBe('personal-secret');
  },
);

it('rejects a replacement that omits a required field', () => {
  const { store, target } = fixture();
  expect(() =>
    store.prepareReplacement(target, {
      expectedHeadRevision: null,
      credentialRevision: randomUUID(),
      values: { baseUrl: 'https://example.com/v1' },
      binding: { protocol: 'openai', endpoint: 'https://example.com/v1' },
      availability: 'enabled',
      label: null,
      metadata: { createdAt: 1, updatedAt: 1, lastUsedAt: null },
    }),
  ).toThrow('required credential');
});

it('encrypts personal credentials and isolates owner generations without borrowing another key', async () => {
  const { db, store, target, prepare } = fixture();
  await store.replace(prepare());
  expect((await store.resolve(target))?.values.apiKey).toBe('personal-secret');
  expect(await store.resolve({ ...target, owner: { ...target.owner, generation: 2 } })).toBeNull();
  expect(JSON.stringify(db.prepare('SELECT state FROM SidedoorState').all())).not.toContain(
    'personal-secret',
  );
  expect(JSON.stringify(await store.list())).not.toContain('personal-secret');
});

it('attaches a probe outcome to the prepared ciphertext and replays the same operation', async () => {
  const { store, target, prepare } = fixture();
  const pending = prepare();
  const verified = store.withValidation(pending, {
    status: 'valid',
    readiness: { code: 'ready', authentication: 'verified', checkedAt: 10 },
  });
  expect(verified.record.credentials).toEqual(pending.record.credentials);
  expect(verified.record.credentialRevision).toBe(pending.record.credentialRevision);
  expect(pending.record.verification.lastAttempt).toBeNull();
  expect(await store.replace(verified)).toBe('applied');
  expect(await store.replace(verified)).toBe('replayed');
  expect((await store.head(target)).credential?.verification.lastConfirmed).toMatchObject({
    status: 'verified',
    checkedAt: 10,
  });
  expect(() => store.withValidation(verified, inconclusive)).toThrow('already has verification');
  await expect(store.replace(pending)).rejects.toBeInstanceOf(OwnedCredentialConflictError);
});

it('retains removal heads so delayed creates cannot resurrect deleted credentials', async () => {
  const { store, target, prepare } = fixture();
  const original = prepare();
  await store.replace(original);
  const removal = randomUUID();
  await store.remove(target, original.record.credentialRevision, removal);
  expect(await store.remove(target, original.record.credentialRevision, removal)).toBe('replayed');
  await expect(store.replace(original)).rejects.toBeInstanceOf(OwnedCredentialConflictError);
  await expect(store.replace(prepare())).rejects.toBeInstanceOf(OwnedCredentialConflictError);
  expect(await store.head(target)).toEqual({ revision: removal, credential: null });
  await store.replace(prepare(removal, 'replacement-secret'));
  expect((await store.resolve(target))?.values.apiKey).toBe('replacement-secret');
});

it('replays a prepared write after verification without losing verification history', async () => {
  const { store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  const ticket = await store.beginVerification(target, prepared.record.credentialRevision);
  expect(ticket).not.toBeNull();
  await store.finishVerification(ticket!, inconclusive);
  expect(await store.replace(prepared)).toBe('replayed');
  expect((await store.head(target)).credential?.verification.lastAttempt?.status).toBe('inconclusive');
});

it('ignores older probes and probes for replaced credentials', async () => {
  const { store, target, prepare } = fixture();
  const original = prepare();
  await store.replace(original);
  const first = await store.beginVerification(target, original.record.credentialRevision);
  const second = await store.beginVerification(target, original.record.credentialRevision);
  await store.finishVerification(second!, inconclusive);
  expect(await store.finishVerification(first!, inconclusive)).toBe('superseded');
  await store.replace(prepare(original.record.credentialRevision));
  expect(await store.finishVerification(second!, inconclusive)).toBe('superseded');
  expect((await store.head(target)).credential?.verification.lastAttempt).toBeNull();
});

it('rejects reusing a removed credential revision and leaves old probes superseded', async () => {
  const { store, target, prepare } = fixture();
  const original = prepare();
  await store.replace(original);
  const ticket = await store.beginVerification(target, original.record.credentialRevision);
  const removal = randomUUID();
  await store.remove(target, original.record.credentialRevision, removal);
  await expect(
    store.replace(prepare(removal, 'new-key', original.record.credentialRevision)),
  ).rejects.toBeInstanceOf(OwnedCredentialConflictError);
  expect(await store.finishVerification(ticket!, inconclusive)).toBe('superseded');
  expect(await store.head(target)).toEqual({ revision: removal, credential: null });
});

it('refuses replay when the allocation receipt has been lost', async () => {
  const { db, store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  db.prepare("DELETE FROM SidedoorState WHERE id LIKE 'r:%'").run();
  await expect(store.replace(prepared)).rejects.toThrow(/allocation/);
  await expect(store.resolve(target)).rejects.toThrow(/allocation/);
  await expect(store.list()).rejects.toThrow(/allocation/);
  await expect(store.listOwner(target.owner)).rejects.toThrow(/allocation/);
});

it('rolls back a revision allocation with its credential write and permits retry', async () => {
  const { db, store, target, prepare } = fixture();
  const prepared = prepare();
  db.exec('BEGIN');
  await store.replace(prepared);
  db.exec('ROLLBACK');
  expect(await store.head(target)).toEqual({ revision: null, credential: null });
  db.exec('BEGIN');
  await store.replace(prepared);
  db.exec('COMMIT');
  expect((await store.resolve(target))?.values.apiKey).toBe('personal-secret');
});

it('keeps disabled credentials disabled after an outage or a successful background check', async () => {
  const { store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  const rejected: CredentialValidation = {
    status: 'rejected',
    readiness: { code: 'not_authenticated', checkedAt: 100 },
  };
  const valid: CredentialValidation = {
    status: 'valid',
    readiness: { code: 'ready', checkedAt: 102, authentication: 'verified' },
  };
  for (const outcome of [rejected, inconclusive, valid]) {
    const ticket = await store.beginVerification(target, prepared.record.credentialRevision);
    await store.finishVerification(ticket!, outcome);
    await expect(store.resolve(target)).rejects.toThrow(/disabled/);
  }
  expect((await store.head(target)).credential?.verification.lastConfirmed?.status).toBe('verified');
});

it('allows an exact-revision settings edit to read a disabled key without enabling execution', async () => {
  const { store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  const revision = prepared.record.credentialRevision;
  const ticket = await store.beginVerification(target, revision);
  await store.finishVerification(ticket!, {
    status: 'rejected',
    readiness: { code: 'not_authenticated', checkedAt: 100 },
  });
  expect(await store.readForEdit(target, revision)).toMatchObject({
    availability: 'disabled',
    values: { apiKey: 'personal-secret' },
  });
  await expect(store.resolve(target)).rejects.toThrow(/disabled/);
  await expect(store.readForEdit(target, randomUUID())).rejects.toBeInstanceOf(OwnedCredentialConflictError);
  await store.remove(target, revision, randomUUID());
  await expect(store.readForEdit(target, revision)).rejects.toBeInstanceOf(OwnedCredentialConflictError);
});

it('advances pagination across removed credentials without exposing ciphertext', async () => {
  const { store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  await store.remove(target, prepared.record.credentialRevision, randomUUID());
  const first = await store.list(null, 1);
  expect(first.items).toEqual([]);
  expect(first.cursor).toEqual(expect.any(String));
  expect(await store.list(first.cursor, 1)).toEqual({ items: [], cursor: null });
  const ownerPage = await store.listOwner(target.owner, null, 1);
  expect(await store.listOwner(target.owner, ownerPage.cursor, 1)).toEqual({ items: [], cursor: null });
});

it('does not allocate the same revision to another owner', async () => {
  const { store, target, prepare } = fixture();
  const original = prepare();
  await store.replace(original);
  const other = { ...target, owner: { subjectId: 'bob', generation: 1 } };
  const prepared = store.prepareReplacement(other, {
    expectedHeadRevision: null,
    credentialRevision: original.record.credentialRevision,
    values: { apiKey: 'bob-key' },
    binding: original.record.binding,
    availability: 'enabled',
    label: null,
    metadata: { createdAt: 1, updatedAt: 1, lastUsedAt: null },
  });
  await expect(store.replace(prepared)).rejects.toBeInstanceOf(OwnedCredentialConflictError);
  expect(await store.resolve(other)).toBeNull();
  expect((await store.resolve(target))?.values.apiKey).toBe('personal-secret');
});

it('rejects a credential endpoint different from the endpoint being verified', () => {
  const { store, target } = fixture();
  expect(() =>
    store.prepareReplacement(target, {
      expectedHeadRevision: null,
      credentialRevision: randomUUID(),
      values: { apiKey: 'personal-secret', baseUrl: 'https://other.example/v1' },
      binding: { protocol: 'openai', endpoint: 'https://example.com/v1' },
      availability: 'enabled',
      label: null,
      metadata: { createdAt: 1, updatedAt: 1, lastUsedAt: null },
    }),
  ).toThrow(/endpoint/);
});

it('accepts equivalent endpoint spelling and resolves only the bound destination', async () => {
  const { store, target } = fixture();
  const prepared = store.prepareReplacement(target, {
    expectedHeadRevision: null,
    credentialRevision: randomUUID(),
    values: { apiKey: 'personal-secret', baseUrl: 'https://example.com/v1/' },
    binding: { protocol: 'openai', endpoint: 'https://example.com/v1' },
    availability: 'enabled',
    label: null,
    metadata: { createdAt: 1, updatedAt: 1, lastUsedAt: null },
  });
  await store.replace(prepared);
  expect((await store.resolve(target))?.binding.endpoint).toBe('https://example.com/v1');
  expect((await store.resolve(target))?.values.apiKey).toBe('personal-secret');
});

it('records request use monotonically without changing credential configuration or replay', async () => {
  const { store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  await store.recordUse(target, prepared.record.credentialRevision, 30);
  await store.recordUse(target, prepared.record.credentialRevision, 20);
  expect(await store.replace(prepared)).toBe('replayed');
  expect((await store.head(target)).credential?.metadata).toEqual({
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 30,
  });
  const replacement = prepare(prepared.record.credentialRevision);
  await store.replace(replacement);
  expect(await store.recordUse(target, prepared.record.credentialRevision, 40)).toBe('superseded');
  expect((await store.head(target)).credential?.metadata.lastUsedAt).toBeNull();
  await store.remove(target, replacement.record.credentialRevision, randomUUID());
  expect(await store.recordUse(target, replacement.record.credentialRevision, 50)).toBe('superseded');
});

it('records a request that started before the same credential was disabled', async () => {
  const { store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  const ticket = await store.beginVerification(target, prepared.record.credentialRevision);
  await store.finishVerification(ticket!, {
    status: 'rejected',
    readiness: { code: 'not_authenticated', checkedAt: 30 },
  });
  await store.recordUse(target, prepared.record.credentialRevision, 20);
  expect((await store.head(target)).credential?.metadata.lastUsedAt).toBe(20);
  await expect(store.resolve(target)).rejects.toThrow(/disabled/);
});

it('keeps pending removal bound to its originally selected owner', async () => {
  const { store, target, prepare } = fixture();
  const prepared = prepare();
  await store.replace(prepared);
  const selected = structuredClone(target);
  const removalRevision = randomUUID();
  const pending = store.remove(selected, prepared.record.credentialRevision, removalRevision);
  selected.owner.subjectId = 'someone-else';
  await pending;
  expect(await store.head(target)).toEqual({ revision: removalRevision, credential: null });
  expect(await store.head(selected)).toEqual({ revision: null, credential: null });
});
