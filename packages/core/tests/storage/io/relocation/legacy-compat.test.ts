import { afterEach, describe, expect, it } from 'vitest';
import { StorageRelocationRegistry as LegacyRelocationRegistry } from 'thesidedoor-core-legacy/storage';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

describe('older relocation readers and erasers', () => {
  it('rejects a proof-owning receipt and leaves its evidence intact', async () => {
    const { database, executor, relocations, transaction, pair, erasure } = fixture();
    const legacy = new LegacyRelocationRegistry(executor, 'sqlite', 'test');
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      relocations.createConsumerProof({
        operationId: evidence.operationId,
        consumer: 'owner:avatar',
        content: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
      }),
    );
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const beforeRead = rows();
    await expect(transaction(() => legacy.record(evidence))).rejects.toThrow();
    expect(rows()).toEqual(beforeRead);
    const request = await erasure();
    const beforeErase = rows();
    await expect(transaction(() => legacy.eraseForSubject(request))).rejects.toThrow();
    expect(rows()).toEqual(beforeErase);
    await expect(transaction(() => relocations.eraseForSubject(request))).resolves.toMatchObject({
      erased: 1,
    });
    expect(
      database.prepare("SELECT id FROM SidedoorState WHERE id LIKE 'sd-rel-consumer:2:%'").all(),
    ).toEqual([]);
  });
});
