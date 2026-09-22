import { z } from 'zod';

export const principalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(['owner', 'member']),
  passwordHash: z.string().nullable(),
  epoch: z.number().int().nonnegative(),
  sourceVersion: z.string().optional(),
  pendingRole: z.literal('owner').optional(),
  createdAt: z.number(),
});
export const sessionSchema = z.object({
  id: z.string(),
  selectedProfileId: z.string().min(1).optional(),
  selectedProfileEpoch: z.number().int().nonnegative().optional(),
  selectedProfileSource: z.literal('explicit').optional(),
  principalId: z.string().nullable(),
  epoch: z.number().int(),
  name: z.string(),
  createdAt: z.number(),
  authenticatedAt: z.number(),
  expiresAt: z.number(),
  householdEnrollmentAvailable: z.boolean().optional(),
});
export const passkeyTransportsSchema = z.array(
  z.enum(['usb', 'nfc', 'ble', 'cable', 'internal', 'hybrid', 'smart-card']),
);
const passkeyFields = {
  id: z.string(),
  publicKey: z.string(),
  counter: z.number(),
  transports: passkeyTransportsSchema,
  name: z.string(),
  createdAt: z.number(),
  backedUp: z.boolean(),
};
export const passkeySchema = z.union([
  z.object({ ...passkeyFields, scope: z.literal('principal').optional(), principalId: z.string() }),
  z.object({
    ...passkeyFields,
    scope: z.literal('household'),
    principalId: z.null(),
    householdEpoch: z.number().int().nonnegative(),
  }),
]);
export const challengeSchema = z.object({
  id: z.string(),
  challenge: z.string(),
  kind: z.enum([
    'register',
    'register-household',
    'authenticate',
    'authenticate-household',
    'reauthenticate',
  ]),
  principalId: z.string().nullable(),
  sessionId: z.string().nullable(),
  originalSessionId: z.string().optional(),
  principalEpoch: z.number().int().nonnegative().optional(),
  householdEpoch: z.number().int().nonnegative().optional(),
  verificationAttempts: z.number().int().nonnegative().optional(),
  rpId: z.string(),
  origin: z.string(),
  expiresAt: z.number(),
});
export const tokenSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['claim', 'recover', 'invite', 'pair']),
    principalId: z.string().nullable(),
    expiresAt: z.number(),
    issuerSessionId: z.string().optional(),
    epoch: z.number().int().optional(),
    activatePendingOwner: z.literal(true).optional(),
    scopes: z.array(z.string()).optional(),
    deviceName: z.string().optional(),
    defaultProfileId: z.string().min(1).optional(),
    defaultProfileEpoch: z.number().int().nonnegative().optional(),
  })
  .refine(
    (token) =>
      token.defaultProfileId === undefined
        ? token.defaultProfileEpoch === undefined
        : token.kind === 'pair' && token.principalId === null && token.defaultProfileEpoch !== undefined,
    'Only household pairing tokens can bind a default profile and its generation',
  );
export const deviceTokenSchema = z
  .object({
    id: z.string(),
    principalId: z.string().nullable(),
    issuerSessionId: z.string().nullable(),
    defaultProfileId: z.string().min(1).optional(),
    defaultProfileEpoch: z.number().int().nonnegative().optional(),
    epoch: z.number().int(),
    scopes: z.array(z.string()),
    name: z.string(),
    createdAt: z.number(),
    expiresAt: z.number().finite().nullable(),
  })
  .refine(
    (device) => device.issuerSessionId !== null || device.principalId !== null,
    'Every device requires a session or local operator principal',
  )
  .refine(
    (device) =>
      device.defaultProfileId === undefined
        ? device.defaultProfileEpoch === undefined
        : device.principalId === null && device.defaultProfileEpoch !== undefined,
    'A household default profile requires its generation and cannot grant principal authority',
  );
export const accessStateSchema = z.object({
  version: z.literal(1),
  initializations: z.array(z.string()).default([]),
  mode: z.enum(['household', 'individual']),
  policyEpoch: z.number().int().nonnegative().default(0),
  householdPasswordHash: z.string().nullable(),
  householdEpoch: z.number().int().nonnegative(),
  principals: z.array(principalSchema),
  householdProfiles: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .refine(
      (profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length,
      'Household profile ids must be unique',
    )
    .optional(),
  sessions: z.array(sessionSchema),
  passkeys: z.array(passkeySchema),
  challenges: z.array(challengeSchema),
  tokens: z.array(tokenSchema),
  deviceTokens: z.array(deviceTokenSchema).default([]),
  invitations: z
    .array(
      z.object({
        id: z.string(),
        issuerPrincipalId: z.string(),
        issuerEpoch: z.number().int(),
        policyEpoch: z.number().int(),
        householdEpoch: z.number().int(),
        mode: z.enum(['household', 'individual']),
        remaining: z.number().int().positive().nullable(),
        expiresAt: z.number(),
      }),
    )
    .default([]),
  recoveryCodes: z.array(z.object({ id: z.string(), principalId: z.string() })),
  failures: z.array(z.object({ key: z.string(), count: z.number().int(), expiresAt: z.number() })),
});
export type AccessState = z.infer<typeof accessStateSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Passkey = z.infer<typeof passkeySchema>;
export type Challenge = z.infer<typeof challengeSchema>;
export function initialAccessState(): AccessState {
  return {
    version: 1,
    initializations: [],
    mode: 'household',
    policyEpoch: 0,
    householdPasswordHash: null,
    householdEpoch: 0,
    principals: [],
    sessions: [],
    passkeys: [],
    challenges: [],
    tokens: [],
    deviceTokens: [],
    invitations: [],
    recoveryCodes: [],
    failures: [],
  };
}
