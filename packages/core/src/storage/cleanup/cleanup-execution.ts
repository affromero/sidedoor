import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageCleanupJournal } from './cleanup-journal';
import { StorageBackendRegistry } from '../registry/backend-registry';
import { StorageTargetFence } from '../execution/target-fence';
import { cleanupHash, cleanupJob, type StorageDeletionTicket } from './cleanup-state';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../sql/sql';

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
const gateSchema = z
  .object({ namespaceHash: z.string().regex(/^[a-f0-9]{64}$/), executionId: z.uuid(), settled: z.boolean() })
  .strict();
const legacyGateSchema = z.object({ executionId: z.uuid(), settled: z.boolean() }).strict();
const operationSchema = z.object({ revision: z.uuid(), kind: z.enum(['read', 'delete']) }).strict();
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
      `sd-ceg:2:${backendBindingSchema.parse(backendBinding)}`,
    );
  }
  private async requireNoLegacyGate(backendBinding: string): Promise<void> {
    const binding = backendBindingSchema.parse(backendBinding);
    const prefix = 'sd-ceg:1:';
    let cursor: string | null = null;
    do {
      const rows = await sqlStateRows(this.database, this.dialect, prefix, cursor, 100, 'compoundDigest');
      for (const row of rows) {
        const id = String(row.id);
        if (!/^sd-ceg:1:[a-f0-9]{64}:[a-f0-9]{64}$/.test(id))
          throw new Error('Legacy cleanup gate identity does not match');
        if (id.endsWith(`:${binding}`)) {
          const state =
            this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
          legacyGateSchema.parse(state);
          throw new Error('Legacy cleanup gate requires reviewed recovery');
        }
      }
      cursor = rows.length === 100 ? String(rows.at(-1)!.id) : null;
    } while (cursor !== null);
  }
  private operation(executionId: string) {
    return sqlStateBackend(
      this.database,
      this.dialect,
      `sd-ceio:1:${this.prefix}:${z.uuid().parse(executionId)}`,
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
      gate.namespaceHash !== this.prefix ||
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
    if (gate.namespaceHash !== this.prefix) throw new Error('Storage backend is owned by another namespace');
    const execution = await this.execution(gate.executionId).read();
    if (!execution) throw new Error('Cleanup execution gate has no execution record');
    const record = recordSchema.parse(execution.state);
    if (record.backendBinding !== binding) throw new Error('Cleanup execution gate identity does not match');
    if (gate.settled !== (record.status === 'settled'))
      throw new Error('Cleanup execution gate state does not match');
    return record;
  }
  /** Check completion without exposing the identity of another namespace's executor. */
  async hasConfirmedCompletion(
    jobId: string,
    backendBinding: string,
    activeExecutionId?: string,
  ): Promise<boolean> {
    const job = z.uuid().parse(jobId);
    const binding = backendBindingSchema.parse(backendBinding);
    const active = activeExecutionId === undefined ? null : z.uuid().parse(activeExecutionId);
    const gateRow = await this.gate(binding).read();
    if (!gateRow) return false;
    const gate = gateSchema.parse(gateRow.state);
    const backend = sqlStateBackend(
      this.database,
      this.dialect,
      `sd-ce:1:${gate.namespaceHash}:${gate.executionId}`,
    );
    const row = await backend.read();
    if (!row) throw new Error('Cleanup execution gate has no execution record');
    const record = recordSchema.parse(row.state);
    if (
      record.executionId !== gate.executionId ||
      record.backendBinding !== binding ||
      gate.settled !== (record.status === 'settled')
    )
      throw new Error('Cleanup execution gate state does not match');
    let allowedActive: string | undefined;
    if (!gate.settled) {
      if (
        gate.namespaceHash !== this.prefix ||
        record.jobId !== job ||
        record.status !== 'active' ||
        record.executionId !== active
      )
        return false;
      allowedActive = record.executionId;
    }
    return this.hasSettled(job, binding, allowedActive);
  }
  /** Verify retained execution history; an exact current probe executor may still be active. */
  async hasSettled(
    jobId: string,
    backendBinding: string,
    activeExecutionId?: string,
    activeJobId?: string,
  ): Promise<boolean> {
    const job = z.uuid().parse(jobId);
    const backend = backendBindingSchema.parse(backendBinding);
    const active = activeExecutionId === undefined ? null : z.uuid().parse(activeExecutionId);
    const activeJob = activeJobId === undefined ? job : z.uuid().parse(activeJobId);
    const prefix = 'sd-ce:1:';
    let cursor: string | null = null;
    let settled = false;
    do {
      const rows = await sqlStateRows(this.database, this.dialect, prefix, cursor, 100, 'namespaceUuid');
      for (const row of rows) {
        const state =
          this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
        const record = recordSchema.parse(state);
        const id = String(row.id);
        const match = /^sd-ce:1:([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(id);
        if (!match || match[2] !== record.executionId)
          throw new Error('Cleanup execution identity does not match');
        if (record.backendBinding === backend) {
          if (
            record.status !== 'settled' &&
            !(
              record.status === 'active' &&
              record.executionId === active &&
              record.jobId === activeJob &&
              match[1] === this.prefix
            )
          )
            return false;
          if (match[1] === this.prefix && record.jobId === job) settled = true;
        }
      }
      cursor = rows.length === 100 ? String(rows.at(-1)!.id) : null;
    } while (cursor !== null);
    return settled;
  }
  /** Fence an exact pending target before dispatch while the execution owns its backend. */
  async authorizeTarget(input: CleanupExecutionBinding, ticket: StorageDeletionTicket): Promise<void> {
    const binding = bindingSchema.parse(input);
    if (binding.jobId !== ticket.jobId || binding.backendBinding !== ticket.target.binding)
      throw new Error('Cleanup execution does not own this deletion ticket');
    await this.assertOwned(binding);
    if (!(await this.hasSettled(binding.jobId, binding.backendBinding, binding.executionId)))
      throw new Error('Storage cleanup backend has unconfirmed execution');
    await new StorageCleanupJournal(this.database, this.dialect, this.namespace).requirePendingTarget(ticket);
    await new StorageTargetFence(this.database, this.dialect).retireForCleanup({
      binding: ticket.target.binding,
      key: ticket.target.key,
      namespace: this.namespace,
      jobId: ticket.jobId,
      epoch: ticket.epoch,
      executionId: binding.executionId,
    });
  }

  /** Check ownership and persist observed deletion in this same Serializable transaction. */
  async acknowledgeTarget(input: CleanupExecutionBinding, ticket: StorageDeletionTicket): Promise<void> {
    const binding = bindingSchema.parse(input);
    if (binding.jobId !== ticket.jobId || binding.backendBinding !== ticket.target.binding)
      throw new Error('Cleanup execution does not own this deletion ticket');
    await this.assertOwned(binding);
    await new StorageCleanupJournal(this.database, this.dialect, this.namespace).acknowledgeTarget(ticket);
  }
  /** A probe records uncertainty before dispatch, and clears it only with its deletion receipt. */
  async acknowledgeDispatchedTarget(
    input: CleanupExecutionBinding,
    ticket: StorageDeletionTicket,
    revision: string,
  ): Promise<void> {
    const binding = bindingSchema.parse(input);
    if (binding.jobId !== ticket.jobId || binding.backendBinding !== ticket.target.binding)
      throw new Error('Cleanup execution does not own this deletion ticket');
    await this.assertUnconfirmed(binding, revision, 'delete');
    await new StorageCleanupJournal(this.database, this.dialect, this.namespace).acknowledgeTarget(ticket);
    await this.update(binding, 'active');
  }
  private async assertUnconfirmed(
    binding: CleanupExecutionBinding,
    revision: string,
    kind: 'read' | 'delete',
  ): Promise<void> {
    const row = await this.execution(binding.executionId).read();
    if (!row || row.revision !== z.uuid().parse(revision))
      throw new Error('Cleanup unconfirmed operation changed');
    const saved = await this.operation(binding.executionId).read();
    const operation = saved ? operationSchema.parse(saved.state) : null;
    if (!operation || operation.kind !== kind || operation.revision !== revision)
      throw new Error('Cleanup unconfirmed operation does not match');
    const record = await this.read(binding);
    const gateRow = await this.gate(binding.backendBinding).read();
    const gate = gateRow ? gateSchema.parse(gateRow.state) : null;
    if (
      !record ||
      record.status !== 'unconfirmed' ||
      !gate ||
      gate.settled ||
      gate.namespaceHash !== this.prefix ||
      gate.executionId !== binding.executionId
    )
      throw new Error('Cleanup execution does not own this unconfirmed operation');
  }
  /** Resume the same executor after it observed a read-only backend operation settle. */
  async confirmObservedIo(input: CleanupExecutionBinding, revision: string): Promise<void> {
    const binding = bindingSchema.parse(input);
    await this.assertUnconfirmed(binding, revision, 'read');
    await this.update(binding, 'active');
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
    const job = await cleanup.get(jobId);
    if (job.phase === 'verifying' && job.pending === 0) {
      for (const binding of bindings)
        if (!(await this.hasSettled(jobId, binding.backendBinding, binding.executionId)))
          throw new Error('Completed cleanup requires confirmed backend execution');
    }
    return cleanup.transition(jobId, epoch);
  }
  /** Repeated admission recovers ownership only. It never authorizes repeating external I/O. */
  async begin(input: CleanupExecutionBinding): Promise<CleanupExecutionRecord> {
    const binding = bindingSchema.parse(input);
    await this.requireNoLegacyGate(binding.backendBinding);
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
        state: { namespaceHash: this.prefix, executionId: binding.executionId, settled: false },
      }))
    )
      throw new Error('Cleanup execution admission changed concurrently');
    return record;
  }
  private async update(
    input: CleanupExecutionBinding,
    status: 'active' | 'unconfirmed' | 'settled',
    evidence?: CleanupExecutionEvidence,
  ) {
    const binding = bindingSchema.parse(input);
    const record = await this.read(binding);
    if (!record) throw new Error('Cleanup execution is missing');
    if (record.status === 'settled') {
      if (status === 'settled' && JSON.stringify(record.resolution) === JSON.stringify(evidence)) return;
      if (status === 'unconfirmed' && !record.resolution) {
        const backend = this.execution(binding.executionId);
        const row = await backend.read();
        const gateBackend = this.gate(binding.backendBinding);
        const gateRow = await gateBackend.read();
        const gate = gateRow ? gateSchema.parse(gateRow.state) : null;
        if (!row || !gate) throw new Error('Cleanup execution no longer owns this backend');
        const revision = randomUUID();
        if (gate.namespaceHash !== this.prefix || gate.executionId !== binding.executionId) {
          if (
            !(await backend.compareAndSwap(row.revision, {
              revision,
              state: { ...record, status: 'unconfirmed' },
            }))
          )
            throw new Error('Cleanup execution changed concurrently');
          return revision;
        }
        if (!gate.settled) throw new Error('Cleanup execution no longer owns this backend');
        if (
          !(await backend.compareAndSwap(row.revision, {
            revision,
            state: { ...record, status: 'unconfirmed' },
          })) ||
          !(await gateBackend.compareAndSwap(gateRow!.revision, {
            revision: randomUUID(),
            state: { namespaceHash: this.prefix, executionId: binding.executionId, settled: false },
          }))
        )
          throw new Error('Cleanup execution changed concurrently');
        return revision;
      }
      throw new Error('Cleanup execution is already settled');
    }
    if (status === 'settled' && record.status === 'unconfirmed' && !evidence)
      throw new Error('Unconfirmed cleanup requires settlement evidence');
    if (status === 'settled' && (record.status === 'unconfirmed' || evidence))
      await new StorageCleanupJournal(
        this.database,
        this.dialect,
        this.namespace,
      ).restartUnconfirmedInventory(binding.jobId);
    const backend = this.execution(binding.executionId);
    const row = await backend.read();
    const gateBackend = this.gate(binding.backendBinding);
    const gateRow = await gateBackend.read();
    const gate = gateRow ? gateSchema.parse(gateRow.state) : null;
    if (
      row &&
      gate &&
      (gate.namespaceHash !== this.prefix || gate.executionId !== binding.executionId) &&
      record.status === 'unconfirmed' &&
      status === 'settled' &&
      evidence
    ) {
      const ownerRow = await sqlStateBackend(
        this.database,
        this.dialect,
        `sd-ce:1:${gate.namespaceHash}:${gate.executionId}`,
      ).read();
      if (!ownerRow) throw new Error('Cleanup execution gate has no execution record');
      const successor = recordSchema.parse(ownerRow.state);
      if (
        successor.executionId !== gate.executionId ||
        successor.backendBinding !== binding.backendBinding ||
        gate.settled !== (successor.status === 'settled')
      )
        throw new Error('Cleanup execution gate state does not match');
      if (gate.namespaceHash !== this.prefix || successor.jobId !== binding.jobId) {
        const ownerJob = await sqlStateBackend(
          this.database,
          this.dialect,
          `sd-c:1:${gate.namespaceHash}:${successor.jobId}`,
        ).read();
        if (!ownerJob) throw new Error('Cleanup execution job is missing');
        const successorJob = cleanupJob.parse(ownerJob.state);
        if (cleanupHash(successorJob.namespace) !== gate.namespaceHash || successorJob.id !== successor.jobId)
          throw new Error('Cleanup execution job identity does not match');
        await new StorageCleanupJournal(
          this.database,
          this.dialect,
          successorJob.namespace,
        ).restartUnconfirmedInventory(successor.jobId);
      }
      const revision = randomUUID();
      if (
        !(await backend.compareAndSwap(row.revision, {
          revision,
          state: { ...record, status: 'settled', resolution: evidence },
        }))
      )
        throw new Error('Cleanup execution changed concurrently');
      return revision;
    }
    if (
      !row ||
      !gate ||
      gate.settled ||
      gate.namespaceHash !== this.prefix ||
      gate.executionId !== binding.executionId
    )
      throw new Error('Cleanup execution no longer owns this backend');
    const nextRevision = randomUUID();
    if (
      !(await backend.compareAndSwap(row.revision, {
        revision: nextRevision,
        state: { ...record, status, ...(evidence ? { resolution: evidence } : {}) },
      }))
    )
      throw new Error('Cleanup execution changed concurrently');
    if (
      status === 'settled' &&
      !(await gateBackend.compareAndSwap(gateRow!.revision, {
        revision: randomUUID(),
        state: { namespaceHash: this.prefix, executionId: binding.executionId, settled: true },
      }))
    )
      throw new Error('Cleanup execution gate changed concurrently');
    return nextRevision;
  }
  async markUnconfirmed(binding: CleanupExecutionBinding): Promise<void> {
    await this.update(binding, 'unconfirmed');
  }
  /** Capture the exact uncertainty revision before a probe dispatches backend I/O. */
  async beginUnconfirmedOperation(
    binding: CleanupExecutionBinding,
    kind: 'read' | 'delete',
  ): Promise<string> {
    const value = bindingSchema.parse(binding);
    const operationKind = operationSchema.shape.kind.parse(kind);
    await this.assertOwned(value);
    const revision = await this.update(value, 'unconfirmed');
    if (!revision) throw new Error('Cleanup execution is already settled');
    const backend = this.operation(value.executionId);
    const previous = await backend.read();
    if (
      !(await backend.compareAndSwap(previous?.revision ?? null, {
        revision: randomUUID(),
        state: { revision, kind: operationKind },
      }))
    )
      throw new Error('Cleanup operation changed concurrently');
    return revision;
  }
  /** The active executor observed every dispatched operation settle. */
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
