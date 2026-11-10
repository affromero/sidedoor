import { z } from 'zod';
import type { StorageRelocationRegistry } from '../relocation';
import { storageRelocationSuccessorKey } from './records';

/** Check that every stored successor has exactly one independently inventoried receipt. */
export async function verifySuccessorInventory(
  registry: Pick<StorageRelocationRegistry, 'listAll' | 'listSuccessorKeys'>,
  options: { maxEntries: number; signal?: AbortSignal },
) {
  const maxEntries = z.number().int().min(1).max(1_000_000).parse(options.maxEntries);
  const expected = new Map<string, string>();
  let cursor: string | null = null;
  do {
    options.signal?.throwIfAborted();
    const page = await registry.listAll(cursor);
    options.signal?.throwIfAborted();
    for (const receipt of page.receipts) {
      for (const consumer of receipt.consumers) {
        const key = storageRelocationSuccessorKey(receipt.sourceAssetId, consumer);
        if (expected.has(key)) throw new Error('Storage relocation successor is claimed more than once');
        expected.set(key, receipt.operationId);
        if (expected.size > maxEntries)
          throw new Error('Storage relocation successor inventory exceeds its limit');
      }
    }
    if (cursor && page.cursor && page.cursor <= cursor)
      throw new Error('Storage relocation receipt cursor did not advance');
    cursor = page.cursor;
  } while (cursor !== null);
  cursor = null;
  let visited = 0;
  do {
    options.signal?.throwIfAborted();
    const page = await registry.listSuccessorKeys(cursor);
    options.signal?.throwIfAborted();
    for (const successor of page.successors) {
      if (++visited > maxEntries) throw new Error('Storage relocation successor inventory exceeds its limit');
      if (expected.get(successor.key) !== successor.operationId)
        throw new Error('Storage relocation successor has no matching receipt');
      expected.delete(successor.key);
    }
    if (cursor && page.cursor && page.cursor <= cursor)
      throw new Error('Storage relocation successor cursor did not advance');
    cursor = page.cursor;
  } while (cursor !== null);
  if (expected.size) throw new Error('Storage relocation receipt successor is missing');
}
