import type { AtomicStateBackend, StateSnapshot } from './optimistic';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export function isSerializationConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'DriverAdapterError' && error.cause && typeof error.cause === 'object') {
    const cause = error.cause as { kind?: unknown; originalCode?: unknown };
    if (
      cause.kind === 'TransactionWriteConflict' &&
      (cause.originalCode === '40001' || cause.originalCode === '40P01')
    )
      return true;
  }
  if (!('code' in error)) return false;
  if (error.code === 'P2034' || error.code === '40001' || error.code === '40P01') return true;
  if (error.code !== 'P2010' || !('meta' in error) || !error.meta || typeof error.meta !== 'object')
    return false;
  const meta = error.meta as { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  const code = meta.code ?? meta.driverAdapterError?.cause?.originalCode;
  return code === '40001' || code === '40P01';
}

/**
 * Each attempt must open and finish a fresh Serializable database transaction.
 * Retryable work may contain database changes and repeatable computation only.
 * External requests, filesystem writes and notifications belong outside this callback.
 */
export async function retrySerializableTransaction<Result>(
  runTransaction: () => Promise<Result>,
  options: { signal?: AbortSignal } = {},
): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await runTransaction();
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 4) throw error;
      await delay(10 * (attempt + 1), undefined, { signal: options.signal });
    }
  }
}

export interface SqlExecutor {
  /** Parameterized query against the caller's existing connection or transaction. */
  query(sql: string, values: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

/** Optional database work inside a caller-owned transaction. Conflicts retry the whole transaction. */
export async function optionalSqlWrite<Result>(
  database: SqlExecutor,
  operation: () => Promise<Result>,
): Promise<{ ok: true; value: Result } | { ok: false; error: unknown }> {
  const savepoint = `sidedoor_optional_${randomUUID().replaceAll('-', '')}`;
  await database.query(`SAVEPOINT ${savepoint}`, []);
  let value: Result;
  try {
    value = await operation();
  } catch (error) {
    if (isSerializationConflict(error)) throw error;
    await database.query(`ROLLBACK TO SAVEPOINT ${savepoint}`, []);
    await database.query(`RELEASE SAVEPOINT ${savepoint}`, []);
    return { ok: false, error };
  }
  await database.query(`RELEASE SAVEPOINT ${savepoint}`, []);
  return { ok: true, value };
}

/** Bounded keyset scan over colon-terminated namespaces using the state table's pattern index. */
export async function sqlStateRows(
  database: SqlExecutor,
  dialect: 'postgres' | 'sqlite',
  prefix: string,
  after: string | null,
  limit = 100,
  cursorKind: 'digest' | 'uuid' | 'compoundDigest' = 'digest',
) {
  z.number().int().min(1).max(100).parse(limit);
  if (!prefix.endsWith(':')) throw new Error('State scan prefix must end with a colon');
  const cursorSchema =
    cursorKind === 'uuid'
      ? z.uuid()
      : cursorKind === 'compoundDigest'
        ? z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/)
        : z.string().regex(/^[a-f0-9]{64}$/);
  if (
    after !== null &&
    (!after.startsWith(prefix) || !cursorSchema.safeParse(after.slice(prefix.length)).success)
  )
    throw new Error('State cursor belongs to another namespace');
  const p = (index: number) => (dialect === 'postgres' ? `$${index}` : '?');
  const operators =
    dialect === 'postgres'
      ? { lower: '~>=~', upper: '~<~', after: '~>~', order: ' USING ~<~' }
      : { lower: '>=', upper: '<', after: '>', order: '' };
  return database.query(
    `SELECT "id", "revision", "state" FROM "SidedoorState" WHERE "id" ${operators.lower} ${p(1)} AND "id" ${operators.upper} ${p(2)} AND "id" ${operators.after} ${p(3)} ORDER BY "id"${operators.order} LIMIT ${limit}`,
    [prefix, `${prefix.slice(0, -1)};`, after ?? ''],
  );
}

/** Uses the caller-migrated SidedoorState table. No connection pool or schema changes are implicit. */
export function sqlStateBackend(
  database: SqlExecutor,
  dialect: 'postgres' | 'sqlite',
  id: string,
): AtomicStateBackend {
  if (!id || id.length > 200) throw new Error('State namespace must contain 1 to 200 characters');
  const parameter = (index: number) => (dialect === 'postgres' ? `$${index}` : '?');
  function snapshot(row: Record<string, unknown>): StateSnapshot {
    if (typeof row.revision !== 'string') throw new Error('Invalid state revision');
    if (dialect === 'sqlite' && typeof row.state !== 'string') throw new Error('Invalid stored JSON');
    return {
      revision: row.revision,
      state: dialect === 'sqlite' ? JSON.parse(row.state as string) : row.state,
    };
  }
  return {
    async read() {
      const rows = await database.query(
        `SELECT "revision", "state" FROM "SidedoorState" WHERE "id" = ${parameter(1)}`,
        [id],
      );
      return rows[0] ? snapshot(rows[0]) : null;
    },
    async compareAndSwap(previous, next) {
      const encoded = JSON.stringify(next.state);
      if (encoded === undefined) throw new Error('State must be JSON serializable');
      const value = dialect === 'postgres' ? `${parameter(3)}::jsonb` : parameter(3);
      if (previous === null) {
        const rows = await database.query(
          `INSERT INTO "SidedoorState" ("id", "revision", "state") VALUES (${parameter(1)}, ${parameter(2)}, ${value}) ON CONFLICT ("id") DO NOTHING RETURNING "revision"`,
          [id, next.revision, encoded],
        );
        return rows.length === 1;
      }
      const rows = await database.query(
        `UPDATE "SidedoorState" SET "revision" = ${parameter(1)}, "state" = ${dialect === 'postgres' ? `${parameter(2)}::jsonb` : parameter(2)} WHERE "id" = ${parameter(3)} AND "revision" = ${parameter(4)} RETURNING "revision"`,
        [next.revision, encoded, id, previous],
      );
      return rows.length === 1;
    },
  };
}
