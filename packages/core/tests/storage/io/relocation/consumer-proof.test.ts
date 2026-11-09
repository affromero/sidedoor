import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageRelocationRegistry } from '../../../../src/storage/local/relocation';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);
const contentOf = (evidence: { sourceRead: { sha256: string; bytes: number } }) => ({
  sha256: evidence.sourceRead.sha256,
  bytes: evidence.sourceRead.bytes,
});

describe('consumer-scoped relocation proof', () => {
  it('discovers orphan proofs across operations and pages', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      relocations.createConsumerProof({
        operationId: evidence.operationId,
        consumer: 'owner:avatar',
        content: contentOf(evidence),
      }),
    );
    const proof = database
      .prepare("SELECT id, state FROM SidedoorState WHERE id LIKE 'sd-rel-consumer:2:%'")
      .get();
    if (!proof || typeof proof.id !== 'string' || typeof proof.state !== 'string')
      throw new Error('Missing proof');
    const namespacePrefix = proof.id.slice(0, proof.id.indexOf(evidence.operationId));
    for (let index = 0; index < 105; index++) {
      const operationId = randomUUID();
      const consumer = `orphan:${index}`;
      const id = `${namespacePrefix}${operationId}:${createHash('sha256').update(consumer).digest('hex')}`;
      database
        .prepare(
          "INSERT INTO SidedoorState (id, revision, state) VALUES (?, ?, json_set(?, '$.operationId', ?, '$.consumer', ?))",
        )
        .run(id, randomUUID(), proof.state, operationId, consumer);
    }
    database
      .prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel:1:%' OR id LIKE 'sd-rel-scope:1:%'")
      .run();
    const first = await relocations.listAllConsumerProofs();
    expect(first.proofs).toHaveLength(100);
    if (!first.cursor) throw new Error('Missing proof cursor');
    const second = await relocations.listAllConsumerProofs(first.cursor);
    expect(second.proofs).toHaveLength(6);
    expect(new Set([...first.proofs, ...second.proofs].map((item) => item.operationId)).size).toBe(106);
    expect((await relocations.listConsumerProofs(evidence.operationId)).proofs).toHaveLength(1);
    await expect(relocations.listAllConsumerProofs('foreign:cursor')).rejects.toThrow('cursor');
  });
  it.each(['sd-rel-allocation:', 'sd-rel-scope:'])(
    'rejects chain resolution when %s owner evidence is missing',
    async (prefix) => {
      const { database, relocations, transaction, pair } = fixture();
      const { source, destination, evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      await transaction(() =>
        relocations.createConsumerProof({
          operationId: evidence.operationId,
          consumer: 'owner:avatar',
          content: contentOf(evidence),
        }),
      );
      database
        .prepare(
          'DELETE FROM SidedoorState WHERE id = (SELECT id FROM SidedoorState WHERE id LIKE ? LIMIT 1)',
        )
        .run(`${prefix}%`);
      await expect(
        transaction(() =>
          relocations.resolve({
            consumer: 'owner:avatar',
            originalReference: source.prepared.reference,
            currentReference: destination.prepared.reference,
            maxHops: 1,
          }),
        ),
      ).rejects.toThrow();
    },
  );
  it('detects missing and unlisted proofs during chain resolution and cleanup', async () => {
    const { database, relocations, transaction, pair, erasure } = fixture();
    const { source, destination, evidence } = await pair();
    const consumer = 'owner:avatar';
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      relocations.createConsumerProof({
        operationId: evidence.operationId,
        consumer,
        content: contentOf(evidence),
      }),
    );
    const readChain = () =>
      relocations.resolve({
        consumer,
        originalReference: source.prepared.reference,
        currentReference: destination.prepared.reference,
        maxHops: 1,
      });
    await expect(transaction(readChain)).resolves.toMatchObject({ current: { assetId: destination.id } });
    const row = database
      .prepare("SELECT id, revision, state FROM SidedoorState WHERE id LIKE 'sd-rel-consumer:2:%'")
      .get();
    if (
      !row ||
      typeof row.id !== 'string' ||
      typeof row.revision !== 'string' ||
      typeof row.state !== 'string'
    )
      throw new Error('Missing consumer proof');
    database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(row.id);
    await expect(transaction(readChain)).rejects.toThrow('membership');
    database
      .prepare('INSERT INTO SidedoorState (id, revision, state) VALUES (?, ?, ?)')
      .run(row.id, row.revision, row.state);
    const unknownConsumer = 'unlisted:avatar';
    const suffix = createHash('sha256').update(unknownConsumer).digest('hex');
    const extraId = `${row.id.slice(0, row.id.lastIndexOf(':') + 1)}${suffix}`;
    database
      .prepare(
        "INSERT INTO SidedoorState (id, revision, state) SELECT ?, ?, json_set(state, '$.consumer', ?) FROM SidedoorState WHERE id = ?",
      )
      .run(extraId, randomUUID(), unknownConsumer, row.id);
    await expect(transaction(readChain)).rejects.toThrow('membership');
    const request = await erasure();
    const before = database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    await expect(transaction(() => relocations.eraseForSubject(request))).rejects.toThrow('membership');
    expect(database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all()).toEqual(
      before,
    );
    expect(
      (await relocations.listConsumerProofs(evidence.operationId)).proofs.map((proof) => proof.consumer),
    ).toContain(unknownConsumer);
  });
  it.each(['sd-rel:1:', 'sd-rel-consumer:2:'])(
    'rolls back owner and proof when writing %s fails',
    async (prefix) => {
      let injectFailure = false;
      const { database, relocations, transaction, pair } = fixture((values, rows) => {
        if (
          injectFailure &&
          values.some((value) => typeof value === 'string' && value.startsWith(prefix)) &&
          rows.some(
            (row) => row !== null && typeof row === 'object' && 'revision' in row && !('state' in row),
          )
        )
          throw new Error('Injected proof write failure');
      });
      const { evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
      const before = rows();
      injectFailure = true;
      await expect(
        transaction(() =>
          relocations.createConsumerProof({
            operationId: evidence.operationId,
            consumer: 'owner:avatar',
            content: contentOf(evidence),
          }),
        ),
      ).rejects.toThrow('Injected proof write failure');
      injectFailure = false;
      expect(rows()).toEqual(before);
    },
  );
  it.each([
    'sd-rel:1:',
    'sd-rel-allocation:',
    'sd-rels:',
    'sd-rel-scope:',
    'sd-asset:',
    'sd-allocation:',
    'sd-retired:',
  ])('rejects missing %s evidence without repairing it', async (prefix) => {
    const { database, relocations, transaction, pair } = fixture();
    const { destination, evidence } = await pair();
    const consumer = 'owner:avatar';
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      relocations.createConsumerProof({
        operationId: evidence.operationId,
        consumer,
        content: contentOf(evidence),
      }),
    );
    const selector = prefix === 'sd-allocation:' ? `${prefix}%:${destination.id}` : `${prefix}%`;
    database
      .prepare(
        'DELETE FROM SidedoorState WHERE id = (SELECT id FROM SidedoorState WHERE id LIKE ? ORDER BY id LIMIT 1)',
      )
      .run(selector);
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    const input = {
      operationId: evidence.operationId,
      consumer,
      sourceAssetId: evidence.sourceAssetId,
      destinationAssetId: evidence.destinationAssetId,
      content: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
    };
    await expect(transaction(() => relocations.verifyConsumerProof(input))).rejects.toThrow();
    await expect(
      transaction(() =>
        relocations.createConsumerProof({
          operationId: evidence.operationId,
          consumer,
          content: contentOf(evidence),
        }),
      ),
    ).rejects.toThrow();
    expect(rows()).toEqual(before);
  });
  it('requires complete existing evidence and verifies each consumer without writes', async () => {
    const { database, executor, relocations, transaction, asset, proof } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:other', generation: 2 },
    ];
    const source = await asset(consumers, null, scopes);
    const destination = await asset(consumers, source.prepared.reference, scopes);
    const evidence = proof(source, destination, consumers);
    const input = (consumer: string) => ({
      operationId: evidence.operationId,
      consumer,
      sourceAssetId: source.id,
      destinationAssetId: destination.id,
      content: { sha256: evidence.sourceRead.sha256, bytes: evidence.sourceRead.bytes },
    });
    await expect(
      transaction(() =>
        relocations.createConsumerProof({
          operationId: evidence.operationId,
          consumer: consumers[0]!,
          content: contentOf(evidence),
        }),
      ),
    ).rejects.toThrow('receipt is missing');
    await transaction(() => relocations.record(evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 14) WHERE id LIKE 'sd-rel:1:%' AND id LIKE ?",
      )
      .run(`%${evidence.operationId}`);
    await expect(
      transaction(() =>
        relocations.createConsumerProof({
          operationId: evidence.operationId,
          consumer: consumers[0]!,
          content: contentOf(evidence),
        }),
      ),
    ).rejects.toThrow('trusted evidence');
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 13) WHERE id LIKE 'sd-rel:1:%' AND id LIKE ?",
      )
      .run(`%${evidence.operationId}`);
    for (const consumer of consumers) {
      await transaction(() =>
        relocations.createConsumerProof({
          operationId: evidence.operationId,
          consumer,
          content: contentOf(evidence),
        }),
      );
      await transaction(() =>
        relocations.createConsumerProof({
          operationId: evidence.operationId,
          consumer,
          content: contentOf(evidence),
        }),
      );
    }
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
    await expect(transaction(() => readOnly.record(evidence))).resolves.toBeUndefined();
    await expect(transaction(() => readOnly.verifyExisting(evidence))).resolves.toBeUndefined();
    for (const consumer of consumers)
      await expect(transaction(() => readOnly.verifyConsumerProof(input(consumer)))).resolves.toBeUndefined();
    await expect(
      transaction(() =>
        readOnly.verifyConsumerProof({ ...input(consumers[0]!), consumer: 'unknown:avatar' }),
      ),
    ).rejects.toThrow('missing');
    await expect(
      transaction(() =>
        readOnly.verifyConsumerProof({
          ...input(consumers[0]!),
          content: { ...input(consumers[0]!).content, bytes: 14 },
        }),
      ),
    ).rejects.toThrow('does not match');
    expect(rows()).toEqual(before);
  });

  it('erases all matching consumer proofs with their owning receipt and rolls back on tampering', async () => {
    const { database, relocations, transaction, asset, proof, erasure, cleanup } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:other', generation: 2 },
    ];
    const source = await asset(consumers, null, scopes);
    const destination = await asset(consumers, source.prepared.reference, scopes);
    const evidence = proof(source, destination, consumers);
    await transaction(() => relocations.record(evidence));
    for (const consumer of consumers)
      await transaction(() =>
        relocations.createConsumerProof({
          operationId: evidence.operationId,
          consumer,
          content: contentOf(evidence),
        }),
      );
    const request = await erasure();
    expect((await relocations.listForSubject(request.subjectId)).receipts).toHaveLength(1);
    const proofRow = database
      .prepare("SELECT id, state FROM SidedoorState WHERE id LIKE 'sd-rel-consumer:2:%' ORDER BY id LIMIT 1")
      .get();
    if (!proofRow || typeof proofRow.id !== 'string' || typeof proofRow.state !== 'string')
      throw new Error('Missing consumer proof');
    database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 14) WHERE id = ?")
      .run(proofRow.id);
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(transaction(() => relocations.eraseForSubject(request))).rejects.toThrow('consumer proof');
    expect(rows()).toEqual(before);
    database.prepare('UPDATE SidedoorState SET state = ? WHERE id = ?').run(proofRow.state, proofRow.id);
    await expect(transaction(() => relocations.eraseForSubject(request))).resolves.toMatchObject({
      erased: 1,
    });
    expect(
      database.prepare("SELECT id FROM SidedoorState WHERE id LIKE 'sd-rel-consumer:2:%'").all(),
    ).toEqual([]);
    expect(
      database.prepare("SELECT id FROM SidedoorState WHERE id LIKE 'sd-rel-allocation:1:%'").all(),
    ).toHaveLength(1);
    expect((await cleanup.listManifests(request.jobId)).pages.flatMap((page) => page.entries)).toHaveLength(
      2,
    );
  });
});
