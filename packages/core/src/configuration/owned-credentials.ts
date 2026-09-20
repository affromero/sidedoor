import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CredentialCodec,
  CredentialValidationError,
  credentialStateSchema,
  initialCredentialState,
  type CredentialCodecOptions,
} from './index';
import type { CredentialValidation } from '../ai/browser';
import type { CredentialValues } from '../ai/index';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../storage/sql';

const identity = z.string().min(1).max(200);
const revision = z.uuid();
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ownerSchema = z.object({ subjectId: identity, generation: sequence }).strict();
const bindingSchema = z.object({ protocol: identity, endpoint: z.url() }).strict();
const reasonSchema = z.enum([
  'ready',
  'not_configured',
  'missing_credentials',
  'not_installed',
  'not_authenticated',
  'unreachable',
  'missing_model',
  'unsupported',
]);
const observation = z
  .object({
    attempt: sequence,
    status: z.enum(['verified', 'rejected', 'inconclusive']),
    checkedAt: z.number().finite().nonnegative(),
    reason: reasonSchema,
  })
  .strict();
const confirmed = observation.extend({ status: z.enum(['verified', 'rejected']), binding: bindingSchema });
const verificationSchema = z
  .object({
    nextAttempt: sequence,
    latestAppliedAttempt: sequence,
    lastAttempt: observation.nullable(),
    lastConfirmed: confirmed.nullable(),
  })
  .strict();
const timestamp = z.number().finite().nonnegative();
const metadataSchema = z
  .object({ createdAt: timestamp, updatedAt: timestamp, lastUsedAt: timestamp.nullable() })
  .strict();
const base = z
  .object({
    version: z.literal(1),
    namespace: identity,
    instanceId: z.uuid(),
    owner: ownerSchema,
    modality: identity,
    provider: identity,
    credentialRevision: revision,
  })
  .strict();
