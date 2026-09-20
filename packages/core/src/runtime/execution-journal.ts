import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JobOutbox } from './outbox';
import { canonicalJson } from './json';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../storage/sql';
import { StorageWriteJournal } from '../storage/write-journal';
import {
  executionWorkspacePlanSchema,
  executionWorkspaceSchema,
  type ExecutionWorkspacePlan,
  type ExecutionWorkspace,
} from '../storage/execution-workspace';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z
  .object({
    id: z.uuid(),
    parentId: z.uuid(),
    fingerprint: digest,
    executorId: z.uuid(),
  })
  .strict();
const recordSchema = binding
  .extend({
    kind: z.literal('job_execution'),
    scopeDigests: z.array(digest).min(1).max(100),
    status: z.enum(['active', 'cleanup-unconfirmed', 'settled']),
    workspace: z.union([executionWorkspaceSchema, executionWorkspacePlanSchema]).optional(),
  })
  .strict();
const gateSchema = z.object({ id: z.uuid(), fingerprint: digest, settled: z.boolean() }).strict();
export type JobExecutionBinding = z.infer<typeof binding>;
export type JobExecutionRecord = z.infer<typeof recordSchema>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class JobExecutionAdmissionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobExecutionAdmissionConflict';
  }
}

/**
 * Use caller-owned Serializable transactions. Begin before external effects, with a fresh
 * execution and supervisor-instance UUID. A queue failure, expired lease or dead worker
 * is never cleanup proof. This journal records caller-verified cleanup, not termination.
 * Records retain only opaque identities and scope digests after application erasure.
 */
