import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { normalizeStorageReference, storageBackendBinding } from './references';
import { sqlStateBackend, type SqlExecutor } from '../sql/sql';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const namespaceSchema = z.string().min(1).max(200);
const rootSchema = z
  .string()
  .refine(
    (root) =>
      isAbsolute(root) &&
      resolve(root) === root &&
      ![...root].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
  );
const decimalSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);

export const storageCleanupDescriptorSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('local'),
        identity: z
          .object({ root: rootSchema, device: decimalSchema, inode: decimalSchema, binding: digestSchema })
          .strict(),
        referenceRoot: rootSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('object'),
        location: z
          .object({ kind: z.literal('object'), endpoint: z.string().min(1), bucket: z.string().min(1) })
          .strict(),
        binding: digestSchema,
        access: z
          .object({
            provider: z.string().min(1).max(100),
            credentialRevision: z.uuid(),
            signingRegion: z.string().min(1).max(100),
          })
          .strict()
          .nullable()
          .default(null),
        publicUrl: z.string().nullable().default(null),
        referenceEncoding: z.enum(['raw', 'percent']).default('raw'),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    try {
      const binding =
        value.kind === 'local'
          ? storageBackendBinding({ kind: 'local', root: value.identity.root })
          : storageBackendBinding(value.location);
      if (binding !== (value.kind === 'local' ? value.identity.binding : value.binding))
        throw new Error('Binding mismatch');
      if (value.kind === 'object' && value.publicUrl !== null) {
        normalizeStorageReference(
          value.location,
          `${value.publicUrl.replace(/\/$/, '')}/__reference_validation__`,
          {
            publicUrl: value.publicUrl,
            publicUrlEncoding: value.referenceEncoding,
          },
        );
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Storage descriptor does not match a valid backend location',
      });
    }
  });
export type StorageCleanupDescriptor = z.infer<typeof storageCleanupDescriptorSchema>;

const registrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('storage_backend'),
    namespace: namespaceSchema,
    id: digestSchema,
    binding: digestSchema,
    descriptor: storageCleanupDescriptorSchema,
  })
  .strict();
export type PreparedStorageBackend = z.infer<typeof registrationSchema>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Historical aliases and their encoding are immutable snapshots, separate from physical bindings. */
export function prepareStorageBackend(
  namespace: string,
  input: z.input<typeof storageCleanupDescriptorSchema>,
): PreparedStorageBackend {
  const descriptor = storageCleanupDescriptorSchema.parse(input);
  return registrationSchema.parse({
    schemaVersion: 1,
    kind: 'storage_backend',
    namespace,
    id: digest(JSON.stringify(descriptor)),
    binding: descriptor.kind === 'local' ? descriptor.identity.binding : descriptor.binding,
    descriptor,
  });
}

/** Caller-owned SQL transactions retain descriptors as long as any intent or cleanup target references them. */
export class StorageBackendRegistry {
  private readonly namespaceHash: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    namespaceSchema.parse(namespace);
    this.namespaceHash = digest(namespace);
  }

  private backend(id: string) {
    digestSchema.parse(id);
    return sqlStateBackend(this.database, this.dialect, `sd-b:1:${this.namespaceHash}:${id}`);
  }

  private validate(input: unknown): PreparedStorageBackend {
    const registration = registrationSchema.parse(input);
    const canonical = prepareStorageBackend(this.namespace, registration.descriptor);
    if (
      registration.namespace !== this.namespace ||
      registration.id !== canonical.id ||
      registration.binding !== canonical.binding
    )
      throw new Error('Storage backend registration identity mismatch');
    return canonical;
  }

  async get(id: string): Promise<PreparedStorageBackend | null> {
    const record = await this.backend(id).read();
    if (!record) return null;
    const registration = this.validate(record.state);
    if (registration.id !== id) throw new Error('Storage backend registration identity mismatch');
    return registration;
  }

  async register(prepared: PreparedStorageBackend): Promise<void> {
    const registration = this.validate(prepared);
    const previous = await this.get(registration.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(registration))
        throw new Error('Storage backend registration changed');
      return;
    }
    if (
      !(await this.backend(registration.id).compareAndSwap(null, {
        revision: randomUUID(),
        state: registration,
      }))
    )
      throw new Error('Storage backend registration changed concurrently');
  }
}
