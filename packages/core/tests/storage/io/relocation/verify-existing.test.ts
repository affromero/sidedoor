import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageRelocationRegistry } from '../../../../src/storage/local/relocation';
import { prepareStorageTombstone } from '../../../../src/storage/execution/write-journal';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

describe('read-only relocation verification', () => {
  it('verifies existing relocation evidence without writing or repairing it', async () => {
    const { database, executor, relocations, registry, transaction, pair } = fixture();
    const { destination, evidence } = await pair();
    const readOnly = new StorageRelocationRegistry(
      {
        query: (sql, values) => {
          if (!sql.startsWith('SELECT ')) throw new Error('Unexpected verification write');
          return executor.query(sql, values);
        },
      },
      'sqlite',
      'test',
    );
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(transaction(() => readOnly.verifyExisting(evidence))).rejects.toThrow('receipt is missing');
    expect(rows()).toEqual(before);

    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    const recorded = rows();
    await expect(transaction(() => readOnly.verifyExisting(evidence))).resolves.toBeUndefined();
    expect(rows()).toEqual(recorded);
    await expect(
      transaction(() =>
        readOnly.verifyExisting({
          ...evidence,
          sourceRead: { ...evidence.sourceRead, bytes: evidence.sourceRead.bytes + 1 },
          destinationRead: { ...evidence.destinationRead, bytes: evidence.destinationRead.bytes + 1 },
        }),
      ),
    ).rejects.toThrow('different evidence');
    expect(rows()).toEqual(recorded);
  });
  it.each(['sd-rel-allocation:', 'sd-rels:', 'sd-rel-scope:', 'sd-asset:', 'sd-allocation:', 'sd-retired:'])(
    'rejects missing %s evidence without repairing it',
    async (prefix) => {
      const { database, executor, relocations, transaction, asset, proof } = fixture();
      const consumers = ['owner:avatar', 'other:avatar'];
      const scopes = [
        { subjectId: 'profile:owner', generation: 1 },
        { subjectId: 'profile:other', generation: 2 },
      ];
      const source = await asset(consumers, null, scopes);
      const destination = await asset(consumers, source.prepared.reference, scopes);
      const evidence = proof(source, destination, consumers);
      await transaction(() => relocations.record(evidence));
      const selector = prefix === 'sd-allocation:' ? `${prefix}%:${destination.id}` : `${prefix}%`;
      database
        .prepare(
          'DELETE FROM SidedoorState WHERE id = (SELECT id FROM SidedoorState WHERE id LIKE ? ORDER BY id LIMIT 1)',
        )
        .run(selector);
      const before = database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
      const readOnly = new StorageRelocationRegistry(
        {
          query: (sql, values) => {
            if (!sql.startsWith('SELECT ')) throw new Error('Unexpected verification write');
            return executor.query(sql, values);
          },
        },
        'sqlite',
        'test',
      );
      await expect(transaction(() => readOnly.verifyExisting(evidence))).rejects.toThrow();
      expect(database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all()).toEqual(
        before,
      );
    },
  );
  it('rejects a relocation when a captured owner is tombstoned', async () => {
    const { database, relocations, transaction, pair, writes } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
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
    const before = database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    await expect(transaction(() => relocations.verifyExisting(evidence))).rejects.toThrow(
      'ownership was erased',
    );
    expect(database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all()).toEqual(
      before,
    );
  });
});
