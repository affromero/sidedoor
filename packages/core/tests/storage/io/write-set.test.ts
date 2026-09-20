import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { writeReferenceSet, type ReferenceSetOptions } from '../../../src/storage/execution/write-set';
import { StorageInstanceControl } from '../../../src/storage/sql/instance';
import { StorageReferenceRegistry } from '../../../src/storage/registry/reference-registry';
import { StorageWriteJournal } from '../../../src/storage/execution/write-journal';
import { storageBackendBinding } from '../../../src/storage/registry/references';
import type { SqlExecutor } from '../../../src/storage/sql/sql';
import { StorageReadCleanupError } from '../../../src/storage/local/owned-copy';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

it('publishes verified uploads with their captured attribution after a lost commit response', async () => {
  const item = await fixture();
  const options = item.options(['waveform']);
  const evidence: Array<{
    operationId: string;
    target: { backendId: string; binding: string; key: string };
  }> = [];
  options.verifyArtifact = async (artifact, signal) => {
    signal.throwIfAborted();
    expect(item.published()).toEqual({});
    expect(item.objects.get(artifact.reference)).toBe(artifact.name);
    evidence.push(structuredClone({ operationId: artifact.operationId, target: artifact.target }));
    // Readback evidence is detached from publication's captured target and descriptor.
    artifact.target.key = 'changed-by-verifier';
    if (artifact.descriptor.kind === 'object') artifact.descriptor.binding = '0'.repeat(64);
  };
  item.loseResponse();
  const result = await writeReferenceSet(options);
  const registered = await new StorageReferenceRegistry(item.executor, 'sqlite', 'app').resolve({
    consumer: 'episode:one:waveform',
    reference: result.waveform!,
  });
  expect(registered?.prepared).toMatchObject(evidence[0]!);
  expect(item.published()).toEqual(result);
});

it.each(['mismatch', 'cleanup', 'cancel'] as const)(
  'does not publish confirmed uploads after readback %s',
  async (failure) => {
    const item = await fixture();
    const options = item.options(['waveform', 'spectrogram', 'later']);
    const controller = new AbortController();
    options.signal = controller.signal;
    const reason =
      failure === 'cleanup'
        ? new StorageReadCleanupError({ cause: new Error('Readback close unconfirmed') })
        : new Error('Destination readback does not match');
    options.verifyArtifact = async (artifact) => {
      if (artifact.name !== 'spectrogram') return;
      if (failure === 'cancel') controller.abort(reason);
      else throw reason;
    };
    await expect(writeReferenceSet(options)).rejects.toBe(reason);
    expect(item.published()).toEqual({});
    expect([...item.objects.values()].sort()).toEqual(['spectrogram', 'waveform']);
    const references = await new StorageReferenceRegistry(item.executor, 'sqlite', 'app').listAssets();
    expect(references.assets).toEqual([]);
    const intents = (await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one'))
      .intents;
    expect(intents.map((intent) => ({ status: intent.status, outcome: intent.outcome }))).toEqual([
      { status: 'settled', outcome: 'unreferenced' },
      { status: 'settled', outcome: 'unreferenced' },
    ]);
  },
);

it('retains the admitted verifier when caller options change during upload', async () => {
  const item = await fixture();
  const options = item.options(['waveform']);
  const reason = new Error('Captured verifier rejects readback');
  options.verifyArtifact = async () => {
    throw reason;
  };
  const artifact = options.artifacts[0]!;
  options.artifacts = [
    {
      ...artifact,
      captureWriter: async () => {
        const writer = await artifact.captureWriter();
        return {
          ...writer,
          write: async (...args) => {
            delete options.verifyArtifact;
            return writer.write(...args);
          },
        };
      },
    },
  ];
  await expect(writeReferenceSet(options)).rejects.toBe(reason);
  expect(item.published()).toEqual({});
});

it.each(['write', 'validation', 'publication'])(
  'retains uploaded bytes without publishing when cancelled during final %s',
  async (phase) => {
    const item = await fixture();
    const controller = new AbortController();
    const options = item.options(['waveform', 'spectrogram']);
    options.signal = controller.signal;
    const reason = new Error('Cancelled before publication');
    if (phase === 'write') {
      options.artifacts = options.artifacts.map((artifact) => ({
        ...artifact,
        captureWriter: async () => {
          const writer = await artifact.captureWriter();
          return {
            ...writer,
            write: async (...args) => {
              const url = await writer.write(...args);
              if (artifact.name === 'spectrogram') controller.abort(reason);
              return url;
            },
          };
        },
      }));
    } else if (phase === 'validation') {
      const validate = options.validateAdmission;
      options.validateAdmission = async (...args) => {
        await validate(...args);
        if (item.objects.size === 2) controller.abort(reason);
      };
    } else {
      const commit = options.commit;
      options.commit = async (...args) => {
        await commit(...args);
        controller.abort(reason);
      };
    }
    await expect(writeReferenceSet(options)).rejects.toBe(reason);
    expect(item.published()).toEqual({});
    expect(item.objects.size).toBe(2);
    expect((await new StorageReferenceRegistry(item.executor, 'sqlite', 'app').listAssets()).assets).toEqual(
      [],
    );
    const intents = (await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one'))
      .intents;
    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.status === 'settled' && intent.outcome === 'unreferenced')).toBe(
      true,
    );
  },
);

