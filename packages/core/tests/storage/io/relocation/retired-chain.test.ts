import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

describe('retired relocation chain', () => {
  it('enumerates retained allocation claims across pages', async () => {
    const { asset, registry } = fixture();
    const ids: string[] = [];
    for (let index = 0; index < 105; index++) {
      const created = await asset([`consumer:${index}`]);
      ids.push(created.id);
    }
    const first = await registry.listAllocations();
    expect(first.cursor).not.toBeNull();
    const second = await registry.listAllocations(first.cursor);
    expect(second.cursor).toBeNull();
    expect(new Set([...first.allocations, ...second.allocations].map((item) => item.assetId))).toEqual(
      new Set(ids),
    );
  });
  it('rejects a forged terminal retirement that hides an ordinary replacement', async () => {
    const { database, transaction, pair, asset, relocations, registry } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const replacement = await asset(undefined, destination.prepared.reference);
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.replacementAssetId', NULL) WHERE id LIKE 'sd-retired:%' AND json_extract(state, '$.operationId') = ?",
      )
      .run(replacement.prepared.operationId);
    await expect(
      transaction(() =>
        relocations.verifyRetiredChain({
          consumer: 'owner:avatar',
          originalAssetId: source.id,
          retirementOperationId: replacement.prepared.operationId,
          maxHops: 2,
          expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
          requiredOperation: {
            operationId: evidence.operationId,
            sourceAssetId: source.id,
            destinationAssetId: destination.id,
          },
        }),
      ),
    ).rejects.toThrow('replacement allocation');
    const removedAsset = database
      .prepare("SELECT id, revision, state FROM SidedoorState WHERE id LIKE 'sd-asset:%' AND id LIKE ?")
      .get(`%${replacement.id}`);
    if (
      !removedAsset ||
      typeof removedAsset.id !== 'string' ||
      typeof removedAsset.revision !== 'string' ||
      typeof removedAsset.state !== 'string'
    )
      throw new Error('Missing replacement asset');
    database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(removedAsset.id);
    await expect(
      transaction(() =>
        relocations.verifyRetiredChain({
          consumer: 'owner:avatar',
          originalAssetId: source.id,
          retirementOperationId: replacement.prepared.operationId,
          maxHops: 2,
          expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
          requiredOperation: {
            operationId: evidence.operationId,
            sourceAssetId: source.id,
            destinationAssetId: destination.id,
          },
        }),
      ),
    ).rejects.toThrow('replacement allocation');
    database
      .prepare('INSERT INTO SidedoorState (id, revision, state) VALUES (?, ?, ?)')
      .run(removedAsset.id, removedAsset.revision, removedAsset.state);
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.replacementAssetId', ?) WHERE id LIKE 'sd-retired:%' AND json_extract(state, '$.operationId') = ?",
      )
      .run(replacement.id, replacement.prepared.operationId);
    const retirementOperationId = randomUUID();
    await transaction(() =>
      registry.retire({
        operationId: retirementOperationId,
        consumer: 'owner:avatar',
        previousReference: replacement.prepared.reference,
      }),
    );
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.previousReference', ?, '$.attribution', json(?)) WHERE id LIKE 'sd-retired:%' AND json_extract(state, '$.operationId') = ?",
      )
      .run(
        destination.prepared.reference,
        JSON.stringify({ assetId: destination.id, prepared: destination.prepared }),
        retirementOperationId,
      );
    await expect(
      transaction(() =>
        relocations.verifyRetiredChain({
          consumer: 'owner:avatar',
          originalAssetId: source.id,
          retirementOperationId,
          maxHops: 2,
          expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
          requiredOperation: {
            operationId: evidence.operationId,
            sourceAssetId: source.id,
            destinationAssetId: destination.id,
          },
        }),
      ),
    ).rejects.toThrow('has a replacement');
  });
  it('verifies each copy and the final retirement without changing evidence', async () => {
    const { database, transaction, pair, asset, proof, relocations, registry } = fixture();
    const earlier = await asset();
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: earlier.prepared.reference,
      }),
    );
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const last = await asset(undefined, destination.prepared.reference);
    await transaction(() => relocations.record(proof(destination, last)));
    await expect(
      transaction(() =>
        relocations.verifyRetiredChain({
          consumer: 'owner:avatar',
          originalAssetId: source.id,
          retirementOperationId: last.prepared.operationId,
          maxHops: 2,
          expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
          requiredOperation: {
            operationId: evidence.operationId,
            sourceAssetId: source.id,
            destinationAssetId: destination.id,
          },
        }),
      ),
    ).rejects.toThrow('terminal retirement');
    const retirementOperationId = randomUUID();
    await transaction(() =>
      registry.retire({
        operationId: retirementOperationId,
        consumer: 'owner:avatar',
        previousReference: last.prepared.reference,
      }),
    );
    const input = {
      consumer: 'owner:avatar',
      originalAssetId: source.id,
      retirementOperationId,
      maxHops: 2,
      expectedContent: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
      requiredOperation: {
        operationId: evidence.operationId,
        sourceAssetId: source.id,
        destinationAssetId: destination.id,
      },
    };
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(transaction(() => relocations.verifyRetiredChain(input))).resolves.toEqual({
      terminalAssetId: last.id,
      content: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
    });
    await expect(transaction(() => relocations.findRetiredChain(input))).resolves.toEqual({
      terminalAssetId: last.id,
      content: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
    });
    expect(rows()).toEqual(before);
    const retirementRow = database
      .prepare(
        "SELECT state FROM SidedoorState WHERE id LIKE 'sd-retired:%' AND json_extract(state, '$.operationId') = ?",
      )
      .get(retirementOperationId);
    if (!retirementRow || typeof retirementRow.state !== 'string') throw new Error('Missing retirement');
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.previousReference', ?, '$.attribution', json(?)) WHERE id LIKE 'sd-retired:%' AND json_extract(state, '$.operationId') = ?",
      )
      .run(
        destination.prepared.reference,
        JSON.stringify({ assetId: destination.id, prepared: destination.prepared }),
        retirementOperationId,
      );
    await expect(transaction(() => relocations.verifyRetiredChain(input))).rejects.toThrow('has a successor');
    database
      .prepare(
        "UPDATE SidedoorState SET state = ? WHERE id LIKE 'sd-retired:%' AND json_extract(state, '$.operationId') = ?",
      )
      .run(retirementRow.state, retirementOperationId);
    await expect(transaction(() => relocations.verifyRetiredChain({ ...input, maxHops: 1 }))).rejects.toThrow(
      'traversal limit',
    );
    await expect(
      transaction(() => relocations.verifyRetiredChain({ ...input, retirementOperationId: randomUUID() })),
    ).rejects.toThrow('retirement');
    await expect(
      transaction(() =>
        relocations.verifyRetiredChain({
          ...input,
          requiredOperation: { ...input.requiredOperation, operationId: randomUUID() },
        }),
      ),
    ).rejects.toThrow('Required storage relocation');
    const receiptKey = `sd-rel:1:%:${last.prepared.operationId}`;
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 14) WHERE id LIKE ?")
      .run(receiptKey);
    await expect(transaction(() => relocations.verifyRetiredChain(input))).rejects.toThrow('content changed');
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 14) WHERE id LIKE ?")
      .run(`sd-rel:1:%:${evidence.operationId}`);
    await expect(transaction(() => relocations.verifyRetiredChain(input))).rejects.toThrow('content changed');
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 13) WHERE id LIKE ?")
      .run(`sd-rel:1:%:${evidence.operationId}`);
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 13) WHERE id LIKE ?")
      .run(receiptKey);
    database
      .prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel-allocation:%' AND id LIKE ?")
      .run(`%${last.prepared.operationId}`);
    await expect(transaction(() => relocations.verifyRetiredChain(input))).rejects.toThrow();
  });
});
