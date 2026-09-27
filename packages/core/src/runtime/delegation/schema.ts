import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.object({ id: identifier, generation: integer }).strict();

/** Opaque identities only. Applications own current generation and action authorization. */
export const delegationGrantSchema = z
  .object({
    id: z.uuid(),
    revision: z.uuid(),
    instanceId: z.uuid(),
    subject: scope,
    resource: scope,
    operationId: z.uuid(),
    action: identifier,
    expiresAt: integer,
    maxRequests: z.number().int().min(1).max(1000),
  })
  .strict();
export const delegationBindingSchema = z
  .object({ id: z.uuid(), revision: z.uuid(), fingerprint: digest })
  .strict();
export const delegationAttemptInputSchema = z.object({ id: z.uuid(), fingerprint: digest }).strict();
export const delegationOutcomeSchema = z.enum(['succeeded', 'failed', 'unknown']);
export const delegationAttemptSchema = delegationAttemptInputSchema
  .extend({
    number: z.number().int().min(1).max(1000),
    admittedAt: integer,
    outcome: z.enum(['admitted', 'succeeded', 'failed', 'unknown']),
    settledAt: integer.optional(),
  })
  .strict()
  .refine((attempt) => (attempt.outcome === 'admitted') === (attempt.settledAt === undefined));
export const delegationActivitySchema = z
  .object({
    sequence: integer.positive(),
    at: integer,
    type: z.enum(['created', 'admitted', 'succeeded', 'failed', 'unknown', 'revoked', 'completed']),
    attemptId: z.uuid().optional(),
  })
  .strict()
  .refine((event) =>
    ['created', 'revoked', 'completed'].includes(event.type)
      ? event.attemptId === undefined
      : event.attemptId !== undefined,
  );

export const delegationRecordSchema = z
  .object({
    version: z.literal(1),
    grant: delegationGrantSchema,
    binding: delegationBindingSchema,
    status: z.enum(['active', 'revoked', 'completed']),
    attempts: z.array(delegationAttemptSchema).max(1000),
    sequence: integer.positive(),
    activity: z.array(delegationActivitySchema).min(1).max(128),
  })
  .strict();

export type DelegationGrant = z.infer<typeof delegationGrantSchema>;
export type DelegationBinding = z.infer<typeof delegationBindingSchema>;
export type DelegationAttemptInput = z.infer<typeof delegationAttemptInputSchema>;
export type DelegationAttempt = z.infer<typeof delegationAttemptSchema>;
export type DelegationOutcome = z.infer<typeof delegationOutcomeSchema>;
export type DelegationActivity = z.infer<typeof delegationActivitySchema>;
export type DelegationRecord = z.infer<typeof delegationRecordSchema>;