it('recovers an already committed set when cancellation accompanies its lost response', async () => {
  const item = await fixture();
  const controller = new AbortController();
  const options = item.options(['waveform', 'spectrogram']);
  options.signal = controller.signal;
  options.transaction = async (operation) => {
    const result = await item.transaction(operation);
    if (!controller.signal.aborted && Object.keys(item.published()).length === 2) {
      controller.abort();
      throw new Error('Lost commit response');
    }
    return result;
  };
  const published = await writeReferenceSet(options);
  expect(item.published()).toEqual(published);
  expect((await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one')).intents).toEqual(
    [],
  );
});
async function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE Published (slot TEXT PRIMARY KEY, url TEXT NOT NULL)',
  );
  const executor: SqlExecutor = {
    async query(sql, values) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  let loseCommit = false;
  async function transaction<Result>(run: (tx: SqlExecutor) => Promise<Result>): Promise<Result> {
    const previous = JSON.stringify(database.prepare('SELECT slot,url FROM Published ORDER BY slot').all());
    database.exec('BEGIN IMMEDIATE');
    let result: Result;
    try {
      result = await run(executor);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    if (
      loseCommit &&
      previous !== JSON.stringify(database.prepare('SELECT slot,url FROM Published ORDER BY slot').all())
    ) {
      loseCommit = false;
      throw new Error('Lost response after publication committed');
    }
    return result;
  }
  const instance = await transaction((tx) =>
    new StorageInstanceControl(tx, 'sqlite', 'app').initialize(randomUUID()),
  );
  const published = () =>
    Object.fromEntries(
      database
        .prepare('SELECT slot,url FROM Published ORDER BY slot')
        .all()
        .map((row) => [String(row.slot), String(row.url)]),
    );
  const objects = new Map<string, string>();
  let failArtifact: string | null = null;
  type Snapshot = { previous: Record<string, string> };
  const options = (names: string[], clear: string[] = []): ReferenceSetOptions<SqlExecutor, Snapshot> => ({
    namespace: 'app',
    dialect: 'sqlite',
    signal: new AbortController().signal,
    transaction,
    executor: (tx) => tx,
    captureAdmission: async () => ({
      instanceId: instance.instanceId,
      scopes: [instance, { subjectId: 'episode:one', generation: 1 }].map(({ subjectId, generation }) => ({
        subjectId,
        generation,
      })),
      snapshot: { previous: published() },
    }),
    validateAdmission: async (tx, admission, urls) => {
      expect(tx).toBe(executor);
      const expected = { ...admission.snapshot.previous, ...urls };
      if (urls) for (const slot of clear) delete expected[slot];
      expect(published()).toEqual(expected);
    },
    artifacts: names.map((slot) => ({
      name: slot,
      prefix: slot,
      extension: 'bin',
      contentType: 'application/octet-stream',
      body: Buffer.from(slot),
      consumers: (snapshot) => [
        { consumer: `episode:one:${slot}`, previousReference: snapshot.previous[slot] ?? null },
      ],
      captureWriter: async () => {
        const location = { kind: 'object' as const, endpoint: `https://${slot}.example`, bucket: slot };
        return {
          descriptor: {
            kind: 'object',
            location,
            binding: storageBackendBinding(location),
            access: null,
            publicUrl: `https://${slot}.example/media`,
            referenceEncoding: 'raw',
          },
          write: async (key) => {
            const url = `https://${slot}.example/media/${key}`;
            objects.set(url, slot);
            if (failArtifact === slot) throw new Error('Remote request failed after acceptance');
            return url;
          },
        };
      },
    })),
    retirements: (snapshot) =>
      clear.map((slot) => ({ consumer: `episode:one:${slot}`, previousReference: snapshot.previous[slot]! })),
    commit: async (tx, urls) => {
      for (const slot of clear) await tx.query('DELETE FROM Published WHERE slot = ?', [slot]);
      for (const [slot, url] of Object.entries(urls))
        await tx.query('INSERT OR REPLACE INTO Published(slot,url) VALUES (?,?)', [slot, url]);
    },
  });
  return {
    database,
    executor,
    transaction,
    published,
    objects,
    options,
    loseResponse: () => {
      loseCommit = true;
    },
    fail: (slot: string) => {
      failArtifact = slot;
    },
  };
}

it('publishes distinct backends and all references together, including exact recovery after a lost response', async () => {
  const item = await fixture();
  item.loseResponse();
  const result = await writeReferenceSet(item.options(['waveform', 'spectrogram']));
  expect(item.published()).toEqual(result);
  expect(item.objects.size).toBe(2);
  const references = new StorageReferenceRegistry(item.executor, 'sqlite', 'app');
  for (const [slot, url] of Object.entries(result)) {
    const resolved = await references.resolve({ consumer: `episode:one:${slot}`, reference: url });
    expect(resolved?.backend.descriptor).toMatchObject({ location: { bucket: slot } });
  }
  expect((await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one')).intents).toEqual(
    [],
  );
});

it('rolls back every asset and application URL when the second publication is rejected', async () => {
  const item = await fixture();
  item.database.exec(
    "CREATE TRIGGER reject_image BEFORE INSERT ON Published WHEN NEW.slot = 'spectrogram' BEGIN SELECT RAISE(ABORT, 'publication rejected'); END;",
  );
  await expect(writeReferenceSet(item.options(['waveform', 'spectrogram']))).rejects.toThrow(
    'publication rejected',
  );
  expect(item.published()).toEqual({});
  expect(item.objects.size).toBe(2);
  expect((await new StorageReferenceRegistry(item.executor, 'sqlite', 'app').listAssets()).assets).toEqual(
    [],
  );
  const intents = (await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one')).intents;
  expect(intents).toHaveLength(2);
  expect(intents.every((intent) => intent.status === 'settled' && intent.outcome === 'unreferenced')).toBe(
    true,
  );
});

it('distinguishes completed, uncertain and untouched artifacts after the second upload fails', async () => {
  const item = await fixture();
  item.fail('spectrogram');
  await expect(writeReferenceSet(item.options(['waveform', 'spectrogram', 'other']))).rejects.toThrow(
    'Remote request failed',
  );
  expect(item.published()).toEqual({});
  expect([...item.objects.values()].sort()).toEqual(['spectrogram', 'waveform']);
  const intents = (await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one')).intents;
  expect(intents).toHaveLength(2);
  expect(intents.find((intent) => intent.target.key.startsWith('waveform/'))).toMatchObject({
    status: 'settled',
    outcome: 'unreferenced',
  });
  expect(intents.find((intent) => intent.target.key.startsWith('spectrogram/'))).toMatchObject({
    status: 'uncertain',
    outcome: 'uncertain',
  });
});

it('retires an omitted artifact with the replacement set and preserves the old bytes for cleanup', async () => {
  const item = await fixture();
  const original = await writeReferenceSet(item.options(['spectrogram']));
  item.loseResponse();
  const result = await writeReferenceSet(item.options(['waveform'], ['spectrogram']));
  expect(item.published()).toEqual(result);
  expect(item.objects.has(original.spectrogram!)).toBe(true);
  const retired = await new StorageReferenceRegistry(item.executor, 'sqlite', 'app').listRetirements();
  expect(retired.retirements).toHaveLength(1);
  expect(retired.retirements[0]).toMatchObject({
    consumer: 'episode:one:spectrogram',
    previousReference: original.spectrogram,
    status: 'pending',
  });
});

it('retains every intent when failure settlement cannot commit', async () => {
  const item = await fixture();
  item.database.exec(
    "CREATE TRIGGER reject_settlement BEFORE UPDATE ON SidedoorState WHEN json_extract(NEW.state, '$.outcome') = 'unreferenced' BEGIN SELECT RAISE(ABORT, 'settlement rejected'); END;",
  );
  item.fail('spectrogram');
  await expect(writeReferenceSet(item.options(['waveform', 'spectrogram', 'other']))).rejects.toMatchObject({
    message: 'Storage failure settlement could not commit',
    errors: [
      expect.objectContaining({ message: 'Remote request failed after acceptance' }),
      expect.objectContaining({ message: 'settlement rejected' }),
    ],
  });
  const intents = (await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one')).intents;
  expect(intents).toHaveLength(3);
  expect(intents.every((intent) => intent.status === 'active' && intent.outcome === undefined)).toBe(true);
  expect(item.published()).toEqual({});
});

it('rejects a reused stream before starting any writer', async () => {
  const item = await fixture();
  const options = item.options(['waveform', 'spectrogram']);
  const body = Readable.from(['private bytes']);
  options.artifacts = options.artifacts.map((artifact) => ({ ...artifact, body }));
  await expect(writeReferenceSet(options)).rejects.toThrow('distinct stream');
  expect(body.destroyed).toBe(true);
  expect(item.objects.size).toBe(0);
});

it('keeps committed references while reporting unresolved source closure', async () => {
  const item = await fixture();
  const options = item.options(['waveform']);
  const failure = new Error('Source close acknowledgement failed');
  const body = new Readable({
    read() {},
    destroy(error, callback) {
      callback(failure);
    },
  });
  options.artifacts = options.artifacts.map((artifact) => ({ ...artifact, body }));
  await expect(writeReferenceSet(options)).rejects.toBeInstanceOf(StorageReadCleanupError);
  const published = item.published();
  expect(published.waveform).toBeDefined();
  expect(
    (
      await new StorageReferenceRegistry(item.executor, 'sqlite', 'app').resolve({
        consumer: 'episode:one:waveform',
        reference: published.waveform!,
      })
    )?.prepared.reference,
  ).toBe(published.waveform);
  expect((await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one')).intents).toEqual(
    [],
  );
});

it('rejects duplicate consumers before uploads and destroys every owned stream', async () => {
  const item = await fixture();
  const options = item.options(['waveform', 'spectrogram']);
  const streams = [Readable.from(['one']), Readable.from(['two'])];
  options.artifacts = options.artifacts.map((artifact, index) => ({
    ...artifact,
    body: streams[index]!,
    consumers: () => [{ consumer: 'episode:one:duplicate', previousReference: null }],
  }));
  await expect(writeReferenceSet(options)).rejects.toThrow('consumers must be distinct');
  expect(streams.every((stream) => stream.destroyed)).toBe(true);
  expect(item.objects.size).toBe(0);
  expect((await new StorageWriteJournal(item.executor, 'sqlite', 'app').list('episode:one')).intents).toEqual(
    [],
  );
});
