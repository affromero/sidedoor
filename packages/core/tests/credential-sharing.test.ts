import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import {
  CredentialSharing,
  CredentialSharingConflictError,
  householdCredentialRecipient,
  type CredentialSharingPolicy,
} from '../src/configuration/credential-sharing';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const target = { modality: 'ai', provider: 'openai' };
const policy: CredentialSharingPolicy = {
  owner: { subjectId: 'profile:owner', generation: 1 },
  audience: 'household',
  excludedRecipients: [{ subjectId: 'profile:other-admin', generation: 2 }],
  source: 'imported',
};
function fixture() {
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
  const instanceId = randomUUID();
  return {
    database,
    sharing: new CredentialSharing(executor, 'sqlite', 'test', instanceId),
    other: new CredentialSharing(executor, 'sqlite', 'test', randomUUID()),
  };
}

it('persists one explicit owner per slot and isolates instances', async () => {
  const { sharing, other } = fixture();
  await sharing.set(target, null, policy);
  expect(await sharing.head(target)).toEqual({ revision: 0, policy });
  expect(await other.head(target)).toEqual({ revision: null, policy: null });
  const replacement = { ...policy, owner: { subjectId: 'profile:new-owner', generation: 3 } };
  await sharing.set(target, 0, replacement);
  expect((await sharing.list()).items).toEqual([{ ...target, revision: 1, policy: replacement }]);
});

it('retains revoked heads and rejects stale edits after removal and recreation', async () => {
  const { sharing } = fixture();
  await sharing.set(target, null, policy);
  await sharing.remove(target, 0);
  await expect(sharing.set(target, null, policy)).rejects.toBeInstanceOf(CredentialSharingConflictError);
  await expect(sharing.set(target, 0, policy)).rejects.toBeInstanceOf(CredentialSharingConflictError);
  expect(await sharing.head(target)).toEqual({ revision: 1, policy: null });
  await sharing.set(target, 1, policy);
  await expect(sharing.remove(target, 0)).rejects.toBeInstanceOf(CredentialSharingConflictError);
  expect((await sharing.head(target)).revision).toBe(2);
});

it('preserves excluded recipient generations without excluding later generations', () => {
  expect(householdCredentialRecipient(policy, { subjectId: 'profile:other-admin', generation: 2 })).toBe(
    false,
  );
  expect(householdCredentialRecipient(policy, { subjectId: 'profile:other-admin', generation: 3 })).toBe(
    true,
  );
  expect(householdCredentialRecipient(policy, { subjectId: 'profile:learner', generation: 1 })).toBe(true);
});

it('advances a bounded scan over revoked policies', async () => {
  const { sharing } = fixture();
  await sharing.remove(target, null);
  const page = await sharing.list(null, 1);
  expect(page.items).toEqual([]);
  expect(page.cursor).toEqual(expect.any(String));
  expect(await sharing.list(page.cursor, 1)).toEqual({ items: [], cursor: null });
});

it('rolls back policy changes with the caller transaction', async () => {
  const { sharing, database } = fixture();
  database.exec('BEGIN');
  await sharing.set(target, null, policy);
  database.exec('ROLLBACK');
  expect(await sharing.head(target)).toEqual({ revision: null, policy: null });
  await sharing.set(target, null, policy);
  expect((await sharing.head(target)).policy?.owner).toEqual(policy.owner);
});

it('rejects duplicate excluded identities instead of storing ambiguous policy', async () => {
  const { sharing } = fixture();
  await expect(
    sharing.set(target, null, { ...policy, excludedRecipients: [policy.owner, policy.owner] }),
  ).rejects.toThrow(/Duplicate/);
  expect(await sharing.head(target)).toEqual({ revision: null, policy: null });
});

it('keeps a pending policy write bound to the originally selected slot', async () => {
  const { sharing } = fixture();
  const selected = { ...target };
  const pending = sharing.set(selected, null, policy);
  selected.provider = 'another-provider';
  await pending;
  expect((await sharing.head(target)).policy).toEqual(policy);
  expect(await sharing.head(selected)).toEqual({ revision: null, policy: null });
});
