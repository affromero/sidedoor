import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AtomicStateBackend, StateSnapshot } from '../../storage/sql/optimistic';
import { canonicalJson } from '../process/json';
import {
  delegationAttemptInputSchema,
  delegationBindingSchema,
  delegationGrantSchema,
  delegationOutcomeSchema,
  delegationRecordSchema,
  type DelegationActivity,
  type DelegationAttemptInput,
  type DelegationBinding,
  type DelegationGrant,
  type DelegationOutcome,
  type DelegationRecord,
} from './schema';

export * from './schema';

export class DelegationConflictError extends Error {
  constructor() {
    super('Delegation changed concurrently; retry the complete application transaction');
    this.name = 'DelegationConflictError';
  }
}

export class DelegationDeniedError extends Error {
  constructor(
    readonly code: 'missing' | 'binding' | 'closed' | 'expired' | 'budget' | 'attempt' | 'unsettled',
  ) {
    super(`Delegation rejected: ${code}`);
    this.name = 'DelegationDeniedError';
  }
}

export interface DelegationStoreOptions {
  /** One durable row per grant, bound to the application's existing transaction. */
  backend: AtomicStateBackend;
  /** Revalidate the actor, instance, subject/resource generations and action in that transaction. */
  authorize: (context: {
    operation: 'create' | 'read' | 'validate' | 'admit' | 'settle' | 'revoke' | 'complete';
    grant: DelegationGrant;
  }) => Promise<void>;
  now?: () => number;
}

export function delegationGrantBinding(input: DelegationGrant): DelegationBinding {
  const grant = delegationGrantSchema.parse(input);
  return {
    id: grant.id,
    revision: grant.revision,
    fingerprint: createHash('sha256').update(canonicalJson(grant)).digest('hex'),
  };
}

/**
 * This store performs no external effects and never retries transactions internally.
 * Commit admission before dispatch. Replayed admissions never authorize another dispatch.
 * Retain records through the application's replay horizon; deletion permits identity reuse.
 */
export class DelegationStore {
  private readonly backend: AtomicStateBackend;
  private readonly authorize: DelegationStoreOptions['authorize'];
  private readonly now: () => number;

  constructor(options: DelegationStoreOptions) {
    this.backend = options.backend;
    this.authorize = options.authorize;
    this.now = options.now ?? Date.now;
  }

  private time() {
    return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(this.now());
  }

  private event(record: DelegationRecord, type: DelegationActivity['type'], attemptId?: string) {
    record.sequence += 1;
    record.activity.push({
      sequence: record.sequence,
      at: this.time(),
      type,
      ...(attemptId ? { attemptId } : {}),
    });
    record.activity = record.activity.slice(-128);
  }

  private parse(snapshot: StateSnapshot) {
    const record = delegationRecordSchema.parse(snapshot.state);
    if (
      canonicalJson(delegationGrantBinding(record.grant)) !== canonicalJson(record.binding) ||
      record.attempts.length > record.grant.maxRequests ||
      new Set(record.attempts.map((attempt) => attempt.id)).size !== record.attempts.length ||
      record.attempts.some((attempt, index) => attempt.number !== index + 1) ||
      record.activity.some(
        (event, index) => event.sequence !== record.sequence - record.activity.length + index + 1,
      )
    )
      throw new DelegationDeniedError('binding');
    return record;
  }

  private async owned(
    input: DelegationBinding,
    operation: Parameters<typeof this.authorize>[0]['operation'],
  ) {
    const expected = delegationBindingSchema.parse(input);
    const row = await this.backend.read();
    if (!row) throw new DelegationDeniedError('missing');
    const record = this.parse(row);
    if (canonicalJson(expected) !== canonicalJson(record.binding)) throw new DelegationDeniedError('binding');
    await this.authorize({ operation, grant: structuredClone(record.grant) });
    return { row, record };
  }

  private active(record: DelegationRecord) {
    if (record.status !== 'active') throw new DelegationDeniedError('closed');
    if (this.time() >= record.grant.expiresAt) throw new DelegationDeniedError('expired');
  }

  private async save(previous: string | null, record: DelegationRecord) {
    const state = delegationRecordSchema.parse(record);
    if (!(await this.backend.compareAndSwap(previous, { revision: randomUUID(), state })))
      throw new DelegationConflictError();
  }

