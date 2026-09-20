import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
export { localEncryptionKey } from './registry/key';
export { StorageInstanceControl } from './sql/instance';
export { writeReferenceSet, ReferenceSetError, isReferenceSetError } from './execution/write-set';
export type {
  ReferenceSetAdmission,
  ReferenceSetWriter,
  ReferenceSetArtifact,
  ReferenceSetOptions,
} from './execution/write-set';
export {
  StorageReferenceRegistry,
  StorageReferenceConsumerMismatchError,
  prepareStorageReference,
  prepareStorageReferenceClaims,
} from './registry/reference-registry';
export type { PreparedStorageReference } from './registry/reference-registry';
export { StorageRelocationRegistry, type StorageRelocationInput } from './local/relocation';
export type { StorageInstanceScope } from './sql/instance';
export { LocalStorageCleanup } from './cleanup/backends/local-cleanup';
export { openExecutionLocation, type ExecutionLocation } from './execution/execution-location';
export {
  planExecutionWorkspace,
  createExecutionWorkspace,
  recoverExecutionWorkspace,
  removeExecutionWorkspace,
  type ExecutionWorkspacePlan,
  type ExecutionWorkspace,
} from './execution/execution-workspace';
export { LocalStorageReader } from './local/local-reader';
export {
  copyOwnedBytesToFile,
  StorageReadCleanupError,
  type OwnedByteReader,
  type StorageCopyContent,
} from './local/owned-copy';
export { copyOwnedReadableToFile, withOwnedReadables } from './local/owned-readable';
export { LocalStorageWriter, LocalStorageWriteError } from './local/local-writer';
export { StorageCleanupJournal } from './cleanup/cleanup-journal';
export { StorageCleanupAttribution } from './cleanup/cleanup-attribution';
export {
  openPostgresDedicatedConnection,
  PostgresConnectionCleanupError,
  type PostgresClientPort,
} from './sql/postgres-connection';
export {
  acquirePostgresBackendLock,
  type DedicatedBackendConnection,
  type BackendLock,
} from './registry/backend-lock';
export {
  CleanupExecutionJournal,
  type CleanupExecutionBinding,
  type CleanupExecutionRecord,
  type CleanupExecutionEvidence,
} from './cleanup/cleanup-execution';
export { cleanupStorageProbe, type ProbeCleanupOptions } from './cleanup/backends/probe-cleanup';
export {
  runStorageCleanup,
  type StorageCleanupBackendPort,
  type StorageCleanupCollectionPage,
  type StorageCleanupRunnerOptions,
} from './cleanup/cleanup-runner';
export { runStorageProbe, type StorageProbeOptions, type StorageProbePort } from './probe';
export { StorageProbeCleanupError } from './probe-errors';
export type { StorageManifestInput, StorageManifestResolution } from './cleanup/cleanup-manifests';
export {
  prepareStorageManifestPages,
  StorageManifestLimitError,
  isStorageManifestLimitError,
} from './cleanup/cleanup-manifests';
export { prepareStorageCleanup } from './cleanup/cleanup-state';
export type {
  StorageCleanupJob,
  StorageCleanupCollector,
  StorageCleanupCollectorRecord,
  StorageCleanupTarget,
  StorageCleanupTargetInput,
  StorageDeletionTicket,
} from './cleanup/cleanup-state';
export type { LocalCleanupIdentity } from './cleanup/backends/local-cleanup';
export {
  StorageBackendRegistry,
  prepareStorageBackend,
  storageCleanupDescriptorSchema,
} from './registry/backend-registry';
export type { PreparedStorageBackend, StorageCleanupDescriptor } from './registry/backend-registry';
export { ObjectStorageCleanup } from './cleanup/backends/object-cleanup';
export type { MultipartCleanupPort, MultipartCleanupPage } from './cleanup/backends/multipart-cleanup';
export type {
  ObjectCleanupPort,
  ObjectCleanupPage,
  ObjectVersionCleanupPage,
} from './cleanup/backends/object-cleanup';
export { StorageWriteJournal, prepareStorageWrite, prepareStorageTombstone } from './execution/write-journal';
export type { StorageWriteIntent, StorageSubjectTombstone } from './execution/write-journal';
export {
  normalizeStorageReference,
  validateStorageKey,
  storageBackendBinding,
  StorageReferenceError,
} from './registry/references';
export type { StorageBackendLocation, StorageReferenceOptions } from './registry/references';
import { dirname, resolve } from 'node:path';
import { withFileLock } from './registry/lock';
export {
  acquireFileLock,
  acquireFileLockSync,
  withFileLock,
  withSharedFileLockSync,
  FileLockBusyError,
} from './registry/lock';
export type { FileLockOptions } from './registry/lock';
export { syncDirectory } from './execution/durability';

/** Transactions serialize reads and writes; callbacks must be synchronous and side-effect free. */
export interface StateStore<State> {
  read(): Promise<State>;
  transact<Result>(operation: (state: State) => Result): Promise<Result>;
}

export interface FileStoreOptions<State> {
  path: string;
  initial: () => State;
  parse: (value: unknown) => State;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Files are authoritative. Invalid existing data always fails closed. */
export class FileStateStore<State> implements StateStore<State> {
  private readonly path: string;

  constructor(private readonly options: FileStoreOptions<State>) {
    this.path = resolve(options.path);
  }

  async read(): Promise<State> {
    try {
      return this.options.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (isMissing(error)) return this.options.parse(this.options.initial());
      throw error;
    }
  }

  async transact<Result>(operation: (state: State) => Result): Promise<Result> {
    return withFileLock(`${this.path}.guard`, async () => {
      const state = await this.read();
      const result = operation(state);
      if (result instanceof Promise) throw new Error('State transaction callbacks must be synchronous');
      const detachedResult = structuredClone(result);
      const encoded = JSON.stringify(this.options.parse(state));
      await this.persist(encoded);
      return detachedResult;
    });
  }

  private async persist(encoded: string): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(encoded);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
}