const liveSchema = base.extend({
  kind: z.literal('owned_credential'),
  credentials: credentialStateSchema,
  availability: z.enum(['enabled', 'disabled']),
  binding: bindingSchema,
  verification: verificationSchema,
  label: z.string().max(200).nullable(),
  metadata: metadataSchema,
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const removedSchema = base.extend({
  kind: z.literal('owned_credential_removed'),
  previousRevision: revision.nullable(),
});
const rowSchema = z.discriminatedUnion('kind', [liveSchema, removedSchema]);
const allocationSchema = z
  .object({
    version: z.literal(1),
    namespace: identity,
    instanceId: z.uuid(),
    credentialRevision: revision,
    target: z.string().regex(/^c:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/),
    operationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type LiveRow = z.infer<typeof liveSchema>;
type Row = z.infer<typeof rowSchema>;
export interface OwnedCredentialIdentity {
  owner: z.infer<typeof ownerSchema>;
  modality: string;
  provider: string;
}
export interface CredentialVerificationTicket extends OwnedCredentialIdentity {
  credentialRevision: string;
  attempt: number;
  binding: z.infer<typeof bindingSchema>;
}
export interface PreparedOwnedCredential {
  expectedHeadRevision: string | null;
  record: LiveRow;
}
export class OwnedCredentialConflictError extends Error {
  constructor() {
    super('Credential changed during the operation');
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizedBinding(value: z.infer<typeof bindingSchema>) {
  const binding = bindingSchema.parse(value);
  const url = new URL(binding.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid credential endpoint binding');
  return { protocol: binding.protocol, endpoint: url.href.replace(/\/+$/, '') };
}
function emptyVerification(): LiveRow['verification'] {
  return { nextAttempt: 1, latestAppliedAttempt: 0, lastAttempt: null, lastConfirmed: null };
}
function observe(
  row: Omit<LiveRow, 'operationDigest'>,
  attempt: number,
  outcome: CredentialValidation,
): void {
  if (
    outcome.status === 'valid' &&
    (outcome.readiness.authentication !== 'verified' || outcome.readiness.code !== 'ready')
  )
    throw new Error('Credential verification requires authenticated proof');
  if (outcome.status === 'rejected' && outcome.readiness.code !== 'not_authenticated')
    throw new Error('Credential rejection requires an authentication failure');
  const status =
    outcome.status === 'valid' ? 'verified' : outcome.status === 'rejected' ? 'rejected' : 'inconclusive';
  const result = observation.parse({
    attempt,
    status,
    checkedAt: outcome.readiness.checkedAt,
    reason: outcome.readiness.code,
  });
  row.verification.lastAttempt = result;
  row.verification.latestAppliedAttempt = attempt;
  if (status === 'inconclusive') return;
  row.verification.lastConfirmed = { ...result, status, binding: { ...row.binding } };
  if (status === 'rejected') row.availability = 'disabled';
}
function summary(row: LiveRow) {
  return structuredClone({
    owner: row.owner,
    modality: row.modality,
    provider: row.provider,
    credentialRevision: row.credentialRevision,
    availability: row.availability,
    binding: row.binding,
    verification: row.verification,
    label: row.label,
    metadata: row.metadata,
  });
}
function operationDigest(prepared: PreparedOwnedCredential): string {
  const record: Partial<LiveRow> = { ...prepared.record };
  delete record.operationDigest;
  return digest({ expectedHeadRevision: prepared.expectedHeadRevision, record });
}

/** Caller-owned Serializable transactions must include current owner authority and erasure checks. */
export class OwnedCredentials {
  private readonly prefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly options: {
      namespace: string;
      instanceId: string;
      encryptionKey: CredentialCodecOptions['encryptionKey'];
      descriptors: CredentialCodecOptions['descriptors'];
    },
  ) {
    this.options = { ...options };
    identity.parse(options.namespace);
    revision.parse(options.instanceId);
    this.prefix = `c:${digest([options.namespace, options.instanceId])}:`;
  }
  private ownerPrefix(owner: OwnedCredentialIdentity['owner']): string {
    const parsed = ownerSchema.parse(owner);
    return `${this.prefix}${digest([parsed.subjectId, parsed.generation])}:`;
  }
  private id(target: OwnedCredentialIdentity): string {
    identity.parse(target.modality);
    identity.parse(target.provider);
    return `${this.ownerPrefix(target.owner)}${digest([target.modality, target.provider])}`;
  }
  private codec(target: OwnedCredentialIdentity) {
    return new CredentialCodec({
      namespace: this.id(target),
      encryptionKey: this.options.encryptionKey,
      descriptors: this.options.descriptors,
    });
  }
  private allocation(row: Row) {
    return {
      version: 1 as const,
      namespace: row.namespace,
      instanceId: row.instanceId,
      credentialRevision: row.credentialRevision,
      target: this.id(row),
      operationDigest:
        row.kind === 'owned_credential'
          ? row.operationDigest
          : digest({
              kind: row.kind,
              target: this.id(row),
              expectedHeadRevision: row.previousRevision,
              removalRevision: row.credentialRevision,
            }),
    };
  }
  private allocationBackend(row: Row) {
    return sqlStateBackend(
      this.database,
      this.dialect,
      `r:${digest([this.options.namespace, this.options.instanceId])}:${row.credentialRevision}`,
    );
  }
  private async verifyAllocation(row: Row): Promise<void> {
    const receipt = await this.allocationBackend(row).read();
    if (!receipt || digest(allocationSchema.parse(receipt.state)) !== digest(this.allocation(row)))
      throw new Error('Credential revision allocation mismatch');
  }
  private async allocate(row: Row): Promise<void> {
    if (
      !(await this.allocationBackend(row).compareAndSwap(null, {
        revision: randomUUID(),
        state: this.allocation(row),
      }))
    )
      throw new OwnedCredentialConflictError();
  }
  private parse(value: unknown, id: string): Row {
    const row = rowSchema.parse(value);
    if (
      row.namespace !== this.options.namespace ||
      row.instanceId !== this.options.instanceId ||
      this.id(row) !== id
    )
      throw new Error('Credential ownership context mismatch');
    if (row.kind === 'owned_credential_removed') {
      if (row.previousRevision === row.credentialRevision)
        throw new Error('Invalid credential removal revision');
      return row;
    }
    const stored = row.credentials.providers;
    if (stored.length !== 1 || stored[0]?.provider !== row.provider)
      throw new Error(
        'Personal credentials must contain exactly their selected provider without environment authority',
      );
    if (
      row.credentials.imports.length ||
      row.verification.nextAttempt < 1 ||
      row.verification.latestAppliedAttempt >= row.verification.nextAttempt
    )
      throw new Error('Invalid credential verification state');
    if (
      row.verification.lastConfirmed &&
      digest(row.verification.lastConfirmed.binding) !== digest(row.binding)
    )
      throw new Error('Credential verification binding mismatch');
    const verification = row.verification;
    if (
      (verification.lastAttempt?.attempt ?? 0) !== verification.latestAppliedAttempt ||
      (verification.latestAppliedAttempt === 0) !== (verification.lastAttempt === null) ||
      (verification.lastConfirmed &&
        (verification.lastConfirmed.attempt < 1 ||
          verification.lastConfirmed.attempt > verification.latestAppliedAttempt))
    )
      throw new Error('Invalid credential verification history');
    if (digest(normalizedBinding(row.binding)) !== digest(row.binding))
      throw new Error('Noncanonical credential endpoint binding');
    for (const result of [verification.lastAttempt, verification.lastConfirmed]) {
      if (result?.status === 'verified' && result.reason !== 'ready')
        throw new Error('Invalid verified credential history');
      if (result?.status === 'rejected' && result.reason !== 'not_authenticated')
        throw new Error('Invalid rejected credential history');
    }
    if (
      verification.lastAttempt &&
      verification.lastAttempt.status !== 'inconclusive' &&
      (!verification.lastConfirmed ||
        digest(verification.lastAttempt) !==
          digest({
            attempt: verification.lastConfirmed.attempt,
            status: verification.lastConfirmed.status,
            checkedAt: verification.lastConfirmed.checkedAt,
            reason: verification.lastConfirmed.reason,
          }))
    )
      throw new Error('Credential confirmation history mismatch');
    if (verification.lastConfirmed?.status === 'rejected' && row.availability !== 'disabled')
      throw new Error('Rejected credential cannot be enabled');
    return row;
  }
  private async current(target: OwnedCredentialIdentity) {
    const id = this.id(target);
    const backend = sqlStateBackend(this.database, this.dialect, id);
    const snapshot = await backend.read();
    const row = snapshot ? this.parse(snapshot.state, id) : null;
    if (row) await this.verifyAllocation(row);
    return { backend, snapshot, row };
  }
  async head(target: OwnedCredentialIdentity) {
    const { row } = await this.current(target);
    return {
      revision: row?.credentialRevision ?? null,
      credential: row?.kind === 'owned_credential' ? summary(row) : null,
    };
  }
  /** Prepare once before transaction retries. The receipt hashes ciphertext, never plaintext secrets. */
  prepareReplacement(
    target: OwnedCredentialIdentity,
    input: {
      expectedHeadRevision: string | null;
      credentialRevision: string;
      values: CredentialValues;
      binding: z.infer<typeof bindingSchema>;
      availability: LiveRow['availability'];
      label: string | null;
      metadata: z.infer<typeof metadataSchema>;
      validation?: CredentialValidation;
    },
  ): PreparedOwnedCredential {
    revision.nullable().parse(input.expectedHeadRevision);
    revision.parse(input.credentialRevision);
    if (input.credentialRevision === input.expectedHeadRevision)
      throw new Error('Replacement requires a fresh credential revision');
    const descriptor = this.options.descriptors().find((item) => item.id === target.provider);
    if (!descriptor) throw new CredentialValidationError('Unknown provider');
    for (const field of descriptor.fields) {
      const value = input.values[field.id];
      if (field.required && (value === undefined || (typeof value === 'string' && !value.trim())))
        throw new CredentialValidationError(`Missing required credential field: ${field.id}`);
    }
    const credentials = initialCredentialState();
    if (
      typeof input.values.baseUrl === 'string' &&
      normalizedBinding({ ...input.binding, endpoint: input.values.baseUrl }).endpoint !==
        normalizedBinding(input.binding).endpoint
    )
      throw new Error('Credential endpoint does not match verification binding');
    this.codec(target).configureState(credentials, target.provider, input.values);
    const payload: Omit<LiveRow, 'operationDigest'> = {
      version: 1,
      kind: 'owned_credential',
      namespace: this.options.namespace,
      instanceId: this.options.instanceId,
      owner: ownerSchema.parse(target.owner),
      modality: target.modality,
      provider: target.provider,
      credentialRevision: input.credentialRevision,
      credentials,
      binding: normalizedBinding(input.binding),
      availability: input.availability,
      label: input.label,
      metadata: metadataSchema.parse(input.metadata),
      verification: emptyVerification(),
    };
    if (input.validation) {
      observe(payload, 1, input.validation);
      payload.verification.nextAttempt = 2;
    }
    const record: LiveRow = {
      ...payload,
      operationDigest: digest({ expectedHeadRevision: input.expectedHeadRevision, record: payload }),
    };
    const prepared = { expectedHeadRevision: input.expectedHeadRevision, record };
    this.parse(record, this.id(target));
    return structuredClone(prepared);
  }
  /** Attach a captured probe outcome without encrypting again or changing the operation revision. */
  withValidation(
    prepared: PreparedOwnedCredential,
    validation: CredentialValidation,
  ): PreparedOwnedCredential {
    const row = this.parse(prepared.record, this.id(prepared.record));
    if (row.kind !== 'owned_credential' || row.operationDigest !== operationDigest(prepared))
      throw new Error('Credential replacement receipt mismatch');
    if (digest(row.verification) !== digest(emptyVerification()))
      throw new Error('Credential replacement already has verification');
    observe(row, 1, validation);
    row.verification.nextAttempt = 2;
    const result = { expectedHeadRevision: prepared.expectedHeadRevision, record: row };
    row.operationDigest = operationDigest(result);
    return structuredClone(result);
  }

  async replace(prepared: PreparedOwnedCredential): Promise<'applied' | 'replayed'> {
    const row = this.parse(prepared.record, this.id(prepared.record));
    if (row.kind !== 'owned_credential' || row.operationDigest !== operationDigest(prepared))
      throw new Error('Credential replacement receipt mismatch');
    const current = await this.current(row);
    if (current.row?.credentialRevision === row.credentialRevision) {
      if (current.row.kind === 'owned_credential' && current.row.operationDigest === row.operationDigest)
        return 'replayed';
      throw new OwnedCredentialConflictError();
    }
    if ((current.row?.credentialRevision ?? null) !== prepared.expectedHeadRevision)
      throw new OwnedCredentialConflictError();
    await this.allocate(row);
    if (
      !(await current.backend.compareAndSwap(current.snapshot?.revision ?? null, {
        revision: randomUUID(),
        state: row,
      }))
    )
      throw new OwnedCredentialConflictError();
    return 'applied';
  }
  async resolve(target: OwnedCredentialIdentity, expectedRevision?: string) {
    const { row } = await this.current(target);
    if (!row || row.kind !== 'owned_credential') return null;
    if (expectedRevision !== undefined && row.credentialRevision !== expectedRevision)
      throw new OwnedCredentialConflictError();
    if (row.availability !== 'enabled') throw new Error('Selected credential is disabled');
    return this.decrypted(row);
  }
  /** Caller must authorize editing this owner. Reading never enables a disabled credential. */
  async readForEdit(target: OwnedCredentialIdentity, expectedRevision: string) {
    z.uuid().parse(expectedRevision);
    const { row } = await this.current(target);
    if (!row || row.kind !== 'owned_credential' || row.credentialRevision !== expectedRevision)
      throw new OwnedCredentialConflictError();
    return this.decrypted(row);
  }
  private decrypted(row: LiveRow) {
    const values = this.codec(row).resolveState(row.credentials, row.provider);
    if (
      typeof values.baseUrl === 'string' &&
      normalizedBinding({ ...row.binding, endpoint: values.baseUrl }).endpoint !== row.binding.endpoint
    )
      throw new Error('Credential endpoint does not match verification binding');
    return { ...summary(row), values };
  }
  /** Record an initiated external request, even if this revision was subsequently disabled. */
  async recordUse(
    target: OwnedCredentialIdentity,
    expectedRevision: string,
    usedAt: number,
  ): Promise<'applied' | 'superseded'> {
    timestamp.parse(usedAt);
    const current = await this.current(target);
    const row = current.row;
    if (!row || row.kind !== 'owned_credential' || row.credentialRevision !== expectedRevision)
      return 'superseded';
    if (row.metadata.lastUsedAt !== null && row.metadata.lastUsedAt >= usedAt) return 'applied';
    row.metadata.lastUsedAt = usedAt;
    if (
      !(await current.backend.compareAndSwap(current.snapshot!.revision, {
        revision: randomUUID(),
        state: row,
      }))
    )
      throw new OwnedCredentialConflictError();
    return 'applied';
  }
  async beginVerification(
    target: OwnedCredentialIdentity,
    expectedRevision: string,
  ): Promise<CredentialVerificationTicket | null> {
    const current = await this.current(target);
    const row = current.row;
    if (!row || row.kind !== 'owned_credential' || row.credentialRevision !== expectedRevision) return null;
    const attempt = row.verification.nextAttempt;
    if (attempt === Number.MAX_SAFE_INTEGER) throw new Error('Credential verification sequence exhausted');
    row.verification.nextAttempt++;
    if (
      !(await current.backend.compareAndSwap(current.snapshot!.revision, {
        revision: randomUUID(),
        state: row,
      }))
    )
      throw new OwnedCredentialConflictError();
    return structuredClone({
      owner: row.owner,
      modality: row.modality,
      provider: row.provider,
      credentialRevision: row.credentialRevision,
      attempt,
      binding: row.binding,
    });
  }
  async finishVerification(
    ticket: CredentialVerificationTicket,
    outcome: CredentialValidation,
  ): Promise<'applied' | 'superseded'> {
    const current = await this.current(ticket);
    const row = current.row;
    if (!row || row.kind !== 'owned_credential' || row.credentialRevision !== ticket.credentialRevision)
      return 'superseded';
    sequence.parse(ticket.attempt);
    if (
      ticket.attempt < 1 ||
      ticket.attempt >= row.verification.nextAttempt ||
      digest(normalizedBinding(ticket.binding)) !== digest(row.binding)
    )
      throw new Error('Invalid credential verification ticket');
    if (ticket.attempt <= row.verification.latestAppliedAttempt) return 'superseded';
    observe(row, ticket.attempt, outcome);
    if (
      !(await current.backend.compareAndSwap(current.snapshot!.revision, {
        revision: randomUUID(),
        state: row,
      }))
    )
      throw new OwnedCredentialConflictError();
    return 'applied';
  }
  async remove(
    target: OwnedCredentialIdentity,
    expectedHeadRevision: string | null,
    removalRevision: string,
  ): Promise<'applied' | 'replayed'> {
    const captured = {
      owner: ownerSchema.parse(target.owner),
      modality: identity.parse(target.modality),
      provider: identity.parse(target.provider),
    };
    revision.parse(removalRevision);
    revision.nullable().parse(expectedHeadRevision);
    if (expectedHeadRevision === removalRevision) throw new Error('Removal requires a fresh revision');
    const current = await this.current(captured);
    if (
      current.row?.kind === 'owned_credential_removed' &&
      current.row.credentialRevision === removalRevision &&
      current.row.previousRevision === expectedHeadRevision
    )
      return 'replayed';
    if ((current.row?.credentialRevision ?? null) !== expectedHeadRevision)
      throw new OwnedCredentialConflictError();
    const row: Row = {
      version: 1,
      kind: 'owned_credential_removed',
      namespace: this.options.namespace,
      instanceId: this.options.instanceId,
      ...captured,
      credentialRevision: removalRevision,
      previousRevision: expectedHeadRevision,
    };
    this.parse(row, this.id(captured));
    await this.allocate(row);
    if (
      !(await current.backend.compareAndSwap(current.snapshot?.revision ?? null, {
        revision: randomUUID(),
        state: row,
      }))
    )
      throw new OwnedCredentialConflictError();
    return 'applied';
  }
  private async scan(prefix: string, after: string | null, limit: number, owner: boolean) {
    const rows = await sqlStateRows(
      this.database,
      this.dialect,
      prefix,
      after,
      limit,
      owner ? 'digest' : 'compoundDigest',
    );
    const items = [];
    for (const raw of rows) {
      if (typeof raw.id !== 'string') throw new Error('Invalid credential row identity');
      const row = this.parse(
        this.dialect === 'sqlite' && typeof raw.state === 'string' ? JSON.parse(raw.state) : raw.state,
        raw.id,
      );
      await this.verifyAllocation(row);
      if (row.kind === 'owned_credential') items.push(summary(row));
    }
    const last = rows.at(-1);
    return { items, cursor: rows.length === limit && typeof last?.id === 'string' ? last.id : null };
  }
  list(after: string | null = null, limit = 100) {
    return this.scan(this.prefix, after, limit, false);
  }
  listOwner(owner: OwnedCredentialIdentity['owner'], after: string | null = null, limit = 100) {
    return this.scan(this.ownerPrefix(owner), after, limit, true);
  }
}
