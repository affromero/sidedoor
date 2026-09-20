import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../storage/sql/sql';

const identity = z.string().min(1).max(200);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const owner = z.object({ subjectId: identity, generation: revision }).strict();
const slot = z.object({ modality: identity, provider: identity }).strict();
const policy = z
  .object({
    owner,
    audience: z.literal('household'),
    excludedRecipients: z.array(owner).max(10000),
    source: z.enum(['explicit', 'imported']),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.excludedRecipients.map((recipient) => JSON.stringify(recipient))).size ===
      value.excludedRecipients.length,
    'Duplicate excluded recipient',
  );
const rowSchema = slot
  .extend({
    version: z.literal(1),
    namespace: identity,
    instanceId: z.uuid(),
    policyRevision: revision,
    policy: policy.nullable(),
  })
  .strict();
export type CredentialSharingSlot = z.infer<typeof slot>;
export type CredentialSharingPolicy = z.infer<typeof policy>;
type Row = z.infer<typeof rowSchema>;

export class CredentialSharingConflictError extends Error {
  constructor() {
    super('Credential sharing changed during the operation');
  }
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Instance-owned policy, independent of credential rotation and the key owner's role.
 * Callers authorize policy changes and validate owner generation, recipient admission
 * and erasure fences in the same Serializable transaction as credential selection.
 * Retained removed heads prevent delayed changes from resurrecting revoked sharing.
 */
export class CredentialSharing {
  private readonly prefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
    private readonly instanceId: string,
  ) {
    identity.parse(namespace);
    z.uuid().parse(instanceId);
    this.prefix = `g:${digest([namespace, instanceId])}:`;
  }
  private id(target: CredentialSharingSlot) {
    const parsed = slot.parse(target);
    return `${this.prefix}${digest([parsed.modality, parsed.provider])}`;
  }
  private parse(value: unknown, id: string) {
    const row = rowSchema.parse(value);
    if (
      row.namespace !== this.namespace ||
      row.instanceId !== this.instanceId ||
      this.id({ modality: row.modality, provider: row.provider }) !== id
    )
      throw new Error('Credential sharing context mismatch');
    return row;
  }
  private async current(target: CredentialSharingSlot) {
    const id = this.id(target);
    const backend = sqlStateBackend(this.database, this.dialect, id);
    const snapshot = await backend.read();
    return { backend, snapshot, row: snapshot ? this.parse(snapshot.state, id) : null };
  }
  async head(target: CredentialSharingSlot) {
    const { row } = await this.current(target);
    return { revision: row?.policyRevision ?? null, policy: row ? structuredClone(row.policy) : null };
  }
  async set(target: CredentialSharingSlot, expectedRevision: number | null, value: CredentialSharingPolicy) {
    return this.write(target, expectedRevision, policy.parse(value));
  }
  async remove(target: CredentialSharingSlot, expectedRevision: number | null) {
    return this.write(target, expectedRevision, null);
  }
  private async write(
    target: CredentialSharingSlot,
    expectedRevision: number | null,
    value: CredentialSharingPolicy | null,
  ) {
    const captured = slot.parse(target);
    revision.nullable().parse(expectedRevision);
    const current = await this.current(captured);
    if ((current.row?.policyRevision ?? null) !== expectedRevision)
      throw new CredentialSharingConflictError();
    if (expectedRevision === Number.MAX_SAFE_INTEGER)
      throw new Error('Credential sharing revision exhausted');
    const row: Row = {
      ...captured,
      version: 1,
      namespace: this.namespace,
      instanceId: this.instanceId,
      policyRevision: expectedRevision === null ? 0 : expectedRevision + 1,
      policy: value,
    };
    if (
      !(await current.backend.compareAndSwap(current.snapshot?.revision ?? null, {
        revision: randomUUID(),
        state: row,
      }))
    )
      throw new CredentialSharingConflictError();
    return row.policyRevision;
  }
  async list(after: string | null = null, limit = 100) {
    const rows = await sqlStateRows(this.database, this.dialect, this.prefix, after, limit);
    const items = [];
    for (const raw of rows) {
      if (typeof raw.id !== 'string') throw new Error('Invalid credential sharing row');
      const row = this.parse(
        this.dialect === 'sqlite' && typeof raw.state === 'string' ? JSON.parse(raw.state) : raw.state,
        raw.id,
      );
      if (row.policy)
        items.push({
          modality: row.modality,
          provider: row.provider,
          revision: row.policyRevision,
          policy: row.policy,
        });
    }
    const last = rows.at(-1);
    return { items, cursor: rows.length === limit && typeof last?.id === 'string' ? last.id : null };
  }
}

/** Requires a validated policy from head/list and canonical household admission. Does not authorize a request. */
export function householdCredentialRecipient(
  policy: CredentialSharingPolicy,
  recipient: z.infer<typeof owner>,
): boolean {
  const parsed = owner.parse(recipient);
  return !policy.excludedRecipients.some(
    (excluded) => excluded.subjectId === parsed.subjectId && excluded.generation === parsed.generation,
  );
}
