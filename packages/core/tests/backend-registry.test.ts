import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareStorageBackend, StorageBackendRegistry } from '../src/storage/backend-registry';
import { storageBackendBinding } from '../src/storage/references';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
const descriptor = { kind: 'object' as const, location, binding: storageBackendBinding(location) };
function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  return { database, executor, registry: new StorageBackendRegistry(executor, 'sqlite', 'app') };
}

describe('immutable storage backend registry', () => {
  it('deduplicates canonical defaults and isolates application namespaces', async () => {
    const { registry, executor } = fixture();
    const prepared = prepareStorageBackend('app', descriptor);
    expect(
      prepareStorageBackend('app', { ...descriptor, publicUrl: null, referenceEncoding: 'raw' }),
    ).toEqual(prepared);
    await registry.register(prepared);
    await registry.register(prepared);
    expect(await registry.get(prepared.id)).toEqual(prepared);
    expect(await new StorageBackendRegistry(executor, 'sqlite', 'other').get(prepared.id)).toBeNull();
  });

  it('retains historical alias and encoding snapshots without changing physical identity', async () => {
    const { registry } = fixture();
    const raw = prepareStorageBackend('app', {
      ...descriptor,
      publicUrl: 'https://old.example/media',
      referenceEncoding: 'raw',
    });
    const encoded = prepareStorageBackend('app', {
      ...descriptor,
      publicUrl: 'https://new.example/media',
      referenceEncoding: 'percent',
    });
    expect(raw.binding).toBe(encoded.binding);
    expect(raw.id).not.toBe(encoded.id);
    await registry.register(raw);
    await registry.register(encoded);
    expect(await registry.get(raw.id)).toEqual(raw);
    expect(await registry.get(encoded.id)).toEqual(encoded);
    await expect(registry.register({ ...raw, descriptor: encoded.descriptor })).rejects.toThrow(
      'identity mismatch',
    );
    expect(await registry.get(raw.id)).toEqual(raw);
  });

  it('rolls back registration with the caller transaction and rejects corrupted identity', async () => {
    const { database, registry } = fixture();
    const prepared = prepareStorageBackend('app', descriptor);
    database.exec('BEGIN IMMEDIATE');
    await registry.register(prepared);
    database.exec('ROLLBACK');
    expect(await registry.get(prepared.id)).toBeNull();
    await registry.register(prepared);
    database
      .prepare('UPDATE SidedoorState SET state = ?')
      .run(JSON.stringify({ ...prepared, namespace: 'other' }));
    await expect(registry.get(prepared.id)).rejects.toThrow('identity mismatch');
  });

  it('preserves a captured local alias without accessing the current filesystem', () => {
    const root = '/private/var/old-storage';
    const local = {
      kind: 'local' as const,
      identity: { root, device: '1', inode: '123', binding: storageBackendBinding({ kind: 'local', root }) },
      referenceRoot: '/var/old-storage',
    };
    expect(prepareStorageBackend('app', local).descriptor).toEqual(local);
    expect(() => prepareStorageBackend('app', { ...local, referenceRoot: '/var/../other' })).toThrow();
    expect(() =>
      prepareStorageBackend('app', { ...local, identity: { ...local.identity, inode: '0123' } }),
    ).toThrow();
  });

  it('rejects secrets, ambiguous aliases and mismatched physical bindings with sanitized diagnostics', () => {
    const invalid = [
      { ...descriptor, location: { ...location, endpoint: 'https://user:private-secret@storage.example' } },
      { ...descriptor, publicUrl: 'https://cdn.example/media?token=private-secret' },
      { ...descriptor, publicUrl: 'https://cdn.example/media/../private' },
      { ...descriptor, binding: 'f'.repeat(64) },
    ];
    for (const value of invalid) {
      expect(() => prepareStorageBackend('app', value)).toThrow();
      try {
        prepareStorageBackend('app', value);
      } catch (error) {
        expect(String(error)).not.toContain('private-secret');
      }
    }
  });
});
