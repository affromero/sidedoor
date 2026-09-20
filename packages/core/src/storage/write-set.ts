import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  StorageBackendRegistry,
  prepareStorageBackend,
  type StorageCleanupDescriptor,
} from './backend-registry';
import { StorageInstanceControl } from './instance';
import { LocalStorageWriteError } from './local-writer';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
  prepareStorageReferenceClaims,
  type PreparedStorageReference,
} from './reference-registry';
import { validateStorageKey } from './references';
import { StorageWriteJournal, prepareStorageWrite } from './write-journal';
import type { SqlExecutor } from './sql';
import { withOwnedReadables } from './owned-readable';

const errorBrand = Symbol.for('thesidedoor.storage.reference-set.error');
export class ReferenceSetError extends Error {
  readonly [errorBrand] = true;
  constructor(
    readonly code: 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
export function isReferenceSetError(error: unknown): error is ReferenceSetError {
  return error instanceof Error && (error as Error & { [errorBrand]?: unknown })[errorBrand] === true;
}

export interface ReferenceSetAdmission<Snapshot> {
  readonly instanceId: string;
  readonly scopes: ReadonlyArray<{ readonly subjectId: string; readonly generation: number }>;
  readonly snapshot: Snapshot;
}
export interface ReferenceSetWriter {
  readonly descriptor: StorageCleanupDescriptor;
  readonly localRoutePrefix?: string;
  /** The port must address the captured descriptor. A rejected remote request remains uncertain. */
  write(key: string, body: Uint8Array | Readable, contentType: string, signal: AbortSignal): Promise<string>;
}
export interface ReferenceSetArtifact<Snapshot> {
  readonly name: string;
  readonly prefix: string;
  readonly extension: string;
  readonly contentType: string;
  readonly body: Uint8Array | Readable;
  captureWriter(): Promise<ReferenceSetWriter>;
  consumers(snapshot: Snapshot): ReadonlyArray<{ consumer: string; previousReference: string | null }>;
}
export interface ReferenceSetOptions<Transaction, Snapshot> {
  namespace: string;
  dialect: 'postgres' | 'sqlite';
  signal: AbortSignal;
  artifacts: readonly ReferenceSetArtifact<Snapshot>[];
  /** Each invocation owns a fresh Serializable transaction, retrying only its callback. */
  transaction<Result>(operation: (tx: Transaction) => Promise<Result>): Promise<Result>;
  executor(tx: Transaction): SqlExecutor;
  captureAdmission(tx: Transaction): Promise<ReferenceSetAdmission<Snapshot>>;
  /** Recovery must prove all resulting URLs and retire-only application changes. */
  validateAdmission(
    tx: Transaction,
    admission: ReferenceSetAdmission<Snapshot>,
    published?: Readonly<Record<string, string>>,
  ): Promise<void>;
  retirements?(snapshot: Snapshot): ReadonlyArray<{ consumer: string; previousReference: string }>;
  /** Outside transaction retries, after a confirmed upload and before any publication. */
  verifyArtifact?(
    artifact: {
      name: string;
      operationId: string;
      reference: string;
      target: PreparedStorageReference['target'];
      descriptor: StorageCleanupDescriptor;
    },
    signal: AbortSignal,
  ): Promise<void>;
  commit(tx: Transaction, published: Readonly<Record<string, string>>, snapshot: Snapshot): Promise<void>;
}

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const scope = z
  .object({
    subjectId: z.string().min(1).max(200),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Own all streams from entry. Publish distinct assets and retirements in one reference transaction. */
export async function writeReferenceSet<Transaction, Snapshot>(
  options: ReferenceSetOptions<Transaction, Snapshot>,
): Promise<Readonly<Record<string, string>>> {
  const streams = options.artifacts
    .map((artifact) => artifact.body)
    .filter((body): body is Readable => body instanceof Readable);
  return withOwnedReadables(streams, () => writeOwnedReferenceSet(options));
}

async function writeOwnedReferenceSet<Transaction, Snapshot>(
  options: ReferenceSetOptions<Transaction, Snapshot>,
): Promise<Readonly<Record<string, string>>> {
  const verifyArtifact = options.verifyArtifact;
  try {
    z.string().min(1).max(200).parse(options.namespace);
    if (options.artifacts.length < 1 || options.artifacts.length > 10)
      throw new ReferenceSetError('invalid', 'A storage reference set requires between 1 and 10 artifacts');
    const artifacts = options.artifacts.map((artifact) => {
      name.parse(artifact.name);
      validateStorageKey(artifact.prefix);
      if (
        !/^[a-z0-9]{1,12}$/.test(artifact.extension) ||
        !artifact.contentType.trim() ||
        artifact.contentType.length > 200
      )
        throw new ReferenceSetError('invalid', 'Invalid storage artifact metadata');
      return { ...artifact, operationId: randomUUID() };
    });
    if (new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length)
      throw new ReferenceSetError('invalid', 'Storage artifact names must be distinct');
    const streams = artifacts.map((artifact) => artifact.body).filter((body) => body instanceof Readable);
    if (new Set(streams).size !== streams.length)
      throw new ReferenceSetError('invalid', 'Each storage artifact must own a distinct stream');
    options.signal.throwIfAborted();
    const instance = (tx: Transaction) =>
      new StorageInstanceControl(options.executor(tx), options.dialect, options.namespace);
    const writes = (tx: Transaction) =>
      new StorageWriteJournal(options.executor(tx), options.dialect, options.namespace);
    const captured = await options.transaction(async (tx) => {
      const admission = structuredClone(await options.captureAdmission(tx));
      const current = await instance(tx).read();
      const scopes = z.array(scope).min(2).max(1000).parse(admission.scopes);
      if (
        admission.instanceId !== current.instanceId ||
        new Set(scopes.map((item) => item.subjectId)).size !== scopes.length ||
        !scopes.some((item) => item.subjectId === current.subjectId && item.generation === current.generation)
      )
        throw new ReferenceSetError('conflict', 'Storage admission does not match the current instance');
      return admission;
    });
    const claims = artifacts.map((artifact) =>
      prepareStorageReferenceClaims(artifact.consumers(structuredClone(captured.snapshot))),
    );
    const retirements = z
      .array(
        z
          .object({ consumer: z.string().min(1).max(200), previousReference: z.string().min(1).max(8192) })
          .strict(),
      )
      .max(100)
      .parse(options.retirements?.(structuredClone(captured.snapshot)) ?? [])
      .map((entry) => ({ ...entry, operationId: randomUUID() }));
    const consumers = [
      ...claims.flatMap((group) => group.map((entry) => entry.consumer)),
      ...retirements.map((entry) => entry.consumer),
    ];
    if (new Set(consumers).size !== consumers.length)
      throw new ReferenceSetError(
        'invalid',
        'Storage consumers must be distinct across replacements and retirements',
      );
    if (consumers.some((consumer) => !consumer.trim()))
      throw new ReferenceSetError('conflict', 'Storage consumers cannot be blank');
    const prepared: Array<{
      artifact: ReferenceSetArtifact<Snapshot> & { operationId: string };
      writer: ReferenceSetWriter;
      backend: ReturnType<typeof prepareStorageBackend>;
      key: string;
      intents: Array<ReturnType<typeof prepareStorageWrite>>;
      consumers: ReturnType<typeof prepareStorageReferenceClaims>;
    }> = [];
    for (const [index, artifact] of artifacts.entries()) {
      options.signal.throwIfAborted();
      const writer = await artifact.captureWriter();
      const backend = prepareStorageBackend(options.namespace, writer.descriptor);
      const key = `${artifact.prefix}/${captured.instanceId}/${artifact.operationId}.${artifact.extension}`;
      const intents = captured.scopes.map((item) =>
        prepareStorageWrite({
          namespace: options.namespace,
          ...item,
          target: { backendId: backend.id, binding: backend.binding, key },
        }),
      );
      prepared.push({ artifact, writer, backend, key, intents, consumers: claims[index]! });
    }
    async function validate(tx: Transaction, published?: Readonly<Record<string, string>>) {
      if (!published) options.signal.throwIfAborted();
      await options.validateAdmission(
        tx,
        structuredClone(captured),
        published && Object.freeze({ ...published }),
      );
      if (!published) options.signal.throwIfAborted();
      if ((await instance(tx).read()).instanceId !== captured.instanceId)
        throw new ReferenceSetError('conflict', 'Storage instance changed during upload');
      for (const item of prepared)
        for (const intent of item.intents) await writes(tx).assertWritable(intent, intent.generation);
      if (!published) options.signal.throwIfAborted();
    }
    await options.transaction(async (tx) => {
      const registry = new StorageBackendRegistry(options.executor(tx), options.dialect, options.namespace);
      for (const item of prepared) await registry.register(item.backend);
      await validate(tx);
      for (const item of prepared)
        for (const intent of item.intents)
          if ((await writes(tx).begin(intent, intent.generation)) !== 'created')
            throw new ReferenceSetError('conflict', 'Storage artifact operation has already started');
    });
    const urls: Record<string, string> = {};
    for (const [index, item] of prepared.entries()) {
      try {
        options.signal.throwIfAborted();
      } catch (error) {
        await settle(index, 'not_created', error);
        throw error;
      }
      try {
        urls[item.artifact.name] = await item.writer.write(
          item.key,
          item.artifact.body,
          item.artifact.contentType,
          options.signal,
        );
      } catch (error) {
        const outcome =
          item.backend.descriptor.kind === 'local' && error instanceof LocalStorageWriteError
            ? error.created
              ? 'unreferenced'
              : 'not_created'
            : 'uncertain';
        await settle(index, outcome, error);
        throw error;
      }
      if (verifyArtifact) {
        try {
          options.signal.throwIfAborted();
          await verifyArtifact(
            structuredClone({
              name: item.artifact.name,
              operationId: item.artifact.operationId,
              reference: urls[item.artifact.name]!,
              target: { backendId: item.backend.id, binding: item.backend.binding, key: item.key },
              descriptor: item.backend.descriptor,
            }),
            options.signal,
          );
          options.signal.throwIfAborted();
        } catch (error) {
          await settle(index, 'unreferenced', error);
          throw error;
        }
      }
    }
    async function settle(
      failedIndex: number,
      failedOutcome: 'unreferenced' | 'not_created' | 'uncertain',
      originalError: unknown,
    ) {
      await options
        .transaction(async (tx) => {
          for (const [index, item] of prepared.entries()) {
            const kind =
              index < failedIndex ? 'unreferenced' : index === failedIndex ? failedOutcome : 'not_created';
            for (const intent of item.intents) await writes(tx).finish(intent, { kind });
          }
        })
        .catch((settlementError: unknown) => {
          throw new AggregateError(
            [originalError, settlementError],
            'Storage failure settlement could not commit',
            { cause: originalError },
          );
        });
    }
    const published = Object.freeze({ ...urls });
    try {
      await options.transaction(async (tx) => {
        await validate(tx);
        const registry = new StorageReferenceRegistry(
          options.executor(tx),
          options.dialect,
          options.namespace,
        );
        for (const item of prepared) {
          const reference = prepareStorageReference({
            namespace: options.namespace,
            operationId: item.artifact.operationId,
            reference: published[item.artifact.name]!,
            ...(item.writer.localRoutePrefix ? { localRoutePrefix: item.writer.localRoutePrefix } : {}),
            target: { backendId: item.backend.id, binding: item.backend.binding, key: item.key },
            scopes: [...captured.scopes],
          });
          await registry.replaceMany({ consumers: item.consumers, next: reference });
        }
        for (const retirement of retirements) await registry.retire(retirement);
        options.signal.throwIfAborted();
        await options.commit(tx, published, structuredClone(captured.snapshot));
        options.signal.throwIfAborted();
        for (const item of prepared)
          for (const intent of item.intents)
            if (
              (await writes(tx).finish(intent, {
                kind: 'referenced',
                currentGeneration: intent.generation,
              })) !== 'removed'
            )
              throw new ReferenceSetError('conflict', 'Storage ownership changed during publication');
        options.signal.throwIfAborted();
      });
    } catch (error) {
      const committed = await options
        .transaction(async (tx) => {
          const receipts = [];
          for (const item of prepared)
            for (const intent of item.intents) receipts.push(await writes(tx).completion(intent));
          if (receipts.every((receipt) => receipt === 'referenced')) {
            await validate(tx, published);
            return true;
          }
          if (receipts.some((receipt) => receipt !== null))
            throw new Error('Storage set commit outcome is inconsistent');
          for (const item of prepared)
            for (const intent of item.intents) await writes(tx).finish(intent, { kind: 'unreferenced' });
          return false;
        })
        .catch((recoveryError: unknown) => {
          throw new AggregateError(
            [error, recoveryError],
            'Storage publication outcome could not be reconciled',
            { cause: error },
          );
        });
      if (!committed) throw error;
    }
    return published;
  } finally {
    for (const artifact of options.artifacts) if (artifact.body instanceof Readable) artifact.body.destroy();
  }
}
