import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OptimisticStateStore, type StateSnapshot } from '../src/storage/optimistic';

const schema = z.object({ available: z.boolean() });
describe('database state transactions', () => {
  it('consumes a credential once when independent clients race', async () => {
    let saved: StateSnapshot | null = null;
    const backend = {
      async read() {
        return structuredClone(saved);
      },
      async compareAndSwap(previous: string | null, next: StateSnapshot) {
        if ((saved?.revision ?? null) !== previous) return false;
        saved = structuredClone(next);
        return true;
      },
    };
    const create = () =>
      new OptimisticStateStore({
        backend,
        parse: (value) => schema.parse(value),
        initial: () => ({ available: true }),
      });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        create().transact((state) => {
          if (!state.available) return false;
          state.available = false;
          return true;
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await create().read()).toEqual({ available: false });
  });

  it('reports unavailable persistence without pretending a mutation succeeded', async () => {
    const store = new OptimisticStateStore({
      backend: {
        async read() {
          return null;
        },
        async compareAndSwap() {
          throw new Error('Database unavailable');
        },
      },
      parse: (value) => schema.parse(value),
      initial: () => ({ available: true }),
    });
    await expect(
      store.transact((state) => {
        state.available = false;
      }),
    ).rejects.toThrow('Database unavailable');
  });
});
