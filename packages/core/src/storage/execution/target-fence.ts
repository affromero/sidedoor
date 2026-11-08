import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateStorageKey } from '../registry/references';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../sql/sql';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.discriminatedUnion('status', [
  z.object({ kind: z.literal('storage_target_fence'), target: digest, status: z.literal('open') }).strict(),
  z
    .object({
      kind: z.literal('storage_target_fence'),
      target: digest,
      status: z.literal('retired'),
      retirement: digest,
    })
    .strict(),
]);

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * All methods require the caller's Serializable transaction. The key is global to
 * this database so namespaces sharing a physical backend cannot bypass the fence.
 */
export class StorageTargetFence {
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
  ) {}

  private target(input: { binding: string; key: string }) {
    return hash(JSON.stringify([digest.parse(input.binding), validateStorageKey(input.key)]));
  }

  private decode(value: unknown) {
    return this.dialect === 'sqlite' && typeof value === 'string' ? JSON.parse(value) : value;
  }

  private async requireDrained(target: string) {
    const { storageWriteIntentSchema } = await import('./write-journal');
    const { storageAssetSchema } = await import('../registry/reference-registry');
    let after: string | null = null;
    do {
      const rows = await sqlStateRows(this.database, this.dialect, 'sd-w:1:', after, 100, 'writeIntent');
      for (const row of rows) {
        const intent = storageWriteIntentSchema.parse(this.decode(row.state));
        const expected = `sd-w:1:${hash(intent.namespace)}:${hash(intent.subjectId)}:${intent.operationId}`;
        if (row.id !== expected) throw new Error('Storage write identity mismatch');
        if (this.target(intent.target) === target) throw new Error('Storage target has retained writes');
      }
      after = rows.length === 100 ? String(rows.at(-1)!.id) : null;
    } while (after);
    after = null;
    do {
      const rows = await sqlStateRows(
        this.database,
        this.dialect,
        'sd-asset:1:',
        after,
        100,
        'compoundDigest',
      );
      for (const row of rows) {
        const asset = storageAssetSchema.parse(this.decode(row.state));
        if (
          row.id !== `sd-asset:1:${hash(asset.prepared.namespace)}:${asset.id}` ||
          asset.id !== this.target(asset.prepared.target)
        )
          throw new Error('Storage asset identity mismatch');
        if (asset.id === target && asset.consumers.length)
          throw new Error('Storage target has live consumers');
      }
      after = rows.length === 100 ? String(rows.at(-1)!.id) : null;
    } while (after);
  }

  /** Serialize a new writer or reference allocation against target retirement. */
  async admit(input: { binding: string; key: string }): Promise<void> {
    const target = this.target(input);
    const backend = sqlStateBackend(this.database, this.dialect, `sd-tf:1:${target}`);
    const row = await backend.read();
    if (row) {
      const state = stateSchema.parse(row.state);
      if (state.target !== target) throw new Error('Storage target fence identity mismatch');
      if (state.status === 'retired') throw new Error('Storage target is retired');
    }
    if (
      !(await backend.compareAndSwap(row?.revision ?? null, {
        revision: randomUUID(),
        state: { kind: 'storage_target_fence', target, status: 'open' },
      }))
    )
      throw new Error('Storage target fence changed concurrently');
  }

  async requireRetired(input: { binding: string; key: string; retirementId: string }): Promise<void> {
    const target = this.target(input);
    const retirement = hash(z.uuid().parse(input.retirementId));
    const row = await sqlStateBackend(this.database, this.dialect, `sd-tf:1:${target}`).read();
    if (!row) throw new Error('Storage target retirement is missing');
    const state = stateSchema.parse(row.state);
    if (state.target !== target || state.status !== 'retired' || state.retirement !== retirement)
      throw new Error('Storage target retirement mismatch');
  }

  /** Caller must fence queued work and use a Serializable transaction before deletion. */
  async retire(input: { binding: string; key: string; retirementId: string }): Promise<void> {
    const target = this.target(input);
    const retirement = hash(z.uuid().parse(input.retirementId));
    const backend = sqlStateBackend(this.database, this.dialect, `sd-tf:1:${target}`);
    const row = await backend.read();
    if (row) {
      const state = stateSchema.parse(row.state);
      if (state.target !== target) throw new Error('Storage target fence identity mismatch');
      if (state.status === 'retired') {
        if (state.retirement !== retirement) throw new Error('Storage target was already retired');
        return;
      }
    }
    await this.requireDrained(target);
    if (
      !(await backend.compareAndSwap(row?.revision ?? null, {
        revision: randomUUID(),
        state: { kind: 'storage_target_fence', target, status: 'retired', retirement },
      }))
    )
      throw new Error('Storage target fence changed concurrently');
  }
}