  async create(input: DelegationGrant): Promise<DelegationRecord> {
    const grant = delegationGrantSchema.parse(input);
    await this.authorize({ operation: 'create', grant: structuredClone(grant) });
    const row = await this.backend.read();
    if (row) {
      const record = this.parse(row);
      if (canonicalJson(record.grant) !== canonicalJson(grant)) throw new DelegationDeniedError('binding');
      return structuredClone(record);
    }
    const record: DelegationRecord = {
      version: 1,
      grant,
      binding: delegationGrantBinding(grant),
      status: 'active',
      attempts: [],
      sequence: 1,
      activity: [{ sequence: 1, at: this.time(), type: 'created' }],
    };
    this.active(record);
    await this.save(null, record);
    return structuredClone(record);
  }

  async read(input: DelegationBinding): Promise<DelegationRecord> {
    return structuredClone((await this.owned(input, 'read')).record);
  }

  /** Check current authority without consuming budget. This alone never admits a dispatch. */
  async validate(input: DelegationBinding): Promise<void> {
    this.active((await this.owned(input, 'validate')).record);
  }

  /** Each actual HTTP attempt requires a fresh ID and consumes a slot, including retries. */
  async admit(input: DelegationBinding, request: DelegationAttemptInput) {
    const captured = delegationAttemptInputSchema.parse(request);
    const { row, record } = await this.owned(input, 'admit');
    const previous = record.attempts.find((attempt) => attempt.id === captured.id);
    if (previous) {
      if (previous.fingerprint !== captured.fingerprint) throw new DelegationDeniedError('attempt');
      return { dispatch: false as const, attempt: structuredClone(previous) };
    }
    this.active(record);
    if (record.attempts.length >= record.grant.maxRequests) throw new DelegationDeniedError('budget');
    const attempt = {
      ...captured,
      number: record.attempts.length + 1,
      admittedAt: this.time(),
      outcome: 'admitted' as const,
    };
    record.attempts.push(attempt);
    this.event(record, 'admitted', attempt.id);
    await this.save(row.revision, record);
    return { dispatch: true as const, attempt: structuredClone(attempt) };
  }

  /** Settlement records observations only. It does not refund budget or prove remote exactly-once effects. */
  async settle(input: DelegationBinding, request: DelegationAttemptInput, outcomeInput: DelegationOutcome) {
    const captured = delegationAttemptInputSchema.parse(request);
    const outcome = delegationOutcomeSchema.parse(outcomeInput);
    const { row, record } = await this.owned(input, 'settle');
    const attempt = record.attempts.find((candidate) => candidate.id === captured.id);
    if (!attempt || attempt.fingerprint !== captured.fingerprint) throw new DelegationDeniedError('attempt');
    if (attempt.outcome !== 'admitted') {
      if (attempt.outcome !== outcome) throw new DelegationDeniedError('attempt');
      return structuredClone(attempt);
    }
    attempt.outcome = outcome;
    attempt.settledAt = this.time();
    this.event(record, outcome, attempt.id);
    await this.save(row.revision, record);
    return structuredClone(attempt);
  }

  async revoke(input: DelegationBinding): Promise<DelegationRecord> {
    const { row, record } = await this.owned(input, 'revoke');
    if (record.status === 'revoked') return structuredClone(record);
    record.status = 'revoked';
    this.event(record, 'revoked');
    await this.save(row.revision, record);
    return structuredClone(record);
  }

  async complete(input: DelegationBinding): Promise<DelegationRecord> {
    const { row, record } = await this.owned(input, 'complete');
    if (record.status === 'completed') return structuredClone(record);
    if (record.status !== 'active') throw new DelegationDeniedError('closed');
    if (record.attempts.some((attempt) => attempt.outcome === 'admitted' || attempt.outcome === 'unknown'))
      throw new DelegationDeniedError('unsettled');
    record.status = 'completed';
    this.event(record, 'completed');
    await this.save(row.revision, record);
    return structuredClone(record);
  }

  /** A gap is explicit when retention has removed events after the supplied cursor. */
  async activity(input: DelegationBinding, options: { after?: number; limit?: number } = {}) {
    const after = z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(options.after ?? 0);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(options.limit ?? 100);
    const { record } = await this.owned(input, 'read');
    if (after > record.sequence) throw new DelegationDeniedError('binding');
    const events = record.activity.filter((event) => event.sequence > after).slice(0, limit);
    return {
      events: structuredClone(events),
      truncated: after < record.activity[0]!.sequence - 1,
      next: events.at(-1)?.sequence ?? after,
      latest: record.sequence,
    };
  }
}
