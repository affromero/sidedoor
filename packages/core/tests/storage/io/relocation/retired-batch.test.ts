import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

describe('retired relocation batch', () => {
  it('finds the terminal retirement after the first registry page', async () => {
    const { transaction, pair, asset, relocations, registry } = fixture();
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const digestFor = (operationId: string, consumer: string) =>
      createHash('sha256')
        .update(JSON.stringify([operationId, consumer]))
        .digest('hex');
    const terminalOperation = 'f2827c05-f999-47a5-ade6-132d8fdb1be8';
    await transaction(() =>
      registry.retire({
        operationId: terminalOperation,
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    for (let index = 0; index < 101; index++) {
      const consumer = `other:${index}`;
      const unrelated = await asset([consumer]);
      let operationId = randomUUID();
      for (
        let attempt = 0;
        attempt < 1000 && digestFor(operationId, consumer) >= digestFor(terminalOperation, 'owner:avatar');
        attempt++
      )
        operationId = randomUUID();
      if (digestFor(operationId, consumer) >= digestFor(terminalOperation, 'owner:avatar'))
        throw new Error('Could not create an earlier retirement');
      await transaction(() =>
        registry.retire({ operationId, consumer, previousReference: unrelated.prepared.reference }),
      );
    }
    const first = await registry.listRetirements();
    expect(first.cursor).not.toBeNull();
    expect(first.retirements.some((item) => item.operationId === terminalOperation)).toBe(false);
    await expect(
      transaction(() =>
        relocations.verifyRetiredBatch([
          {
            consumer: 'owner:avatar',
            originalAssetId: evidence.sourceAssetId,
            maxHops: 1,
            expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
            requiredOperation: {
              operationId: evidence.operationId,
              sourceAssetId: evidence.sourceAssetId,
              destinationAssetId: evidence.destinationAssetId,
            },
          },
        ]),
      ),
    ).resolves.toEqual([
      {
        terminalAssetId: destination.id,
        content: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
      },
    ]);
  });
  it('rejects missing, unresolved, conflicting, and duplicate terminal retirements', async () => {
    const { database, transaction, pair, relocations, registry } = fixture();
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const operationId = randomUUID();
    const consumer = 'owner:avatar';
    await transaction(() =>
      registry.retire({ operationId, consumer, previousReference: destination.prepared.reference }),
    );
    const request = {
      consumer,
      originalAssetId: evidence.sourceAssetId,
      maxHops: 1,
      expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
      requiredOperation: {
        operationId: evidence.operationId,
        sourceAssetId: evidence.sourceAssetId,
        destinationAssetId: evidence.destinationAssetId,
      },
    };
    const original = database
      .prepare(
        "SELECT id, revision, state FROM SidedoorState WHERE id LIKE 'sd-retired:%' AND json_extract(state, '$.operationId') = ?",
      )
      .get(operationId);
    if (
      !original ||
      typeof original.id !== 'string' ||
      typeof original.revision !== 'string' ||
      typeof original.state !== 'string'
    )
      throw new Error('Missing retirement');
    const { id: originalId, state: originalState } = original;
    const save = () =>
      database.prepare('UPDATE SidedoorState SET state = ? WHERE id = ?').run(originalState, originalId);
    database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(original.id);
    await expect(transaction(() => relocations.verifyRetiredBatch([request]))).rejects.toThrow('retirement');
    database
      .prepare('INSERT INTO SidedoorState (id, revision, state) VALUES (?, ?, ?)')
      .run(original.id, original.revision, original.state);
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.attribution', NULL) WHERE id = ?")
      .run(original.id);
    await expect(transaction(() => relocations.verifyRetiredBatch([request]))).rejects.toThrow('attribution');
    save();
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.replacementAssetId', ?) WHERE id = ?")
      .run('a'.repeat(64), original.id);
    await expect(transaction(() => relocations.verifyRetiredBatch([request]))).rejects.toThrow('replacement');
    save();
    const duplicateOperation = randomUUID();
    const suffix = createHash('sha256')
      .update(JSON.stringify([duplicateOperation, consumer]))
      .digest('hex');
    const duplicateId = `${original.id.slice(0, original.id.lastIndexOf(':') + 1)}${suffix}`;
    database
      .prepare(
        "INSERT INTO SidedoorState (id, revision, state) SELECT ?, ?, json_set(state, '$.operationId', ?) FROM SidedoorState WHERE id = ?",
      )
      .run(duplicateId, randomUUID(), duplicateOperation, original.id);
    await expect(transaction(() => relocations.verifyRetiredBatch([request]))).rejects.toThrow('ambiguous');
  });
  it('rejects a conflicting retained allocation on a later page', async () => {
    const { database, transaction, pair, asset, relocations, registry } = fixture();
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    for (let index = 0; index < 110; index++) await asset([`other:${index}`]);
    const page = await registry.listAllocations();
    if (!page.cursor) throw new Error('Expected more than one allocation page');
    const later = await registry.listAllocations(page.cursor);
    const unrelated = later.allocations.find(
      (item) => item.assetId !== evidence.sourceAssetId && item.assetId !== evidence.destinationAssetId,
    );
    if (!unrelated) throw new Error('Missing later allocation');
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.claims[0].consumer', ?, '$.claims[0].previousReference', ?) WHERE id LIKE 'sd-allocation:%' AND id LIKE ?",
      )
      .run('owner:avatar', destination.prepared.reference, `%${unrelated.assetId}`);
    await expect(
      transaction(() =>
        relocations.verifyRetiredBatch([
          {
            consumer: 'owner:avatar',
            originalAssetId: evidence.sourceAssetId,
            maxHops: 1,
            expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
            requiredOperation: {
              operationId: evidence.operationId,
              sourceAssetId: evidence.sourceAssetId,
              destinationAssetId: evidence.destinationAssetId,
            },
          },
        ]),
      ),
    ).rejects.toThrow('replacement allocation');
  });
  it('uses fewer database queries for overlapping histories than separate verifications', async () => {
    let countQueries = false;
    let queries = 0;
    const { transaction, asset, proof, relocations, registry } = fixture(() => {
      if (countQueries) queries++;
    });
    let previous = await asset();
    const requests: Parameters<typeof relocations.verifyRetiredBatch>[0][number][] = [];
    for (let index = 0; index < 8; index++) {
      const next = await asset(undefined, previous.prepared.reference);
      const evidence = proof(previous, next);
      await transaction(() => relocations.record(evidence));
      requests.push({
        consumer: 'owner:avatar',
        originalAssetId: previous.id,
        maxHops: 8,
        expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
        requiredOperation: {
          operationId: evidence.operationId,
          sourceAssetId: previous.id,
          destinationAssetId: next.id,
        },
      });
      previous = next;
    }
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: previous.prepared.reference,
      }),
    );
    countQueries = true;
    const batch = await transaction(() => relocations.verifyRetiredBatch(requests));
    const batchQueries = queries;
    queries = 0;
    const separate = [];
    for (const request of requests)
      separate.push(...(await transaction(() => relocations.verifyRetiredBatch([request]))));
    countQueries = false;
    expect(batch).toEqual(separate);
    expect(batchQueries).toBeLessThan(queries / 2);
  });
  it('preserves distinct consumers while verifying one shared copy', async () => {
    const { transaction, asset, proof, relocations, registry } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const source = await asset(consumers);
    const destination = await asset(consumers, source.prepared.reference);
    const evidence = proof(source, destination, consumers);
    await transaction(() => relocations.record(evidence));
    for (const consumer of consumers)
      await transaction(() =>
        registry.retire({
          operationId: randomUUID(),
          consumer,
          previousReference: destination.prepared.reference,
        }),
      );
    const requests = consumers.map((consumer) => ({
      consumer,
      originalAssetId: source.id,
      maxHops: 1,
      expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
      requiredOperation: {
        operationId: evidence.operationId,
        sourceAssetId: source.id,
        destinationAssetId: destination.id,
      },
    }));
    const result = await transaction(() => relocations.verifyRetiredBatch(requests));
    expect(result.map((item) => item.terminalAssetId)).toEqual([destination.id, destination.id]);
    await expect(
      transaction(() =>
        relocations.verifyRetiredBatch([
          requests[0]!,
          {
            ...requests[1]!,
            requiredOperation: { ...requests[1]!.requiredOperation, operationId: randomUUID() },
          },
        ]),
      ),
    ).rejects.toThrow('evidence');
  });
  it('verifies overlapping copy chains in either order and rechecks changed evidence', async () => {
    const { database, transaction, pair, asset, proof, relocations, registry } = fixture();
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const last = await asset(undefined, destination.prepared.reference);
    const laterEvidence = proof(destination, last);
    await transaction(() => relocations.record(laterEvidence));
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: last.prepared.reference,
      }),
    );
    const request = (copy: typeof evidence) => ({
      consumer: 'owner:avatar',
      originalAssetId: copy.sourceAssetId,
      maxHops: 2,
      expectedContent: { sha256: copy.sourceRead.sha256, bytes: copy.sourceRead.bytes },
      requiredOperation: {
        operationId: copy.operationId,
        sourceAssetId: copy.sourceAssetId,
        destinationAssetId: copy.destinationAssetId,
      },
    });
    const first = request(evidence);
    const second = request(laterEvidence);
    const expected = { terminalAssetId: last.id, content: first.expectedContent };
    for (const requests of [
      [first, second],
      [second, first],
    ]) {
      await expect(transaction(() => relocations.verifyRetiredBatch(requests))).resolves.toEqual([
        expected,
        expected,
      ]);
    }
    await expect(
      transaction(() => relocations.verifyRetiredBatch([second, { ...first, maxHops: 1 }])),
    ).rejects.toThrow('traversal limit');
    await expect(
      transaction(() =>
        relocations.verifyRetiredBatch([
          first,
          {
            ...second,
            expectedContent: { ...second.expectedContent, bytes: second.expectedContent.bytes + 1 },
          },
        ]),
      ),
    ).rejects.toThrow('evidence');
    await expect(
      transaction(() => relocations.verifyRetiredBatch([{ ...first, maxHops: 1 }])),
    ).rejects.toThrow('traversal limit');
    database
      .prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel-allocation:%' AND id LIKE ?")
      .run(`%${laterEvidence.operationId}`);
    await expect(transaction(() => relocations.verifyRetiredBatch([first, second]))).rejects.toThrow();
  });
});
