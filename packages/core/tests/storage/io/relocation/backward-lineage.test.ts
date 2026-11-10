import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareStorageBackend,
  StorageBackendRegistry,
} from '../../../../src/storage/registry/backend-registry';
import { prepareStorageReference } from '../../../../src/storage/registry/reference-registry';
import { StorageRelocationRegistry } from '../../../../src/storage/local/relocation';
import { storageBackendBinding } from '../../../../src/storage/registry/references';
import { prepareStorageTombstone } from '../../../../src/storage/execution/write-journal';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

describe('backward relocation lineage', () => {
  it('returns an allocation origin without changing retained records', async () => {
    const { database, relocations, asset, transaction } = fixture();
    const original = await asset();
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    const result = await transaction(() =>
      relocations.traceBackward({
        consumer: 'owner:avatar',
        currentReference: original.prepared.reference,
        maxHops: 1,
      }),
    );
    expect(result).toMatchObject({
      terminal: { assetId: original.id },
      edges: [],
      boundary: { kind: 'allocation-origin', assetId: original.id, reference: original.prepared.reference },
    });
    expect(rows()).toEqual(before);
  });

  it('traces a multihop copy in chronological order and enforces the exact bound', async () => {
    const { database, executor, relocations, asset, proof, transaction } = fixture();
    const original = await asset();
    const first = await asset(undefined, original.prepared.reference);
    await transaction(() => relocations.record(proof(original, first)));
    const second = await asset(undefined, first.prepared.reference);
    await transaction(() => relocations.record(proof(first, second)));
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    const request = { consumer: 'owner:avatar', currentReference: second.prepared.reference, maxHops: 2 };
    const readOnly = new StorageRelocationRegistry(
      {
        async query(sql, values) {
          if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Unexpected write during lineage trace');
          return executor.query(sql, values);
        },
      },
      'sqlite',
      'test',
    );
    const result = await transaction(() => readOnly.traceBackward(request));
    expect(result.edges.map((edge) => edge.operationId)).toEqual([
      first.prepared.operationId,
      second.prepared.operationId,
    ]);
    expect(result.boundary).toEqual({
      kind: 'allocation-origin',
      assetId: original.id,
      reference: original.prepared.reference,
    });
    expect(rows()).toEqual(before);
    await expect(transaction(() => relocations.traceBackward({ ...request, maxHops: 1 }))).rejects.toThrow(
      'traversal limit',
    );
  });

  it('reports an ordinary replacement as an unresolved boundary after a verified suffix', async () => {
    const { relocations, asset, proof, transaction } = fixture();
    const first = await asset();
    const replacement = await asset(undefined, first.prepared.reference);
    const copied = await asset(undefined, replacement.prepared.reference);
    await transaction(() => relocations.record(proof(replacement, copied)));
    const result = await transaction(() =>
      relocations.traceBackward({
        consumer: 'owner:avatar',
        currentReference: copied.prepared.reference,
        maxHops: 1,
      }),
    );
    expect(result.edges.map((edge) => edge.operationId)).toEqual([copied.prepared.operationId]);
    expect(result.boundary).toEqual({
      kind: 'unverified-replacement',
      assetId: replacement.id,
      reference: replacement.prepared.reference,
      previousReference: first.prepared.reference,
    });
  });

  it('does not treat a missing successor index as proof of an origin', async () => {
    const { database, relocations, asset, proof, transaction } = fixture();
    const source = await asset();
    const destination = await asset(undefined, source.prepared.reference);
    await transaction(() => relocations.record(proof(source, destination)));
    database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rels:1:%'").run();
    const result = await transaction(() =>
      relocations.traceBackward({
        consumer: 'owner:avatar',
        currentReference: destination.prepared.reference,
        maxHops: 1,
      }),
    );
    expect(result.edges).toEqual([]);
    expect(result.boundary).toMatchObject({
      kind: 'unverified-replacement',
      previousReference: source.prepared.reference,
    });
  });

  it('rejects a successor pointing to a different relocation', async () => {
    const { database, relocations, pair, transaction } = fixture();
    const first = await pair();
    const other = await pair();
    await transaction(() => relocations.record(first.evidence));
    await transaction(() => relocations.record(other.evidence));
    const hash = createHash('sha256')
      .update(JSON.stringify([first.source.id, 'owner:avatar']))
      .digest('hex');
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.operationId', ?) WHERE id LIKE ?")
      .run(other.evidence.operationId, `sd-rels:1:%:${hash}`);
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: first.destination.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).rejects.toThrow('chain identity does not match');
  });

  it('rejects an allocation that points back into the traversed chain', async () => {
    const { database, relocations, pair, transaction } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.claims[0].previousReference', ?) WHERE id LIKE ?",
      )
      .run(destination.prepared.reference, `sd-allocation:1:%:${source.id}`);
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: destination.prepared.reference,
          maxHops: 2,
        }),
      ),
    ).rejects.toThrow('chain contains a cycle');
  });

  it('reports a same-reference allocation as unresolved rather than a cycle', async () => {
    const { executor, registry, relocations, transaction } = fixture();
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
    const backend = prepareStorageBackend('test', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
      publicUrl: 'https://media.example',
    });
    const prepared = prepareStorageReference({
      namespace: 'test',
      operationId: randomUUID(),
      reference: 'https://media.example/image.png',
      target: { backendId: backend.id, binding: backend.binding, key: 'image.png' },
      scopes: [{ subjectId: 'profile:owner', generation: 1 }],
    });
    await transaction(async () => {
      await new StorageBackendRegistry(executor, 'sqlite', 'test').register(backend);
      await registry.replace({
        consumer: 'owner:avatar',
        previousReference: prepared.reference,
        next: prepared,
      });
    });
    const result = await transaction(() =>
      relocations.traceBackward({
        consumer: 'owner:avatar',
        currentReference: prepared.reference,
        maxHops: 1,
      }),
    );
    expect(result.edges).toEqual([]);
    expect(result.boundary).toMatchObject({
      kind: 'unverified-replacement',
      reference: prepared.reference,
      previousReference: prepared.reference,
    });
  });

  it.each(['allocation', 'previous-reference', 'receipt'] as const)(
    'rejects a missing %s instead of claiming a complete history',
    async (missing) => {
      const { database, relocations, asset, proof, transaction } = fixture();
      const source = await asset();
      const destination = await asset(undefined, source.prepared.reference);
      await transaction(() => relocations.record(proof(source, destination)));
      if (missing === 'allocation')
        database
          .prepare('DELETE FROM SidedoorState WHERE id LIKE ?')
          .run(`sd-allocation:1:%:${destination.id}`);
      else if (missing === 'previous-reference')
        database
          .prepare(
            "DELETE FROM SidedoorState WHERE id LIKE 'sd-alias:1:%' AND json_extract(state, '$.reference') = ?",
          )
          .run(source.prepared.reference);
      else database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel:1:%'").run();
      await expect(
        transaction(() =>
          relocations.traceBackward({
            consumer: 'owner:avatar',
            currentReference: destination.prepared.reference,
            maxHops: 1,
          }),
        ),
      ).rejects.toThrow(
        missing === 'allocation'
          ? 'allocation is missing'
          : missing === 'receipt'
            ? 'receipt is missing'
            : 'previous reference is missing',
      );
    },
  );

  it('rejects content changes across separately recorded relocation edges', async () => {
    const { database, relocations, asset, proof, transaction } = fixture();
    const original = await asset();
    const first = await asset(undefined, original.prepared.reference);
    await transaction(() => relocations.record(proof(original, first)));
    const second = await asset(undefined, first.prepared.reference);
    await transaction(() => relocations.record(proof(first, second)));
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 14) WHERE id LIKE ?")
      .run(`sd-rel:1:%:${first.prepared.operationId}`);
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: second.prepared.reference,
          maxHops: 2,
        }),
      ),
    ).rejects.toThrow('content changed');
  });

  it('rejects a tombstoned terminal even when no relocation was recorded', async () => {
    const { relocations, asset, transaction, writes } = fixture();
    const original = await asset();
    await transaction(() =>
      writes.forbidWrites(
        prepareStorageTombstone({
          namespace: 'test',
          subjectId: 'profile:owner',
          generation: 1,
          jobId: randomUUID(),
        }),
      ),
    );
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: original.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).rejects.toThrow('ownership was erased');
  });

  it('rejects a relocated terminal when another captured owner is tombstoned', async () => {
    const { relocations, asset, proof, transaction, writes } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:other', generation: 2 },
    ];
    const source = await asset(consumers, null, scopes);
    const destination = await asset(consumers, source.prepared.reference, scopes);
    await transaction(() => relocations.record(proof(source, destination, consumers)));
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
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: destination.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).rejects.toThrow('ownership was erased');
  });

  it('verifies evidence for every captured consumer, not just the current one', async () => {
    const { database, relocations, asset, proof, transaction } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const source = await asset(consumers);
    const destination = await asset(consumers, source.prepared.reference);
    await transaction(() => relocations.record(proof(source, destination, consumers)));
    database
      .prepare(
        "DELETE FROM SidedoorState WHERE id LIKE 'sd-retired:1:%' AND json_extract(state, '$.consumer') = ?",
      )
      .run('other:avatar');
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: destination.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).rejects.toThrow('exact source retirement');
  });

  it('rejects a conflicting scope index within the traced edge', async () => {
    const { database, relocations, pair, transaction } = fixture();
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.generation', 2) WHERE id LIKE 'sd-rel-scope:1:%'",
      )
      .run();
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: destination.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).rejects.toThrow('scope index changed');
  });

  it('honors cancellation after a missing successor read', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled during successor lookup');
    let armed = false;
    const { relocations, asset, transaction } = fixture((values, rows) => {
      if (armed && rows.length === 0 && typeof values[0] === 'string' && values[0].startsWith('sd-rels:'))
        controller.abort(reason);
    });
    const first = await asset();
    const replacement = await asset(undefined, first.prepared.reference);
    armed = true;
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: replacement.prepared.reference,
          maxHops: 1,
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
  });

  it('honors cancellation after a missing receipt read', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled during receipt lookup');
    let armed = false;
    const { database, relocations, pair, transaction } = fixture((values, rows) => {
      if (armed && rows.length === 0 && typeof values[0] === 'string' && values[0].startsWith('sd-rel:1:'))
        controller.abort(reason);
    });
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel:1:%'").run();
    armed = true;
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: destination.prepared.reference,
          maxHops: 1,
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
  });

  it('does not query the database when already cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled before lineage lookup');
    let armed = false;
    let queries = 0;
    const { relocations, asset, transaction } = fixture(() => {
      if (armed) queries++;
    });
    const original = await asset();
    armed = true;
    controller.abort(reason);
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: original.prepared.reference,
          maxHops: 1,
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
    expect(queries).toBe(0);
  });

  it('reports cancellation if an in-flight database query also fails', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled while a database query failed');
    let armed = false;
    const { relocations, asset, transaction } = fixture((values) => {
      if (armed && typeof values[0] === 'string' && values[0].startsWith('sd-asset:1:')) {
        controller.abort(reason);
        throw new Error('Database query failed');
      }
    });
    const original = await asset();
    armed = true;
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: original.prepared.reference,
          maxHops: 1,
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
  });

  it.each([
    { prefix: 'sd-asset:1:', message: 'successful reference read' },
    { prefix: 'sd-rel-allocation:1:', message: 'receipt verification' },
  ])('starts no further database queries after cancellation during $message', async ({ prefix }) => {
    const controller = new AbortController();
    const reason = new Error('Cancelled during successful query');
    let armed = false;
    let queriesAfterAbort = 0;
    const { relocations, pair, transaction } = fixture((values, rows) => {
      if (!armed) return;
      if (controller.signal.aborted) {
        queriesAfterAbort++;
        return;
      }
      if (rows.length > 0 && typeof values[0] === 'string' && values[0].startsWith(prefix))
        controller.abort(reason);
    });
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    armed = true;
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: destination.prepared.reference,
          maxHops: 1,
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
    expect(queriesAfterAbort).toBe(0);
  });

  it('rejects a consumer that no longer owns the terminal asset', async () => {
    const { registry, relocations, asset, transaction } = fixture();
    const original = await asset();
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: original.prepared.reference,
      }),
    );
    await expect(
      transaction(() =>
        relocations.traceBackward({
          consumer: 'owner:avatar',
          currentReference: original.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).rejects.toThrow('does not belong');
  });
});
