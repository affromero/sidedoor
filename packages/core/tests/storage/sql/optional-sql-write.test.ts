import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { optionalSqlWrite } from '../../../src/storage/sql/sql';

describe('optional transactional writes', () => {
  it('preserves surrounding writes and successful values while rolling back a rejected optional operation', async () => {
    const connection = new DatabaseSync(':memory:');
    const database = {
      async query(sql: string, values: readonly unknown[]) {
        return connection.prepare(sql).all(...(values as SQLInputValue[]));
      },
    };
    try {
      connection.exec(
        'CREATE TABLE records (id INTEGER PRIMARY KEY CHECK(id > 0)); BEGIN; INSERT INTO records VALUES (1)',
      );
      expect(
        await optionalSqlWrite(database, async () => {
          await database.query('INSERT INTO records VALUES (?)', [2]);
          return 'saved';
        }),
      ).toEqual({ ok: true, value: 'saved' });
      expect(
        await optionalSqlWrite(database, async () => {
          await database.query('INSERT INTO records VALUES (?)', [3]);
          await database.query('INSERT INTO records VALUES (?)', [-1]);
        }),
      ).toMatchObject({ ok: false, error: expect.any(Error) });
      connection.exec('INSERT INTO records VALUES (4); COMMIT');
      expect(connection.prepare('SELECT id FROM records ORDER BY id').all()).toEqual([
        { id: 1 },
        { id: 2 },
        { id: 4 },
      ]);
    } finally {
      connection.close();
    }
  });

  it.each(['40001', '40P01'])('propagates transaction-wide conflict %s', async (code) => {
    const connection = new DatabaseSync(':memory:');
    const conflict = Object.assign(new Error('Concurrent database operation'), { code });
    try {
      connection.exec('BEGIN');
      await expect(
        optionalSqlWrite(
          {
            async query(sql) {
              return connection.prepare(sql).all();
            },
          },
          async () => {
            throw conflict;
          },
        ),
      ).rejects.toBe(conflict);
      connection.exec('ROLLBACK');
    } finally {
      connection.close();
    }
  });

  it.each(['ROLLBACK TO', 'RELEASE'])(
    'propagates %s failure instead of swallowing it as optional',
    async (command) => {
      const failure = new Error('Savepoint cleanup failed');
      await expect(
        optionalSqlWrite(
          {
            async query(sql) {
              if (sql.startsWith(command)) throw failure;
              return [];
            },
          },
          async () => {
            throw new Error('Optional write rejected');
          },
        ),
      ).rejects.toBe(failure);
    },
  );
});
