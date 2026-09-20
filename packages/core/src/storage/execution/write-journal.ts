import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sqlStateBackend, type SqlExecutor } from '../sql/sql';
import { validateStorageKey } from '../registry/references';
import { StorageBackendRegistry } from '../registry/backend-registry';

const identity = z.string().min(1).max(200);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const targetSchema = z
  .object({
    backendId: z.string().regex(/^[a-f0-9]{64}$/),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    key: z.string().transform(validateStorageKey),
  })
  .strict();
const evidenceSchema = z
  .object({ kind: z.enum(['observed_io_completion', 'stopped_writer']), id: identity })
  .strict();
const intentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('write'),
    namespace: identity,
    subjectId: identity,
    generation,
    operationId: z.uuid(),
    createdAt: generation,
    target: targetSchema,
    status: z.enum(['active', 'settled', 'uncertain']),
    outcome: z.enum(['referenced', 'unreferenced', 'uncertain']).optional(),
    resolution: evidenceSchema.optional(),
  })
  .strict()
  .refine((value) =>
    value.status === 'active'
      ? value.outcome === undefined && value.resolution === undefined
      : value.status === 'uncertain'
        ? value.outcome === 'uncertain' && value.resolution === undefined
        : (value.outcome === 'referenced' || value.outcome === 'unreferenced') &&
          (!value.resolution || value.outcome === 'unreferenced'),
  );
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('write_receipt'),
    outcome: z.enum(['referenced', 'not_created']).default('referenced'),
    namespace: identity,
    subjectId: identity,
    generation,
    operationId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const tombstoneSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('tombstone'),
    namespace: identity,
    subjectId: identity,
    generation,
    jobId: z.uuid(),
    createdAt: generation,
  })
  .strict();

export type StorageWriteIntent = z.infer<typeof intentSchema>;
export type StorageSubjectTombstone = z.infer<typeof tombstoneSchema>;

/** Prepare once before a retryable transaction. The binding must reference a persisted backend descriptor. */
export function prepareStorageWrite(input: {
  namespace: string;
  subjectId: string;
  generation: number;
  target: { backendId: string; binding: string; key: string };
}): StorageWriteIntent {
  return intentSchema.parse({
    ...input,
    schemaVersion: 1,
    kind: 'write',
    operationId: randomUUID(),
    createdAt: Date.now(),
    status: 'active',
  });
}