export class JobExecutionJournal {
  private readonly prefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    this.prefix = hash(z.string().min(1).max(200).parse(namespace));
  }
  private backend(id: string) {
    return sqlStateBackend(this.database, this.dialect, `sd-je:1:${this.prefix}:${z.uuid().parse(id)}`);
  }
  private gate(parentId: string) {
    return sqlStateBackend(
      this.database,
      this.dialect,
      `sd-jeg:1:${this.prefix}:${z.uuid().parse(parentId)}`,
    );
  }
  private scopePrefix(scopeDigest: string) {
    return `sd-jes:1:${this.prefix}:${digest.parse(scopeDigest)}:`;
  }
  private async owned(input: JobExecutionBinding) {
    const expected = binding.parse(input);
    const row = await this.backend(expected.id).read();
    if (!row) throw new Error('Execution does not exist');
    const record = recordSchema.parse(row.state);
    if (
      canonicalJson(
        binding.parse({
          id: record.id,
          parentId: record.parentId,
          fingerprint: record.fingerprint,
          executorId: record.executorId,
        }),
      ) !== canonicalJson(expected)
    )
      throw new Error('Execution identity mismatch');
    return { row, record };
  }
  async begin(
    input: JobExecutionBinding,
    workspaceInput?: ExecutionWorkspacePlan,
  ): Promise<JobExecutionRecord> {
    const captured = binding.parse(input);
    const workspace =
      workspaceInput === undefined ? undefined : executionWorkspacePlanSchema.parse(workspaceInput);
    if (workspace && workspace.executionId !== captured.id)
      throw new Error('Execution workspace identity mismatch');
    const parent = await new JobOutbox(this.database, this.dialect, this.namespace).read(captured.parentId);
    if (!parent || parent.complete || parent.fingerprint !== captured.fingerprint)
      throw new Error('Execution requires matching pending work');
    const writes = new StorageWriteJournal(this.database, this.dialect, this.namespace);
    for (const scope of parent.job.scopes)
      if (await writes.tombstone(scope.subjectId)) throw new Error('Execution scope is being erased');
    const gate = this.gate(captured.parentId);
    const prior = await gate.read();
    if (prior) {
      const state = gateSchema.parse(prior.state);
      if (state.fingerprint !== captured.fingerprint) throw new Error('Execution parent identity mismatch');
      if (!state.settled) throw new JobExecutionAdmissionConflict('Previous execution cleanup is unresolved');
    }
    const record: JobExecutionRecord = {
      ...captured,
      kind: 'job_execution',
      scopeDigests: parent.job.scopes.map((scope) => hash(canonicalJson(scope))),
      status: 'active',
      ...(workspace ? { workspace } : {}),
    };
    if (!(await this.backend(captured.id).compareAndSwap(null, { revision: randomUUID(), state: record })))
      throw new Error('Execution identity already exists');
    if (
      !(await gate.compareAndSwap(prior?.revision ?? null, {
        revision: randomUUID(),
        state: { id: captured.id, fingerprint: captured.fingerprint, settled: false },
      }))
    )
      throw new JobExecutionAdmissionConflict(
        'Concurrent execution admission; retry the complete transaction',
      );
    for (const scopeDigest of record.scopeDigests) {
      const index = sqlStateBackend(
        this.database,
        this.dialect,
        `${this.scopePrefix(scopeDigest)}${record.id}`,
      );
      if (!(await index.compareAndSwap(null, { revision: randomUUID(), state: captured })))
        throw new Error('Execution scope index already exists');
    }
    return structuredClone(record);
  }
  async read(input: JobExecutionBinding): Promise<JobExecutionRecord> {
    return (await this.owned(input)).record;
  }
  /** Attach only the identity created from the admitted intent, before any child effects. */
  async attachWorkspace(input: JobExecutionBinding, workspaceInput: ExecutionWorkspace): Promise<void> {
    const workspace = executionWorkspaceSchema.parse(workspaceInput);
    const { row, record } = await this.owned(input);
    if (record.status !== 'active' || !record.workspace)
      throw new Error('Execution workspace is not pending');
    const plan = {
      locationId: workspace.locationId,
      executionId: workspace.executionId,
      root: workspace.root,
    };
    const previous = record.workspace;
    if (
      canonicalJson(plan) !==
      canonicalJson({
        locationId: previous.locationId,
        executionId: previous.executionId,
        root: previous.root,
      })
    )
      throw new Error('Execution workspace intent changed');
    if ('directory' in previous) {
      if (canonicalJson(previous) !== canonicalJson(workspace))
        throw new Error('Execution workspace directory changed');
      return;
    }
    if (
      !(await this.backend(record.id).compareAndSwap(row.revision, {
        revision: randomUUID(),
        state: { ...record, workspace },
      }))
    )
      throw new Error('Concurrent workspace attachment; retry the complete transaction');
  }
  /**
   * Record verified removal only after the exact executor and its I/O have stopped.
   * After a lost commit response, read the exact execution: absent workspace confirms
   * release. Do not blindly replay this operation or recapture an attached identity.
   */
  async releaseWorkspace(
    input: JobExecutionBinding,
    expectedInput: ExecutionWorkspacePlan | ExecutionWorkspace,
  ): Promise<void> {
    const expected = z.union([executionWorkspaceSchema, executionWorkspacePlanSchema]).parse(expectedInput);
    const { row, record } = await this.owned(input);
    if (expected.executionId !== record.id) throw new Error('Execution workspace identity mismatch');
    if (!record.workspace) throw new Error('Execution workspace is not pending');
    if (canonicalJson(record.workspace) !== canonicalJson(expected))
      throw new Error('Execution workspace identity mismatch');
    const next = { ...record };
    delete next.workspace;
    if (
      !(await this.backend(record.id).compareAndSwap(row.revision, {
        revision: randomUUID(),
        state: next,
      }))
    )
      throw new Error('Concurrent workspace release; retry the complete transaction');
  }
  async markCleanupUnconfirmed(input: JobExecutionBinding): Promise<void> {
    const { row, record } = await this.owned(input);
    if (record.status === 'settled') throw new Error('Settled execution cannot become uncertain');
    if (record.status === 'cleanup-unconfirmed') return;
    if (
      !(await this.backend(record.id).compareAndSwap(row.revision, {
        revision: randomUUID(),
        state: { ...record, status: 'cleanup-unconfirmed' },
      }))
    )
      throw new Error('Concurrent execution update; retry the complete transaction');
  }
  /**
   * Call only after all owned processes, streams and temporary resources have settled.
   * Recovery callers must verify the exact supervisor instance and containment scope.
   * Local cancellation alone does not establish remote provider termination.
   */
  async settle(input: JobExecutionBinding): Promise<void> {
    const { row, record } = await this.owned(input);
    if (record.workspace) throw new Error('Execution workspace cleanup is unresolved');
    if (record.status === 'settled') return;
    const gate = this.gate(record.parentId);
    const previous = await gate.read();
    if (!previous) throw new Error('Execution parent gate is missing');
    const state = gateSchema.parse(previous.state);
    if (state.id !== record.id || state.fingerprint !== record.fingerprint || state.settled)
      throw new Error('Execution parent gate changed');
    if (
      !(await this.backend(record.id).compareAndSwap(row.revision, {
        revision: randomUUID(),
        state: { ...record, status: 'settled' },
      }))
    )
      throw new Error('Concurrent execution settlement; retry the complete transaction');
    if (
      !(await gate.compareAndSwap(previous.revision, {
        revision: randomUUID(),
        state: { ...state, settled: true },
      }))
    )
      throw new Error('Concurrent execution settlement; retry the complete transaction');
    const p = this.dialect === 'postgres' ? '$1' : '?';
    for (const scopeDigest of record.scopeDigests)
      await this.database.query(`DELETE FROM "SidedoorState" WHERE "id" = ${p} RETURNING "id"`, [
        `${this.scopePrefix(scopeDigest)}${record.id}`,
      ]);
  }
  async requireParentDrained(parentId: string, fingerprint: string): Promise<void> {
    digest.parse(fingerprint);
    const row = await this.gate(parentId).read();
    if (!row) return;
    const state = gateSchema.parse(row.state);
    if (state.fingerprint !== fingerprint) throw new Error('Execution parent identity mismatch');
    if (!state.settled) throw new Error('Execution cleanup is unresolved');
  }
  async blockingStatus(
    parentId: string,
    fingerprint: string,
  ): Promise<'active' | 'cleanup-unconfirmed' | null> {
    digest.parse(fingerprint);
    const gate = await this.gate(parentId).read();
    if (!gate) return null;
    const state = gateSchema.parse(gate.state);
    if (state.fingerprint !== fingerprint) throw new Error('Execution parent identity mismatch');
    if (state.settled) return null;
    const row = await this.backend(state.id).read();
    if (!row) throw new Error('Execution parent gate references a missing execution');
    const record = recordSchema.parse(row.state);
    if (record.parentId !== parentId || record.fingerprint !== fingerprint)
      throw new Error('Execution parent gate conflicts with execution');
    if (record.status === 'settled') throw new Error('Execution parent gate is unresolved after settlement');
    return record.status;
  }
  /** Bounded scan across attempts. Retry and deletion admission must check all relevant scopes. */
  async listUnresolved(scope: { subjectId: string; generation: number }, after: string | null = null) {
    const captured = z
      .object({ subjectId: z.string().min(1).max(200), generation: z.number().int().nonnegative().safe() })
      .strict()
      .parse(scope);
    const scopeDigest = hash(canonicalJson(captured));
    const prefix = this.scopePrefix(scopeDigest);
    const rows = await sqlStateRows(
      this.database,
      this.dialect,
      prefix,
      after === null ? null : `${prefix}${z.uuid().parse(after)}`,
      100,
      'uuid',
    );
    const executions: JobExecutionRecord[] = [];
    for (const row of rows) {
      const entry = binding.parse(
        this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      );
      if (row.id !== `${prefix}${entry.id}`) throw new Error('Execution scope index identity mismatch');
      const record = await this.read(entry);
      if (record.status === 'settled' || !record.scopeDigests.includes(scopeDigest))
        throw new Error('Execution scope index conflicts with execution');
      executions.push(record);
    }
    return { executions, cursor: executions.length === 100 ? executions.at(-1)!.id : null };
  }
}
