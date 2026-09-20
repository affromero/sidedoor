import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  credentialSaveRequest,
  credentialSaveRequestSchema,
  prepareCredentialRemoval,
  prepareCredentialSave,
  reconcileCredentialMutation,
  type CredentialSettingsSnapshot,
} from '../../src/configuration/credential-client';

function snapshot(): CredentialSettingsSnapshot {
  return {
    context: { instanceId: 'instance', scope: 'ai', owner: { subjectId: 'alice', generation: 1 } },
    heads: { openai: null },
    keys: [],
  };
}

it('keeps confirmation bound to the displayed owner, revision and captured secret', () => {
  const displayed = snapshot();
  const values = { apiKey: 'original-secret' };
  const draft = prepareCredentialSave(displayed, 'openai', { values });
  values.apiKey = 'later-edit';
  displayed.context.owner.subjectId = 'bob';
  displayed.heads.openai = randomUUID();
  expect(credentialSaveRequest(draft, true)).toMatchObject({
    context: { owner: { subjectId: 'alice' } },
    expectedRevision: null,
    operationId: draft.operationId,
    values: { apiKey: 'original-secret' },
    allowUnverified: true,
  });
  expect(() => {
    draft.values!.apiKey = 'mutated-secret';
  }).toThrow();
  const changed = prepareCredentialSave(snapshot(), 'openai', { values });
  expect(changed.operationId).not.toBe(draft.operationId);
});

it('rejects a mixed edit or unknown envelope fields before preparing a save', () => {
  const draft = prepareCredentialSave(snapshot(), 'openai', { values: { apiKey: 'secret' } });
  const request = credentialSaveRequest(draft);
  expect(credentialSaveRequestSchema.safeParse({ ...request, patch: { apiKey: 'other' } }).success).toBe(
    false,
  );
  expect(credentialSaveRequestSchema.safeParse({ ...request, ownerOverride: 'bob' }).success).toBe(false);
});

it('requires the provider to have been present in the displayed snapshot', () => {
  expect(() => prepareCredentialSave(snapshot(), 'anthropic', { values: { apiKey: 'secret' } })).toThrow(
    /displayed/,
  );
  expect(() => prepareCredentialRemoval(snapshot(), 'constructor')).toThrow(/displayed/);
});

it('preserves omitted fields separately from explicit removal in a captured patch', () => {
  const patch = { monthlyCreditLimit: null, usagePlan: 'pro' };
  const draft = prepareCredentialSave(snapshot(), 'openai', { patch });
  patch.usagePlan = 'later-change';
  expect(credentialSaveRequest(draft, true)).toMatchObject({
    patch: { monthlyCreditLimit: null, usagePlan: 'pro' },
  });
});

it('reconciles a saved revision while retaining a subsequent disabled state', () => {
  const draft = prepareCredentialSave(snapshot(), 'openai', { values: { apiKey: 'secret' } });
  const observed = snapshot();
  observed.heads.openai = draft.operationId;
  observed.keys.push({
    provider: 'openai',
    revision: draft.operationId,
    isValid: false,
    verification: {
      lastAttempt: { status: 'rejected', checkedAt: 10 },
      lastConfirmed: { status: 'rejected', checkedAt: 10 },
    },
  });
  expect(reconcileCredentialMutation(draft, observed, 'save')).toMatchObject({
    status: 'confirmed',
    revision: draft.operationId,
    key: { isValid: false },
  });
});

it('does not mistake absence for a confirmed deletion', () => {
  const displayed = snapshot();
  displayed.heads.openai = randomUUID();
  const draft = prepareCredentialRemoval(displayed, 'openai');
  expect(reconcileCredentialMutation(draft, displayed, 'remove')).toEqual({ status: 'unknown' });
  displayed.heads.openai = draft.operationId;
  expect(reconcileCredentialMutation(draft, displayed, 'remove')).toEqual({
    status: 'confirmed',
    revision: draft.operationId,
    key: null,
  });
});

it('rejects reconciliation after owner switching or a newer credential rotation', () => {
  const draft = prepareCredentialRemoval(snapshot(), 'openai');
  const observed = snapshot();
  observed.heads.openai = randomUUID();
  expect(reconcileCredentialMutation(draft, observed, 'remove')).toEqual({ status: 'superseded' });
  observed.heads.openai = draft.operationId;
  observed.context.owner.subjectId = 'bob';
  expect(reconcileCredentialMutation(draft, observed, 'remove')).toEqual({ status: 'context_changed' });
});

it('rejects contradictory credential metadata in a response', () => {
  const draft = prepareCredentialRemoval(snapshot(), 'openai');
  const observed = snapshot();
  observed.heads.openai = draft.operationId;
  observed.keys.push({
    provider: 'openai',
    revision: randomUUID(),
    isValid: true,
    verification: { lastAttempt: null, lastConfirmed: null },
  });
  expect(() => reconcileCredentialMutation(draft, observed, 'save')).toThrow(/inconsistent/);
});