/** Subject IDs are never reused after erasure, including at a later generation. */
export function prepareStorageTombstone(input: {
  namespace: string;
  subjectId: string;
  generation: number;
  jobId: string;
}): StorageSubjectTombstone {
  return tombstoneSchema.parse({ ...input, schemaVersion: 1, kind: 'tombstone', createdAt: Date.now() });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameIntent(left: StorageWriteIntent, right: StorageWriteIntent): boolean {
  return (
    left.namespace === right.namespace &&
    left.subjectId === right.subjectId &&
    left.generation === right.generation &&
    left.operationId === right.operationId &&
    left.createdAt === right.createdAt &&
    left.target.backendId === right.target.backendId &&
    left.target.binding === right.target.binding &&
    left.target.key === right.target.key
  );
}

function intentDigest(intent: StorageWriteIntent): string {
  return hash(
    JSON.stringify([
      intent.namespace,
      intent.subjectId,
      intent.generation,
      intent.operationId,
      intent.createdAt,
      intent.target.backendId,
      intent.target.binding,
      intent.target.key,
    ]),
  );
}

/**
 * Every method runs in the caller's Serializable transaction. The caller must validate
 * live subject authority/generation in that same transaction. No storage I/O belongs here.
 * PostgreSQL installations need the documented pattern index for bounded prefix scans.
 */
export class StorageWriteJournal {
  private readonly namespaceHash: string;
  private readonly backendBindings = new Map<string, string>();
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    identity.parse(namespace);
    this.namespaceHash = hash(namespace);
  }

  private parameter(index: number): string {
    return this.dialect === 'postgres' ? `$${index}` : '?';
  }
  private tombstoneId(subjectId: string): string {
    return `sd-t:1:${this.namespaceHash}:${hash(subjectId)}`;
  }
  private writePrefix(subjectId: string): string {
    return `sd-w:1:${this.namespaceHash}:${hash(subjectId)}:`;
  }
  private writeId(intent: StorageWriteIntent): string {
    return `${this.writePrefix(intent.subjectId)}${intent.operationId}`;
  }
  private receiptId(intent: StorageWriteIntent): string {
    return `sd-r:1:${this.namespaceHash}:${hash(intent.subjectId)}:${intent.operationId}`;
  }
  private async readReceipt(intent: StorageWriteIntent): Promise<z.infer<typeof receiptSchema> | null> {
    const record = await this.backend(this.receiptId(intent)).read();
    if (!record) return null;
    const receipt = receiptSchema.parse(record.state);
    if (
      receipt.namespace !== intent.namespace ||
      receipt.subjectId !== intent.subjectId ||
      receipt.generation !== intent.generation ||
      receipt.operationId !== intent.operationId ||
      receipt.digest !== intentDigest(intent)
    )
      throw new Error('Storage operation identity was already used');
    return receipt;
  }

  /** Read in the caller's transaction when reconciling an unknown reference commit. */
  async completion(prepared: StorageWriteIntent): Promise<'referenced' | 'not_created' | null> {
    const intent = this.validateIntent(prepared);
    await this.validateTarget(intent);
    return (await this.readReceipt(intent))?.outcome ?? null;
  }
  private backend(id: string) {
    return sqlStateBackend(this.database, this.dialect, id);
  }

  private validateIntent(value: StorageWriteIntent): StorageWriteIntent {
    const intent = intentSchema.parse(value);
    if (intent.namespace !== this.namespace) throw new Error('Storage journal namespace mismatch');
    return intent;
  }

  private async validateTarget(intent: StorageWriteIntent): Promise<void> {
    let binding = this.backendBindings.get(intent.target.backendId);
    if (!binding) {
      const registration = await new StorageBackendRegistry(this.database, this.dialect, this.namespace).get(
        intent.target.backendId,
      );
      if (!registration) throw new Error('Storage backend descriptor is missing');
      binding = registration.binding;
      this.backendBindings.set(intent.target.backendId, binding);
    }
    if (binding !== intent.target.binding)
      throw new Error('Storage target does not match its backend descriptor');
  }

  async tombstone(subjectId: string): Promise<StorageSubjectTombstone | null> {
    identity.parse(subjectId);
    const record = await this.backend(this.tombstoneId(subjectId)).read();
    if (!record) return null;
    const value = tombstoneSchema.parse(record.state);
    if (value.namespace !== this.namespace || value.subjectId !== subjectId)
      throw new Error('Storage tombstone identity mismatch');
    return value;
  }

  async forbidWrites(prepared: StorageSubjectTombstone): Promise<void> {
    const value = tombstoneSchema.parse(prepared);
    if (value.namespace !== this.namespace) throw new Error('Storage journal namespace mismatch');
    const previous = await this.tombstone(value.subjectId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(value))
        throw new Error('Storage subject was already tombstoned');
      return;
    }
    if (
      !(await this.backend(this.tombstoneId(value.subjectId)).compareAndSwap(null, {
        revision: randomUUID(),
        state: value,
      }))
    )
      throw new Error('Storage tombstone changed concurrently');
  }

  /**
   * Check each scope before committing references in the same Serializable transaction.
   * This read-only check does not authorize I/O or replace begin's replay protection.
   * Callers still validate parent existence and ownership in that transaction.
   */
  async assertWritable(prepared: StorageWriteIntent, currentGeneration: number): Promise<void> {
    const intent = this.validateIntent(prepared);
    if (intent.status !== 'active' || intent.generation !== generation.parse(currentGeneration))
      throw new Error('Storage write generation is no longer current');
    if (await this.tombstone(intent.subjectId)) throw new Error('Storage subject is being erased');
    await this.validateTarget(intent);
  }

  async begin(
    prepared: StorageWriteIntent,
    currentGeneration: number,
  ): Promise<'created' | 'already_started' | 'already_completed'> {
    const intent = this.validateIntent(prepared);
    await this.assertWritable(intent, currentGeneration);
    if (await this.readReceipt(intent)) return 'already_completed';
    const backend = this.backend(this.writeId(intent));
    const previous = await backend.read();
    if (previous) {
      const existing = this.validateIntent(intentSchema.parse(previous.state));
      if (!sameIntent(existing, intent)) throw new Error('Storage operation identity was already used');
      return 'already_started';
    }
    if (!(await backend.compareAndSwap(null, { revision: randomUUID(), state: intent })))
      throw new Error('Storage operation changed concurrently');
    return 'created';
  }

  /**
   * Only an observed I/O outcome may settle a write, never a heartbeat timeout.
   * not_created requires proof the original admitted operation never created its
   * destination. A failed retry or an ambiguous remote response is insufficient.
   */
  async finish(
    prepared: StorageWriteIntent,
    outcome:
      | { kind: 'referenced'; currentGeneration: number }
      | { kind: 'unreferenced' | 'uncertain' | 'not_created' },
  ): Promise<'removed' | 'retained'> {
    const intent = this.validateIntent(prepared);
    await this.validateTarget(intent);
    if (outcome.kind === 'referenced' && generation.parse(outcome.currentGeneration) !== intent.generation)
      throw new Error('Storage write generation is no longer current');
    const id = this.writeId(intent);
    const backend = this.backend(id);
    const previous = await backend.read();
    if (!previous) {
      const receipt = await this.readReceipt(intent);
      if (receipt) {
        if (outcome.kind !== receipt.outcome)
          throw new Error('Storage completion conflicts with its recorded outcome');
        return 'removed';
      }
      throw new Error('Storage operation is missing');
    }
    const current = this.validateIntent(intentSchema.parse(previous.state));
    if (!sameIntent(current, intent)) throw new Error('Storage operation identity mismatch');
    if (current.status !== 'active') {
      if (current.outcome !== outcome.kind)
        throw new Error('Storage completion conflicts with its recorded outcome');
      return 'retained';
    }
    const tombstone = await this.tombstone(intent.subjectId);
    if (outcome.kind === 'not_created' || (outcome.kind === 'referenced' && !tombstone)) {
      const receipt = receiptSchema.parse({
        schemaVersion: 1,
        kind: 'write_receipt',
        outcome: outcome.kind,
        namespace: intent.namespace,
        subjectId: intent.subjectId,
        generation: intent.generation,
        operationId: intent.operationId,
        digest: intentDigest(intent),
      });
      if (
        !(await this.backend(this.receiptId(intent)).compareAndSwap(null, {
          revision: randomUUID(),
          state: receipt,
        }))
      )
        throw new Error('Storage completion changed concurrently');
      const rows = await this.database.query(
        `DELETE FROM "SidedoorState" WHERE "id" = ${this.parameter(1)} AND "revision" = ${this.parameter(2)} RETURNING "id"`,
        [id, previous.revision],
      );
      if (rows.length !== 1) throw new Error('Storage operation changed concurrently');
      return 'removed';
    }
    const next = {
      ...current,
      status: outcome.kind === 'uncertain' ? ('uncertain' as const) : ('settled' as const),
      outcome: outcome.kind,
    };
    if (!(await backend.compareAndSwap(previous.revision, { revision: randomUUID(), state: next })))
      throw new Error('Storage operation changed concurrently');
    return 'retained';
  }

  /** Caller must authorize and persist evidence of observed completion or a stopped writer. Never infer it from time. */
  async resolveUncertain(
    prepared: StorageWriteIntent,
    evidence: z.infer<typeof evidenceSchema>,
  ): Promise<void> {
    const intent = this.validateIntent(prepared);
    await this.validateTarget(intent);
    const resolution = evidenceSchema.parse(evidence);
    const backend = this.backend(this.writeId(intent));
    const previous = await backend.read();
    if (!previous) throw new Error('Storage operation is missing');
    const current = this.validateIntent(intentSchema.parse(previous.state));
    if (!sameIntent(current, intent)) throw new Error('Storage operation identity mismatch');
    if (
      current.status === 'settled' &&
      current.resolution?.kind === resolution.kind &&
      current.resolution.id === resolution.id
    )
      return;
    if (current.status !== 'uncertain') throw new Error('Storage operation is not awaiting resolution');
    const next = intentSchema.parse({ ...current, status: 'settled', outcome: 'unreferenced', resolution });
    if (!(await backend.compareAndSwap(previous.revision, { revision: randomUUID(), state: next })))
      throw new Error('Storage resolution changed concurrently');
  }

  async list(
    subjectId: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<{
    intents: StorageWriteIntent[];
    cursor: string | null;
  }> {
    identity.parse(subjectId);
    const prefix = this.writePrefix(subjectId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(options.limit ?? 100);
    const after = options.after ?? '';
    if (after && (!after.startsWith(prefix) || !z.uuid().safeParse(after.slice(prefix.length)).success))
      throw new Error('Storage journal cursor belongs to another subject');
    const operators =
      this.dialect === 'postgres'
        ? { lower: '~>=~', upper: '~<~', after: '~>~', order: ' USING ~<~' }
        : { lower: '>=', upper: '<', after: '>', order: '' };
    // Prefixes end with ':'. Its ASCII successor bounds the entire subject range.
    const upper = `${prefix.slice(0, -1)};`;
    const rows = await this.database.query(
      `SELECT "id", "state" FROM "SidedoorState" WHERE "id" ${operators.lower} ${this.parameter(1)} AND "id" ${operators.upper} ${this.parameter(2)} AND "id" ${operators.after} ${this.parameter(3)} ORDER BY "id"${operators.order} LIMIT ${this.parameter(4)}`,
      [prefix, upper, after, limit],
    );
    const intents = rows.map((row) => {
      const intent = this.validateIntent(
        intentSchema.parse(
          this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
        ),
      );
      if (intent.subjectId !== subjectId || row.id !== this.writeId(intent))
        throw new Error('Storage journal record identity mismatch');
      return intent;
    });
    for (const intent of intents) await this.validateTarget(intent);
    return { intents, cursor: rows.length === limit ? String(rows.at(-1)!.id) : null };
  }
}
