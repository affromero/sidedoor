import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../process/json';
import { sqlStateBackend, type SqlExecutor } from '../../storage/sql/sql';

const identity = z.string().min(1).max(200);
const metadataSchema = z
  .object({
    kind: z.literal('snapshot'),
    binding: identity,
    pages: z.number().int().nonnegative().safe(),
    sealed: z.boolean(),
    erasureCursor: z.number().int().nonnegative().safe().optional(),
    erased: z.boolean().optional(),
  })
  .strict();
const pageSchema = z
  .object({
    kind: z.literal('snapshot_page'),
    binding: identity,
    index: z.number().int().nonnegative().safe(),
    items: z.array(z.json()).min(1).max(100),
  })
  .strict();

/** Immutable bounded pages. All writes belong to the caller's atomic transaction. */
export class JobSnapshot {
  private readonly prefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    namespace: string,
  ) {
    this.prefix = `sd-js:1:${createHash('sha256').update(identity.parse(namespace)).digest('hex')}:`;
  }
  private backend(id: string, page?: number) {
    const suffix = page === undefined ? 'meta' : String(z.number().int().nonnegative().safe().parse(page));
    return sqlStateBackend(this.database, this.dialect, `${this.prefix}${z.uuid().parse(id)}:${suffix}`);
  }
  private async metadata(id: string, binding: string) {
    identity.parse(binding);
    const row = await this.backend(id).read();
    if (!row) throw new Error('Snapshot is missing');
    const state = metadataSchema.parse(row.state);
    if (state.binding !== binding) throw new Error('Snapshot binding mismatch');
    if ((state.erasureCursor ?? 0) > state.pages || (state.erased && state.pages !== 0))
      throw new Error('Snapshot erasure cursor is invalid');
    return { row, state };
  }
  async create(id: string, binding: string): Promise<void> {
    const backend = this.backend(id);
    const state = metadataSchema.parse({ kind: 'snapshot', binding, pages: 0, sealed: false });
    if (!(await backend.compareAndSwap(null, { revision: randomUUID(), state })))
      throw new Error('Snapshot identity already exists');
  }
  /** The retention policy fixes snapshot identity to its owning job, with no independent ID. */
  async createForJob(job: { id: string; fingerprint: string }): Promise<void> {
    const owner = z
      .object({ id: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(job);
    await this.create(owner.id, owner.fingerprint);
  }
  async append(id: string, binding: string, index: number, items: readonly unknown[]): Promise<void> {
    const page = pageSchema.parse({ kind: 'snapshot_page', binding, index, items });
    if (Buffer.byteLength(canonicalJson(page)) > 1_048_576) throw new Error('Snapshot page exceeds one MiB');
    const { row, state } = await this.metadata(id, binding);
    if (state.erasureCursor !== undefined || state.erased) throw new Error('Snapshot is being erased');
    if (state.sealed || state.pages !== index) throw new Error('Snapshot page is not the next writable page');
    if (!(await this.backend(id, index).compareAndSwap(null, { revision: randomUUID(), state: page })))
      throw new Error('Snapshot page already exists');
    if (
      !(await this.backend(id).compareAndSwap(row.revision, {
        revision: randomUUID(),
        state: { ...state, pages: state.pages + 1 },
      }))
    )
      throw new Error('Concurrent snapshot append; retry the complete transaction');
  }
  async seal(id: string, binding: string): Promise<number> {
    const { row, state } = await this.metadata(id, binding);
    if (state.erasureCursor !== undefined || state.erased) throw new Error('Snapshot is being erased');
    if (
      !state.sealed &&
      !(await this.backend(id).compareAndSwap(row.revision, {
        revision: randomUUID(),
        state: { ...state, sealed: true },
      }))
    )
      throw new Error('Concurrent snapshot seal; retry the complete transaction');
    return state.pages;
  }
  async read(id: string, binding: string, index: number) {
    z.number().int().nonnegative().safe().parse(index);
    const { state } = await this.metadata(id, binding);
    if (state.erasureCursor !== undefined || state.erased) throw new Error('Snapshot is being erased');
    if (!state.sealed) throw new Error('Snapshot is not sealed');
    if (index >= state.pages) return { items: [], pages: state.pages, next: null };
    const row = await this.backend(id, index).read();
    if (!row) throw new Error('Sealed snapshot page is missing');
    const page = pageSchema.parse(row.state);
    if (Buffer.byteLength(canonicalJson(page)) > 1_048_576) throw new Error('Snapshot page exceeds one MiB');
    if (page.binding !== binding || page.index !== index) throw new Error('Snapshot page identity mismatch');
    return { items: page.items, pages: state.pages, next: index + 1 < state.pages ? index + 1 : null };
  }

  /**
   * Caller must prove authorization and exact parent binding before each transaction.
   * Deletes at most ten pages atomically with the cursor. Captured worker memory is not
   * revoked; workers must still recheck deletion admission before committing effects.
   */
  async eraseNext(id: string, binding: string): Promise<{ complete: boolean }> {
    identity.parse(binding);
    const backend = this.backend(id);
    if (!(await backend.read())) {
      if (
        !(await backend.compareAndSwap(null, {
          revision: randomUUID(),
          state: { kind: 'snapshot', binding, pages: 0, sealed: true, erasureCursor: 0, erased: true },
        }))
      )
        throw new Error('Concurrent snapshot creation; retry the complete transaction');
      return { complete: true };
    }
    const { row, state } = await this.metadata(id, binding);
    if (state.erased) return { complete: true };
    const end = Math.min(state.pages, (state.erasureCursor ?? 0) + 10);
    const p = this.dialect === 'postgres' ? '$1' : '?';
    for (let page = state.erasureCursor ?? 0; page < end; page++) {
      await this.database.query(`DELETE FROM "SidedoorState" WHERE "id" = ${p} RETURNING "id"`, [
        `${this.prefix}${z.uuid().parse(id)}:${page}`,
      ]);
    }
    const complete = end === state.pages;
    const next = complete
      ? { kind: 'snapshot' as const, binding, pages: 0, sealed: true, erasureCursor: 0, erased: true }
      : { ...state, erasureCursor: end };
    if (!(await this.backend(id).compareAndSwap(row.revision, { revision: randomUUID(), state: next })))
      throw new Error('Concurrent snapshot erasure; retry the complete transaction');
    return { complete };
  }
}
