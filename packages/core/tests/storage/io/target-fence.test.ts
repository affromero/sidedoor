import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageTargetFence } from '../../../src/storage/execution/target-fence';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

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
  async function transaction<Result>(run: () => Promise<Result>) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await run();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return { database, fence: new StorageTargetFence(executor, 'sqlite'), transaction };
}

describe('storage target retirement fence', () => {
  it('permanently blocks a retired target while allowing unrelated keys and exact retries', async () => {
    const { database, fence, transaction } = fixture();
    const target = { binding: 'a'.repeat(64), key: 'worksheets/private.pdf' };
    const retirementId = randomUUID();
    await transaction(() => fence.admit(target));
    await transaction(() => fence.retire({ ...target, retirementId }));
    await transaction(() => fence.retire({ ...target, retirementId }));
    await expect(transaction(() => fence.admit(target))).rejects.toThrow('target is retired');
    await expect(transaction(() => fence.retire({ ...target, retirementId: randomUUID() }))).rejects.toThrow(
      'already retired',
    );
    await transaction(() => fence.admit({ ...target, key: 'worksheets/other.pdf' }));
    const rows = database.prepare("SELECT state FROM SidedoorState WHERE id LIKE 'sd-tf:%'").all();
    expect(JSON.stringify(rows)).not.toContain(target.key);
    expect(JSON.stringify(rows)).not.toContain(retirementId);
  });

  it('rolls back a retirement with its enclosing transaction', async () => {
    const { fence, transaction } = fixture();
    const target = { binding: 'b'.repeat(64), key: 'audio/lesson.mp3' };
    await expect(
      transaction(async () => {
        await fence.retire({ ...target, retirementId: randomUUID() });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await transaction(() => fence.admit(target));
  });

  it('fails closed when retained write evidence is incomplete', async () => {
    const { database, fence, transaction } = fixture();
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const operationId = randomUUID();
    const state = {
      kind: 'write',
      namespace: 'app',
      subjectId: 'learner',
      operationId,
      target: { backendId: 'c'.repeat(64), binding: 'b'.repeat(64), key: 'other.mp3' },
      status: 'active',
    };
    database
      .prepare('INSERT INTO SidedoorState (id, revision, state) VALUES (?, ?, ?)')
      .run(
        `sd-w:1:${digest('app')}:${digest('learner')}:${operationId}`,
        randomUUID(),
        JSON.stringify(state),
      );
    await expect(
      transaction(() =>
        fence.retire({ binding: 'a'.repeat(64), key: 'lesson.mp3', retirementId: randomUUID() }),
      ),
    ).rejects.toThrow();
  });
});
