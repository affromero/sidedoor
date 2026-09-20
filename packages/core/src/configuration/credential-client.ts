import { z } from 'zod';

const revision = z.uuid();
const fieldValue = z.union([z.string(), z.number().finite(), z.boolean()]);
export const credentialEditContextSchema = z
  .object({
    instanceId: z.string().min(1),
    scope: z.string().min(1),
    owner: z.object({ subjectId: z.string().min(1), generation: z.number().int().nonnegative() }).strict(),
  })
  .strict();

const attempt = z.object({
  status: z.enum(['verified', 'rejected', 'inconclusive']),
  checkedAt: z.number().finite().nonnegative(),
});
export const credentialSettingsKeySchema = z.object({
  provider: z.string().min(1),
  revision,
  isValid: z.boolean(),
  verification: z.object({
    lastAttempt: attempt.nullable(),
    lastConfirmed: attempt.extend({ status: z.enum(['verified', 'rejected']) }).nullable(),
  }),
});

export const credentialSettingsSnapshotSchema = z
  .object({
    context: credentialEditContextSchema,
    heads: z.record(z.string(), revision.nullable()),
    keys: z.array(credentialSettingsKeySchema),
  })
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    for (const key of snapshot.keys) {
      if (
        seen.has(key.provider) ||
        !Object.hasOwn(snapshot.heads, key.provider) ||
        snapshot.heads[key.provider] !== key.revision
      )
        context.addIssue({ code: 'custom', message: 'Credential snapshot contains inconsistent revisions' });
      seen.add(key.provider);
    }
  });

const mutation = z.object({
  context: credentialEditContextSchema,
  provider: z.string().min(1),
  expectedRevision: revision.nullable(),
  operationId: revision,
});
export const credentialRemovalRequestSchema = mutation.strict();
const completeEdit = mutation.extend({ values: z.record(z.string(), fieldValue) });
const patchEdit = mutation.extend({ patch: z.record(z.string(), fieldValue.nullable()) });
const draftSchema = z.union([completeEdit.strict(), patchEdit.strict()]);
export const credentialSaveRequestSchema = z.union([
  completeEdit.extend({ allowUnverified: z.boolean() }).strict(),
  patchEdit.extend({ allowUnverified: z.boolean() }).strict(),
]);

export type CredentialEditContext = z.infer<typeof credentialEditContextSchema>;
export type CredentialSettingsSnapshot = z.infer<typeof credentialSettingsSnapshotSchema>;
export type CredentialSettingsKey = z.infer<typeof credentialSettingsKeySchema>;
export type CredentialSaveRequest = z.infer<typeof credentialSaveRequestSchema>;
export type CredentialRemovalRequest = z.infer<typeof credentialRemovalRequestSchema>;
export type CredentialEdit =
  | { values: Record<string, string | number | boolean>; patch?: never }
  | { values?: never; patch: Record<string, string | number | boolean | null> };
export type CredentialSaveDraft = Readonly<CredentialRemovalRequest & CredentialEdit>;

function capturedTarget(snapshot: CredentialSettingsSnapshot, provider: string) {
  const captured = credentialSettingsSnapshotSchema.parse(snapshot);
  if (!Object.hasOwn(captured.heads, provider))
    throw new Error('Provider was not present in the displayed settings');
  Object.freeze(captured.context.owner);
  Object.freeze(captured.context);
  return {
    context: captured.context,
    provider,
    expectedRevision: captured.heads[provider]!,
    operationId: globalThis.crypto.randomUUID(),
  };
}

/** Prepare from displayed state. Changed content always gets a new operation identity. */
export function prepareCredentialSave(
  snapshot: CredentialSettingsSnapshot,
  provider: string,
  edit: CredentialEdit,
): CredentialSaveDraft {
  const request = draftSchema.parse({
    ...capturedTarget(snapshot, provider),
    ...structuredClone(edit),
  });
  Object.freeze(request.context.owner);
  Object.freeze(request.context);
  if ('values' in request) Object.freeze(request.values);
  else Object.freeze(request.patch);
  return Object.freeze(request);
}

/** Confirmation changes only consent. The captured owner, revision and edited values stay fixed. */
export function credentialSaveRequest(
  draft: CredentialSaveDraft,
  allowUnverified = false,
): CredentialSaveRequest {
  return credentialSaveRequestSchema.parse({ ...structuredClone(draft), allowUnverified });
}

export function prepareCredentialRemoval(
  snapshot: CredentialSettingsSnapshot,
  provider: string,
): Readonly<CredentialRemovalRequest> {
  return Object.freeze(capturedTarget(snapshot, provider));
}

export function sameCredentialEditContext(
  left: CredentialEditContext,
  right: CredentialEditContext,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.scope === right.scope &&
    left.owner.subjectId === right.owner.subjectId &&
    left.owner.generation === right.owner.generation
  );
}

/** Reconcile an uncertain response with a fresh authenticated, uncached snapshot. Never resubmits. */
export function reconcileCredentialMutation(
  request: CredentialRemovalRequest,
  value: unknown,
  kind: 'save' | 'remove',
):
  | { status: 'confirmed'; revision: string; key: CredentialSettingsKey | null }
  | { status: 'context_changed' | 'superseded' | 'unknown' } {
  const target = credentialRemovalRequestSchema.parse({
    context: request.context,
    provider: request.provider,
    expectedRevision: request.expectedRevision,
    operationId: request.operationId,
  });
  const snapshot = credentialSettingsSnapshotSchema.parse(value);
  if (!sameCredentialEditContext(target.context, snapshot.context)) return { status: 'context_changed' };
  if (!Object.hasOwn(snapshot.heads, target.provider)) return { status: 'unknown' };
  const head = snapshot.heads[target.provider];
  if (head !== target.operationId)
    return { status: head === target.expectedRevision ? 'unknown' : 'superseded' };
  const key = snapshot.keys.find((item) => item.provider === target.provider) ?? null;
  if ((kind === 'save') !== (key !== null)) return { status: 'unknown' };
  return { status: 'confirmed', revision: target.operationId, key };
}
