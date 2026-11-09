import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  StorageBackendRegistry,
  prepareStorageBackend,
} from '../../../../src/storage/registry/backend-registry';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
} from '../../../../src/storage/registry/reference-registry';
import {
  StorageRelocationRegistry,
  type StorageRelocationInput,
} from '../../../../src/storage/local/relocation';
import { storageBackendBinding } from '../../../../src/storage/registry/references';
import { StorageWriteJournal } from '../../../../src/storage/execution/write-journal';
import { StorageCleanupJournal } from '../../../../src/storage/cleanup/cleanup-journal';
import { prepareStorageCleanup } from '../../../../src/storage/cleanup/cleanup-state';
import { StorageCleanupAttribution } from '../../../../src/storage/cleanup/cleanup-attribution';

const databases: DatabaseSync[] = [];
export function closeRelocationFixtures() {
  for (const database of databases.splice(0)) database.close();
}
export function fixture(afterQuery?: (values: readonly unknown[], rows: readonly unknown[]) => void) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      const rows = database.prepare(sql).all(...(values as SQLInputValue[]));
      afterQuery?.(values, rows);
      return rows;
    },
  };
  const registry = new StorageReferenceRegistry(executor, 'sqlite', 'test');
  const relocations = new StorageRelocationRegistry(executor, 'sqlite', 'test');
  const writes = new StorageWriteJournal(executor, 'sqlite', 'test');
  const cleanup = new StorageCleanupJournal(executor, 'sqlite', 'test');
  const classifier = new StorageCleanupAttribution(executor, 'sqlite', 'test');
  async function transaction<Result>(run: () => Promise<Result>) {
    database.exec('BEGIN');
    try {
      const result = await run();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  async function asset(
    consumers = ['owner:avatar'],
    previous: string | null = null,
    scopes = [{ subjectId: 'profile:owner', generation: 1 }],
  ) {
    const operationId = randomUUID();
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: operationId };
    const backend = prepareStorageBackend('test', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
      publicUrl: `https://media.example/${operationId}`,
    });
    const prepared = prepareStorageReference({
      namespace: 'test',
      operationId,
      reference: `https://media.example/${operationId}/image.png`,
      target: { backendId: backend.id, binding: backend.binding, key: 'image.png' },
      scopes,
    });
    await transaction(async () => {
      await new StorageBackendRegistry(executor, 'sqlite', 'test').register(backend);
      await registry.replaceMany({
        next: prepared,
        consumers: consumers.map((consumer) => ({ consumer, previousReference: previous })),
      });
    });
    const retained = await registry.readReference(prepared.reference);
    return { id: retained!.asset.id, prepared };
  }
  function proof(
    source: Awaited<ReturnType<typeof asset>>,
    destination: Awaited<ReturnType<typeof asset>>,
    consumers = ['owner:avatar'],
  ): StorageRelocationInput {
    const content = { sha256: createHash('sha256').update('verified copy').digest('hex'), bytes: 13 };
    return {
      operationId: destination.prepared.operationId,
      sourceAssetId: source.id,
      destinationAssetId: destination.id,
      consumers,
      sourceRead: { assetId: source.id, ...content },
      destinationRead: { assetId: destination.id, ...content },
    };
  }
  async function pair() {
    const source = await asset();
    const destination = await asset(undefined, source.prepared.reference);
    return { source, destination, evidence: proof(source, destination) };
  }
  async function erasure() {
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'profile:owner',
      generation: 1,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await transaction(() => cleanup.createJob(job));
    return { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch };
  }
  return {
    database,
    executor,
    registry,
    relocations,
    writes,
    cleanup,
    classifier,
    erasure,
    transaction,
    asset,
    proof,
    pair,
  };
}
