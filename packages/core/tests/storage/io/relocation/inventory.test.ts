import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  StorageRelocationRegistry,
  storageRelocationSuccessorKey,
} from '../../../../src/storage/local/relocation';
import { prepareStorageTombstone } from '../../../../src/storage/execution/write-journal';
import { verifySuccessorInventory } from '../../../../src/storage/local/relocation/successor-inventory';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

describe('relocation inventory', () => {
  it('discovers every receipt in bounded pages without relying on scope indexes', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const ids = new Set<string>();
    for (let index = 0; index < 101; index++) {
      const { evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      ids.add(evidence.operationId);
    }
    database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel-scope:%'").run();
    const first = await relocations.listAll();
    expect(first.receipts).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    const second = await relocations.listAll(first.cursor);
    expect(second.receipts).toHaveLength(1);
    expect(second.cursor).toBeNull();
    expect(new Set([...first.receipts, ...second.receipts].map((receipt) => receipt.operationId))).toEqual(
      ids,
    );
  });

  it('rejects cursors from another namespace and inconsistent receipt identity', async () => {
    const { database, executor, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const foreign = new StorageRelocationRegistry(executor, 'sqlite', 'foreign');
    const row = database.prepare("SELECT id FROM SidedoorState WHERE id LIKE 'sd-rel:1:%'").get();
    if (!row || typeof row.id !== 'string') throw new Error('Receipt is missing');
    await expect(foreign.listAll(row.id)).rejects.toThrow('cursor');
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.namespace', 'foreign') WHERE id = ?")
      .run(row.id);
    await expect(relocations.listAll()).rejects.toThrow('identity');
  });

  it('inventories successor keys across pages and exposes orphaned successors', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const expected = new Map<string, string>();
    for (let index = 0; index < 101; index++) {
      const { evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      expected.set(
        storageRelocationSuccessorKey(evidence.sourceAssetId, 'owner:avatar'),
        evidence.operationId,
      );
    }
    await expect(relocations.verifySuccessorInventory({ maxEntries: 101 })).resolves.toBeUndefined();
    await expect(relocations.verifySuccessorInventory({ maxEntries: 100 })).rejects.toThrow(
      'exceeds its limit',
    );
    const deletedOperation = expected.values().next().value;
    database
      .prepare(
        "DELETE FROM SidedoorState WHERE id LIKE 'sd-rel:1:%' AND json_extract(state, '$.operationId') = ?",
      )
      .run(deletedOperation!);
    const first = await relocations.listSuccessorKeys();
    expect(first.successors).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    const second = await relocations.listSuccessorKeys(first.cursor);
    expect(second.successors).toHaveLength(1);
    expect(second.cursor).toBeNull();
    expect(
      new Map([...first.successors, ...second.successors].map(({ key, operationId }) => [key, operationId])),
    ).toEqual(expected);
    expect(
      (await relocations.listAll()).receipts.some((receipt) => receipt.operationId === deletedOperation),
    ).toBe(false);
    await expect(relocations.verifySuccessorInventory({ maxEntries: 101 })).rejects.toThrow(
      'has no matching receipt',
    );
  });

  it('rejects missing or mismatched successor evidence', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const row = database.prepare("SELECT id FROM SidedoorState WHERE id LIKE 'sd-rels:1:%'").get();
    if (!row || typeof row.id !== 'string') throw new Error('Successor is missing');
    const wrongId = `${row.id.slice(0, -64)}${'0'.repeat(64)}`;
    database.prepare('UPDATE SidedoorState SET id = ? WHERE id = ?').run(wrongId, row.id);
    await expect(relocations.verifySuccessorInventory({ maxEntries: 10 })).rejects.toThrow(
      'has no matching receipt',
    );
    database.prepare('UPDATE SidedoorState SET id = ? WHERE id = ?').run(row.id, wrongId);
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.operationId', ?) WHERE id = ?")
      .run(randomUUID(), row.id);
    await expect(relocations.verifySuccessorInventory({ maxEntries: 10 })).rejects.toThrow(
      'has no matching receipt',
    );
    database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(row.id);
    await expect(relocations.verifySuccessorInventory({ maxEntries: 10 })).rejects.toThrow(
      'receipt successor is missing',
    );
  });

  it('stops successor verification when the caller cancels', async () => {
    const { relocations } = fixture();
    const controller = new AbortController();
    controller.abort(new Error('Cancelled inventory'));
    await expect(
      relocations.verifySuccessorInventory({ maxEntries: 10, signal: controller.signal }),
    ).rejects.toThrow('Cancelled inventory');
  });

  it('rejects malformed successor records and foreign successor cursors', async () => {
    const { database, executor, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const row = database.prepare("SELECT id FROM SidedoorState WHERE id LIKE 'sd-rels:1:%'").get();
    if (!row || typeof row.id !== 'string') throw new Error('Successor is missing');
    const foreign = new StorageRelocationRegistry(executor, 'sqlite', 'foreign');
    await expect(foreign.listSuccessorKeys(row.id)).rejects.toThrow('cursor');
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.operationId', 'invalid') WHERE id = ?")
      .run(row.id);
    await expect(relocations.listSuccessorKeys()).rejects.toThrow();
    database
      .prepare('UPDATE SidedoorState SET state = ? WHERE id = ?')
      .run(JSON.stringify({ operationId: evidence.operationId, unexpected: true }), row.id);
    await expect(relocations.listSuccessorKeys()).rejects.toThrow();
    database
      .prepare('UPDATE SidedoorState SET state = ?, id = ? WHERE id = ?')
      .run(
        JSON.stringify({ operationId: evidence.operationId }),
        `${row.id.slice(0, -64)}invalid-key`,
        row.id,
      );
    await expect(relocations.listSuccessorKeys()).rejects.toThrow();
  });

  it.each(['sd-rel:1:%', 'sd-rels:1:%'])(
    'rejects malformed revisions during %s inventory',
    async (pattern) => {
      const { database, relocations, transaction, pair } = fixture();
      const { evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      database.prepare("UPDATE SidedoorState SET revision = X'00' WHERE id LIKE ?").run(pattern);
      await expect(relocations.verifySuccessorInventory({ maxEntries: 10 })).rejects.toThrow(
        'Invalid state revision',
      );
    },
  );

  it('rejects invalid successor inventory limits and responds to cancellation during a scan', async () => {
    const controller = new AbortController();
    let cancel = false;
    const { relocations, transaction, pair } = fixture(() => {
      if (cancel) controller.abort(new Error('Cancelled during scan'));
    });
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    await expect(relocations.verifySuccessorInventory({ maxEntries: 0 })).rejects.toThrow();
    await expect(relocations.verifySuccessorInventory({ maxEntries: 1_000_001 })).rejects.toThrow();
    cancel = true;
    await expect(
      relocations.verifySuccessorInventory({ maxEntries: 10, signal: controller.signal }),
    ).rejects.toThrow('Cancelled during scan');
  });

  it('rejects a successor identity claimed by multiple receipts', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const first = await pair();
    const second = await pair();
    await transaction(() => relocations.record(first.evidence));
    await transaction(() => relocations.record(second.evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.sourceAssetId', ?) WHERE id LIKE 'sd-rel:1:%' AND json_extract(state, '$.operationId') = ?",
      )
      .run(first.source.id, second.evidence.operationId);
    await expect(relocations.verifySuccessorInventory({ maxEntries: 10 })).rejects.toThrow(
      'claimed more than once',
    );
  });

  it('rejects non-advancing receipt and successor cursors', async () => {
    const stuckReceipts = {
      listAll: async () => ({ receipts: [], cursor: 'same' }),
      listSuccessorKeys: async () => ({ successors: [], cursor: null }),
    };
    await expect(verifySuccessorInventory(stuckReceipts, { maxEntries: 10 })).rejects.toThrow(
      'receipt cursor did not advance',
    );
    const stuckSuccessors = {
      listAll: async () => ({ receipts: [], cursor: null }),
      listSuccessorKeys: async () => ({ successors: [], cursor: 'same' }),
    };
    await expect(verifySuccessorInventory(stuckSuccessors, { maxEntries: 10 })).rejects.toThrow(
      'successor cursor did not advance',
    );
  });

  it('finishes successor pagination after an exact full page and handles empty inventories', async () => {
    const { database, relocations, transaction, pair } = fixture();
    expect(await relocations.listSuccessorKeys()).toEqual({ successors: [], cursor: null });
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const row = database
      .prepare("SELECT id, state, revision FROM SidedoorState WHERE id LIKE 'sd-rels:1:%'")
      .get();
    if (
      !row ||
      typeof row.id !== 'string' ||
      typeof row.state !== 'string' ||
      typeof row.revision !== 'string'
    )
      throw new Error('Successor is missing');
    const insert = database.prepare('INSERT INTO SidedoorState (id, revision, state) VALUES (?, ?, ?)');
    for (let index = 0; index < 99; index++)
      insert.run(`${row.id.slice(0, -64)}${index.toString(16).padStart(64, '0')}`, randomUUID(), row.state);
    const first = await relocations.listSuccessorKeys();
    expect(first.successors).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    expect(await relocations.listSuccessorKeys(first.cursor)).toEqual({ successors: [], cursor: null });
  });

  it('checks the exact subject generation and operation without relying on an inventory page', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const scope = { subjectId: 'profile:owner', generation: 1, operationId: evidence.operationId };
    expect(await relocations.hasScopeIndex(scope)).toBe(true);
    await expect(relocations.hasScopeIndex({ ...scope, generation: 2 })).rejects.toThrow('scope index');
    database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel-scope:%'").run();
    expect(await relocations.hasScopeIndex(scope)).toBe(false);
  });

  it('checks historical attribution while a co-owner is tombstoned', async () => {
    const { database, relocations, transaction, asset, proof, writes } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:other', generation: 2 },
    ];
    const source = await asset(consumers, null, scopes);
    const destination = await asset(consumers, source.prepared.reference, scopes);
    const evidence = proof(source, destination, consumers);
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      writes.forbidWrites(
        prepareStorageTombstone({
          namespace: 'test',
          subjectId: 'profile:other',
          generation: 2,
          jobId: randomUUID(),
        }),
      ),
    );
    await expect(relocations.verifyScopeAttribution(evidence.operationId)).resolves.toBeUndefined();
    database.prepare('DELETE FROM SidedoorState WHERE id LIKE ?').run(`sd-asset:1:%:${source.id}`);
    await expect(relocations.verifyScopeAttribution(evidence.operationId)).rejects.toThrow(
      'scope attribution is missing',
    );
  });

  it('rejects a receipt generation that disagrees with its endpoint attribution', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.scopes[0].generation', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    await expect(relocations.verifyScopeAttribution(evidence.operationId)).rejects.toThrow(
      'scope attribution does not match',
    );
  });

  it.each(['same-asset', 'different-operation'] as const)(
    'rejects %s endpoints even when their scopes agree',
    async (kind) => {
      const { database, relocations, transaction, pair } = fixture();
      const first = await pair();
      const second = await pair();
      await transaction(() => relocations.record(first.evidence));
      const path = kind === 'same-asset' ? '$.sourceAssetId' : '$.destinationAssetId';
      const wrong = kind === 'same-asset' ? first.destination.id : second.destination.id;
      database
        .prepare("UPDATE SidedoorState SET state = json_set(state, ?, ?) WHERE id LIKE 'sd-rel:1:%'")
        .run(path, wrong);
      await expect(relocations.verifyScopeAttribution(first.evidence.operationId)).rejects.toThrow(
        'endpoints do not match the operation',
      );
    },
  );
});
