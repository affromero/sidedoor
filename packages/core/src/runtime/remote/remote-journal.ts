import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { StateStore } from '../../storage/index';
import { agentInvocation } from '../process/environment';

const identity = z.string().regex(/^[a-f0-9]{32}$/);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'));
const connection = z
  .object({
    host: z.string().min(1).max(1024),
    identityFile: path.optional(),
    knownHostsFile: path.optional(),
  })
  .strict()
  .refine((value) => {
    try {
      agentInvocation('true', [], value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid SSH connection');
export const remoteHostKeySchema = z
  .object({
    algorithm: z.enum([
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'ssh-rsa',
    ]),
    key: z
      .string()
      .min(16)
      .max(16384)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
const reason = z.enum(['transport_failed', 'cleanup_failed', 'protocol_failed', 'insufficient_containment']);
const binding = z
  .object({
    connection,
    hostKey: remoteHostKeySchema,
    remoteUser: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/),
    operationRoot: path.refine((value) => value.startsWith('/') && posix.resolve(value) === value),
    consumer: z
      .object({ id: z.string().min(1).max(200), generation: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();
const record = binding
  .extend({
    operationId: identity,
    registrationToken: identity,
    createdAt: z.number().int().nonnegative(),
    cancelAfter: z.number().int().nonnegative(),
    status: z.enum(['prepared', 'active', 'uncertain']),
    reason: reason.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.cancelAfter > value.createdAt &&
      (value.status === 'uncertain' ? value.reason !== undefined : value.reason === undefined),
  );
export const remoteJournalStateSchema = z
  .object({
    version: z.literal(1),
    operations: z.array(record).max(100_000),
  })
  .strict()
  .refine(
    (value) => new Set(value.operations.map((item) => item.operationId)).size === value.operations.length,
    'Duplicate remote operation identity',
  );
export type RemoteJournalState = z.infer<typeof remoteJournalStateSchema>;
export type RemoteOperation = z.infer<typeof record>;
export type RemoteHostKey = z.infer<typeof remoteHostKeySchema>;
export const initialRemoteJournalState = (): RemoteJournalState => ({ version: 1, operations: [] });

export interface RemoteCleanupReceipt {
  operationId: string;
  remoteUser: string;
  operationRoot: string;
  /** The key enforced by the SSH transport, never an unverified remote JSON field. */
  hostKey: RemoteHostKey;
  containment: 'descendants' | 'process-group';
}

/** Private recovery metadata. Never expire or evict operations whose cleanup is unconfirmed. */
export class RemoteOperationJournal {
  private readonly now: () => number;
  private readonly maximum: number;
  constructor(
    private readonly options: {
      store: StateStore<RemoteJournalState>;
      now?: () => number;
      maxPending?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.maximum = options.maxPending ?? 10_000;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 100_000)
      throw new Error('Invalid remote operation capacity');
  }

  /** The runner must enforce this maximum lifetime, including upload and cleanup allowance. */
  async register(input: z.infer<typeof binding> & { maximumLifetimeMs: number }): Promise<RemoteOperation> {
    const { maximumLifetimeMs, ...details } = input;
    if (!Number.isSafeInteger(maximumLifetimeMs) || maximumLifetimeMs < 1 || maximumLifetimeMs > 86_460_000)
      throw new Error('Invalid remote operation lifetime');
    const createdAt = this.now();
    const prepared = record.parse({
      ...binding.parse(details),
      operationId: randomBytes(16).toString('hex'),
      registrationToken: randomBytes(16).toString('hex'),
      createdAt,
      cancelAfter: createdAt + maximumLifetimeMs,
      status: 'prepared',
    });
    return this.options.store.transact((state) => {
      if (state.operations.length >= this.maximum)
        throw new Error('Unconfirmed remote operation capacity reached');
      if (state.operations.some((item) => item.operationId === prepared.operationId))
        throw new Error('Remote operation identity collision');
      state.operations.push(prepared);
      return prepared;
    });
  }

  async pending(): Promise<RemoteOperation[]> {
    return structuredClone((await this.options.store.read()).operations);
  }

  async current(expected: RemoteOperation): Promise<RemoteOperation | undefined> {
    const current = this.match(await this.options.store.read(), expected);
    return current ? structuredClone(current) : undefined;
  }

  /** Persist before spawning SSH. An uncertain write result must prevent execution. */
  async connecting(expected: RemoteOperation): Promise<void> {
    await this.options.store.transact((state) => {
      const current = this.match(state, expected);
      if (!current || current.status !== 'prepared')
        throw new Error('Remote execution was already admitted or cancelled');
      if (current.cancelAfter <= this.now()) throw new Error('Remote operation deadline expired');
      current.status = 'active';
    });
  }

  /** Only a durable pre-connection record can be discarded without a remote receipt. */
  async discardUnstarted(expected: RemoteOperation): Promise<void> {
    await this.options.store.transact((state) => {
      const current = this.match(state, expected);
      if (!current) return;
      if (current.status !== 'prepared') throw new Error('Remote operation may have connected');
      state.operations = state.operations.filter((item) => item.operationId !== current.operationId);
    });
  }

  /** Deadline expiry authorizes timeout cancellation. It does not prove remote termination. */
  async dueForCancellation(): Promise<RemoteOperation[]> {
    const now = this.now();
    return (await this.pending()).filter((item) => item.status === 'uncertain' || item.cancelAfter <= now);
  }

  async uncertain(expected: RemoteOperation, failure: z.infer<typeof reason>): Promise<void> {
    const safe = reason.parse(failure);
    await this.options.store.transact((state) => {
      const current = this.match(state, expected);
      if (!current) return;
      current.status = 'uncertain';
      current.reason = safe;
    });
  }

  async acknowledge(expected: RemoteOperation, receipt: RemoteCleanupReceipt): Promise<boolean> {
    const hostKey = remoteHostKeySchema.parse(receipt.hostKey);
    if (
      receipt.operationId !== expected.operationId ||
      hostKey.algorithm !== expected.hostKey.algorithm ||
      hostKey.key !== expected.hostKey.key ||
      receipt.remoteUser !== expected.remoteUser ||
      receipt.operationRoot !== expected.operationRoot
    )
      throw new Error('Remote cleanup identity mismatch');
    if (receipt.containment !== 'descendants' && receipt.containment !== 'process-group')
      throw new Error('Invalid remote cleanup containment');
    return this.options.store.transact((state) => {
      const current = this.match(state, expected);
      if (!current) return true;
      if (receipt.containment !== 'descendants') {
        current.status = 'uncertain';
        current.reason = 'insufficient_containment';
        return false;
      }
      state.operations = state.operations.filter((item) => item.operationId !== current.operationId);
      return true;
    });
  }

  private match(state: RemoteJournalState, expected: RemoteOperation): RemoteOperation | undefined {
    const current = state.operations.find((item) => item.operationId === expected.operationId);
    if (!current) return undefined;
    if (
      current.registrationToken !== expected.registrationToken ||
      JSON.stringify(binding.strip().parse(current)) !== JSON.stringify(binding.strip().parse(expected))
    )
      throw new Error('Remote operation registration changed');
    return current;
  }
}
