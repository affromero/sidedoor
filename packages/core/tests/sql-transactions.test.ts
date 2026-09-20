import { describe, expect, it } from 'vitest';
import { isSerializationConflict, retrySerializableTransaction } from '../src/storage/sql';

describe('serializable transaction retries', () => {
  it.each(['40001', '40P01'])('retries a direct Prisma commit conflict %s', async (originalCode) => {
    const conflict = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: { kind: 'TransactionWriteConflict', originalCode },
    });
    let conflicting = true;
    expect(
      await retrySerializableTransaction(async () => {
        if (conflicting) {
          conflicting = false;
          throw conflict;
        }
        return 'committed after retry';
      }),
    ).toBe('committed after retry');
    expect(
      isSerializationConflict(
        Object.assign(new Error('ConnectionLost'), {
          name: 'DriverAdapterError',
          cause: { kind: 'ConnectionClosed', originalCode: '08006' },
        }),
      ),
    ).toBe(false);
  });
  it('lets optional writes distinguish a rejected value from a transaction-wide conflict', () => {
    const adapterFailure = (originalCode: string) =>
      Object.assign(new Error('Database rejected write'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode } } },
      });
    expect(isSerializationConflict(adapterFailure('23514'))).toBe(false);
    expect(isSerializationConflict(adapterFailure('40001'))).toBe(true);
    expect(isSerializationConflict(adapterFailure('40P01'))).toBe(true);
  });
  it.each([
    { code: 'P2034' },
    { code: '40001' },
    { code: '40P01' },
    { code: 'P2010', meta: { code: '40001' } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } },
  ])('starts fresh work after a database conflict: %j', async (details) => {
    let current = 1;
    let conflict = true;
    const result = await retrySerializableTransaction(async () => {
      const snapshot = current;
      if (conflict) {
        conflict = false;
        current = 7;
        throw Object.assign(new Error('Concurrent write'), details);
      }
      current = snapshot + 1;
      return current;
    });
    expect(result).toBe(8);
    expect(current).toBe(8);
  });
  it('preserves the final database failure after exhausting the retry budget', async () => {
    const failures = Array.from({ length: 5 }, (_, index) =>
      Object.assign(new Error(`Conflict ${index}`), { code: '40001' }),
    );
    let attempt = 0;
    await expect(
      retrySerializableTransaction(async () => {
        throw failures[attempt++];
      }),
    ).rejects.toBe(failures[4]);
  });
  it('does not retry unrelated failures or infer retryability from messages', async () => {
    const error = Object.assign(new Error('40001 serialization failure'), {
      code: 'P2010',
      meta: { code: '23505' },
    });
    let attempted = false;
    await expect(
      retrySerializableTransaction(async () => {
        if (attempted) return 'Unexpected successful retry';
        attempted = true;
        throw error;
      }),
    ).rejects.toBe(error);
  });
  it('stops before opening a transaction when cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('Request cancelled');
    controller.abort(reason);
    await expect(
      retrySerializableTransaction(async () => 'Unexpected transaction', { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
  it('cancels backoff instead of starting another transaction', async () => {
    const controller = new AbortController();
    await expect(
      retrySerializableTransaction(
        async () => {
          controller.abort();
          throw Object.assign(new Error('Conflict'), { code: '40001' });
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
