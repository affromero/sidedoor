import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageCleanupJournal } from './cleanup-journal';
import { StorageBackendRegistry } from './backend-registry';
import { cleanupHash, type StorageDeletionTicket } from './cleanup-state';
import { sqlStateBackend, type SqlExecutor } from './sql';

const bindingSchema = z
  .object({
    executionId: z.uuid(),
    executorId: z.uuid(),
    jobId: z.uuid(),
    backendBinding: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const evidenceSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['remote-operations-settled', 'stopped-before-dispatch']),
  })
  .strict();
const recordSchema = bindingSchema
  .extend({
    status: z.enum(['active', 'unconfirmed', 'settled']),
    resolution: evidenceSchema.optional(),
  })
  .strict();
const gateSchema = z.object({ executionId: z.uuid(), settled: z.boolean() }).strict();
const backendBindingSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type CleanupExecutionBinding = z.infer<typeof bindingSchema>;
export type CleanupExecutionRecord = z.infer<typeof recordSchema>;
export type CleanupExecutionEvidence = z.infer<typeof evidenceSchema>;

/**
 * Compose with a dedicated backend lock and caller-owned Serializable transactions.
 * Neither lock loss nor elapsed time clears a gate. Retain all execution allocations.
 */
export class CleanupExecutionJournal {
  private readonly prefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    this.prefix = cleanupHash(z.string().min(1).max(200).parse(namespace));
  }
  private execution(id: string) {
    return sqlStateBackend(this.database, this.dialect, `sd-ce:1:${this.prefix}:${z.uuid().parse(id)}`);
  }
  private gate(backendBinding: string) {
    return sqlStateBackend(
      this.database,
      this.dialect,
      `sd-ceg:1:${this.prefix}:${backendBindingSchema.parse(backendBinding)}`,
    );
  }
  async read(input: CleanupExecutionBinding): Promise<CleanupExecutionRecord | null> {
    const binding = bindingSchema.parse(input);
    const row = await this.execution(binding.executionId).read();
    if (!row) return null;
    const record = recordSchema.parse(row.state);
    for (const field of Object.keys(binding) as Array<keyof CleanupExecutionBinding>)
      if (record[field] !== binding[field]) throw new Error('Cleanup execution identity does not match');
    return record;
  }
  async assertOwned(input: CleanupExecutionBinding): Promise<void> {
    const binding = bindingSchema.parse(input);
    const record = await this.read(binding);
    const row = await this.gate(binding.backendBinding).read();
    const gate = row ? gateSchema.parse(row.state) : null;
    if (
      !record ||
      record.status !== 'active' ||
      !gate ||
      gate.settled ||
      gate.executionId !== binding.executionId
    )
      throw new Error('Cleanup execution no longer owns this backend');
  }
  /** Read the execution holding a physical backend gate, including unresolved recovery state. */
  async current(backendBinding: string): Promise<CleanupExecutionRecord | null> {
    const binding = backendBindingSchema.parse(backendBinding);
    const row = await this.gate(binding).read();
    if (!row) return null;
    const gate = gateSchema.parse(row.state);
    const execution = await this.execution(gate.executionId).read();
    if (!execution) throw new Error('Cleanup execution gate has no execution record');
    const record = recordSchema.parse(execution.state);
    if (record.backendBinding !== binding) throw new Error('Cleanup execution gate identity does not match');
    if (gate.settled !== (record.status === 'settled'))
      throw new Error('Cleanup execution gate state does not match');
    return record;
  }
  /** Check ownership and persist observed deletion in this same Serializable transaction. */
  async acknowledgeTarget(input: CleanupExecutionBinding, ticket: StorageDeletionTicket): Promise<void> {
    const binding = bindingSchema.parse(input);
    if (binding.jobId !== ticket.jobId || binding.backendBinding !== ticket.target.binding)
      throw new Error('Cleanup execution does not own this deletion ticket');
    await this.assertOwned(binding);
    await new StorageCleanupJournal(this.database, this.dialect, this.namespace).acknowledgeTarget(ticket);
  }
  /** All registered backend destinations must have active ownership before a phase can advance. */
  async transition(jobId: string, epoch: number, inputs: readonly CleanupExecutionBinding[]) {
    const bindings = z.array(bindingSchema).min(1).max(1000).parse(inputs);
    if (
      bindings.some((binding) => binding.jobId !== jobId) ||
      new Set(bindings.map((binding) => binding.backendBinding)).size !== bindings.length
    )
      throw new Error('Cleanup phase ownership does not match the job');
    for (const binding of bindings) await this.assertOwned(binding);
    const cleanup = new StorageCleanupJournal(this.database, this.dialect, this.namespace);
    const registry = new StorageBackendRegistry(this.database, this.dialect, this.namespace);
    const covered = new Set(bindings.map((binding) => binding.backendBinding));
    let cursor: string | null = null;
    do {
      const page = await cleanup.listCollectors(jobId, cursor);
      for (const collector of page.collectors) {
        for (const id of collector.backendIds) {
          const backend = await registry.get(id);
          if (!backend || !covered.has(backend.binding))
            throw new Error('Cleanup phase requires ownership of every registered backend');
        }
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return cleanup.transition(jobId, epoch);
  }
  /** Repeated admission recovers ownership only. It never authorizes repeating external I/O. */
  async begin(input: CleanupExecutionBinding): Promise<CleanupExecutionRecord> {
    const binding = bindingSchema.parse(input);
    const previous = await this.read(binding);
    if (previous) {
      await this.assertOwned(binding);
      return previous;
    }
    const cleanup = new StorageCleanupJournal(this.database, this.dialect, this.namespace);
    const job = await cleanup.get(binding.jobId);
    if (job.phase === 'complete') throw new Error('Completed cleanup cannot start an execution');
    const registry = new StorageBackendRegistry(this.database, this.dialect, this.namespace);
    let cursor: string | null = null;
    let covered = false;
    do {
      const page = await cleanup.listCollectors(job.id, cursor);
      for (const collector of page.collectors) {
        for (const id of collector.backendIds) {
          const backend = await registry.get(id);
          if (backend?.binding === binding.backendBinding) covered = true;
        }
      }
      cursor = page.cursor;
    } while (!covered && cursor !== null);
    if (!covered) throw new Error('Cleanup execution backend has no registered collector');
    const gateBackend = this.gate(binding.backendBinding);
    const gateRow = await gateBackend.read();
    if (gateRow && !gateSchema.parse(gateRow.state).settled)
      throw new Error('Backend has an unresolved cleanup execution');
    const record: CleanupExecutionRecord = { ...binding, status: 'active' };
    if (
      !(await this.execution(binding.executionId).compareAndSwap(null, {
        revision: randomUUID(),
        state: record,
      })) ||
      !(await gateBackend.compareAndSwap(gateRow?.revision ?? null, {
        revision: randomUUID(),
        state: { executionId: binding.executionId, settled: false },
      }))
    )
      throw new Error('Cleanup execution admission changed concurrently');
    return record;
  }
  private async update(
    input: CleanupExecutionBinding,
    status: 'unconfirmed' | 'settled',
    evidence?: CleanupExecutionEvidence,
  ) {
    const binding = bindingSchema.parse(input);
    const record = await this.read(binding);
    if (!record) throw new Error('Cleanup execution is missing');
    if (record.status === 'settled') {
      if (status === 'settled' && JSON.stringify(record.resolution) === JSON.stringify(evidence)) return;
      throw new Error('Cleanup execution is already settled');
    }
    const backend = this.execution(binding.executionId);
    const row = await backend.read();
    const gateBackend = this.gate(binding.backendBinding);
    const gateRow = await gateBackend.read();
    const gate = gateRow ? gateSchema.parse(gateRow.state) : null;
    if (!row || !gate || gate.settled || gate.executionId !== binding.executionId)
      throw new Error('Cleanup execution no longer owns this backend');
    if (
      !(await backend.compareAndSwap(row.revision, {
        revision: randomUUID(),
        state: { ...record, status, ...(evidence ? { resolution: evidence } : {}) },
      }))
    )
      throw new Error('Cleanup execution changed concurrently');
    if (
      status === 'settled' &&
      !(await gateBackend.compareAndSwap(gateRow!.revision, {
        revision: randomUUID(),
        state: { executionId: binding.executionId, settled: true },
      }))
    )
      throw new Error('Cleanup execution gate changed concurrently');
  }
  async markUnconfirmed(binding: CleanupExecutionBinding): Promise<void> {
    await this.update(binding, 'unconfirmed');
  }
  /** Original executor observed every dispatched operation settle, including after uncertainty. */
  async settle(binding: CleanupExecutionBinding): Promise<void> {
    await this.update(binding, 'settled');
  }
  /** Caller authorizes and persists exact remote-operation evidence. Process death alone is insufficient. */
  async resolveUnconfirmed(
    binding: CleanupExecutionBinding,
    evidence: CleanupExecutionEvidence,
  ): Promise<void> {
    await this.update(binding, 'settled', evidenceSchema.parse(evidence));
  }
}
