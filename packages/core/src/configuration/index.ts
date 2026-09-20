import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ProviderDescriptor } from '../ai/browser';
import type { CredentialStore, CredentialValues } from '../ai/index';
import type { StateStore } from '../storage/index';

const valuesSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()]));
const quarantineSchema = z
  .object({
    sourceFormat: z.string().min(1).max(200),
    sourceVersion: z.number().int().positive().safe(),
    payload: z
      .string()
      .min(1)
      .max(1024 * 1024),
    failure: z.enum(['decryption_failed', 'invalid_format']),
  })
  .strict();
export type CredentialQuarantine = z.infer<typeof quarantineSchema>;
const storedQuarantineSchema = quarantineSchema
  .omit({ payload: true })
  .extend({ encryptedPayload: z.string().min(1) });
const recordSchema = z
  .object({
    provider: z.string(),
    encrypted: z.string().nullable(),
    publicValues: valuesSchema.default({}),
    endpointBinding: z.string().optional(),
    updatedAt: z.number(),
    quarantine: storedQuarantineSchema.optional(),
  })
  .superRefine((record, context) => {
    if (
      record.quarantine &&
      (record.encrypted !== null || Object.keys(record.publicValues).length > 0 || record.endpointBinding)
    )
      context.addIssue({
        code: 'custom',
        message: 'Quarantined credentials cannot contain executable configuration',
      });
  });
export const credentialStateSchema = z.object({
  version: z.literal(2),
  imports: z.array(z.string()).default([]),
  providers: z.array(recordSchema),
});
export type CredentialState = z.infer<typeof credentialStateSchema>;
export const initialCredentialState = (): CredentialState => ({ version: 2, imports: [], providers: [] });
export interface CredentialCodecOptions {
  encryptionKey?: Uint8Array | (() => Uint8Array);
  namespace: string;
  descriptors: () => readonly ProviderDescriptor[];
}
export interface VaultOptions extends CredentialCodecOptions {
  store: StateStore<CredentialState>;
}

export class CredentialDecryptionError extends Error {
  constructor(readonly provider: string) {
    super(`Stored credentials for ${provider} are unavailable`);
  }
}

export class CredentialValidationError extends Error {
  readonly code = 'invalid_credentials';
}

export class CredentialRepairRequiredError extends CredentialDecryptionError {
  readonly code = 'credential_repair_required';
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid provider endpoint binding');
  return url.href.replace(/\/+$/, '');
}

/** App authorization occurs before mutation. Runtime resolution never returns a different provider. */
export class CredentialCodec {
  constructor(private readonly options: CredentialCodecOptions) {
    if (!options.namespace) throw new Error('A credential namespace is required');
  }

  private key(): Buffer {
    const key =
      typeof this.options.encryptionKey === 'function'
        ? this.options.encryptionKey()
        : this.options.encryptionKey;
    if (!key || key.byteLength !== 32)
      throw new Error('A persistent 32-byte encryption key is required for stored credentials');
    return Buffer.from(key);
  }

  private descriptor(provider: string): ProviderDescriptor {
    const descriptor = this.options.descriptors().find((item) => item.id === provider);
    if (!descriptor) throw new Error(`Unknown provider: ${provider}`);
    return descriptor;
  }

  private storedValues(record: z.infer<typeof recordSchema>): CredentialValues {
    if (record.quarantine) throw new CredentialRepairRequiredError(record.provider);
    const descriptor = this.descriptor(record.provider);
    for (const [id, value] of Object.entries(record.publicValues ?? {})) {
      const field = descriptor.fields.find((item) => item.id === id);
      if (!field || field.secret || typeof value !== field.kind)
        throw new Error('Invalid public provider configuration');
    }
    try {
      return {
        ...record.publicValues,
        ...(record.encrypted ? this.decrypt(record.provider, record.encrypted) : {}),
      };
    } catch {
      throw new CredentialDecryptionError(record.provider);
    }
  }

  private encrypt(
    provider: string,
    values: CredentialValues,
    purpose: 'credentials' | 'quarantine' = 'credentials',
  ): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(
      Buffer.from(
        `${this.options.namespace}:${provider}:${purpose === 'quarantine' ? 'quarantine:v1' : 'v1'}`,
      ),
    );
    const content = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      content.toString('base64url'),
    ].join('.');
  }

  private decrypt(
    provider: string,
    encoded: string,
    purpose: 'credentials' | 'quarantine' = 'credentials',
  ): CredentialValues {
    const parts = encoded.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || !parts[1] || !parts[2] || !parts[3])
      throw new Error('Invalid credential envelope');
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid credential envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAAD(
      Buffer.from(
        `${this.options.namespace}:${provider}:${purpose === 'quarantine' ? 'quarantine:v1' : 'v1'}`,
      ),
    );
    decipher.setAuthTag(tag);
    return valuesSchema.parse(
      JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString(
          'utf8',
        ),
      ),
    );
  }

  resolveState(state: CredentialState, provider: string): CredentialValues {
    this.descriptor(provider);
    const record = state.providers.find((item) => item.provider === provider);
    if (!record) return {};
    const stored = this.storedValues(record);
    const values = { ...stored };
    if (stored.compatibleApiKey !== undefined) {
      const boundEndpoint = record.endpointBinding ?? stored.baseUrl;
      if (
        typeof boundEndpoint !== 'string' ||
        typeof values.baseUrl !== 'string' ||
        endpoint(boundEndpoint) !== endpoint(values.baseUrl)
      )
        delete values.compatibleApiKey;
    }
    // Endpoint credentials are bound to their endpoint, independently of official API credentials.
    return values;
  }

  /** Operator import only. Preserve unreadable input without making it executable. */
  quarantineState(state: CredentialState, provider: string, input: CredentialQuarantine): void {
    this.descriptor(provider);
    const quarantine = quarantineSchema.parse(input);
    const marker = `credential-quarantine:v1:${createHmac('sha256', this.key())
      .update(
        JSON.stringify(['credential-quarantine-import:v1', this.options.namespace, provider, quarantine]),
      )
      .digest('hex')}`;
    const existing = state.providers.find((record) => record.provider === provider);
    if (existing?.quarantine) {
      if (!isDeepStrictEqual(this.readQuarantineState(state, provider), quarantine))
        throw new CredentialValidationError('The credential import conflicts with an existing record');
      state.version = 2;
      if (!state.imports.includes(marker)) state.imports.push(marker);
      return;
    }
    if (state.imports.includes(marker)) return;
    if (existing)
      throw new CredentialValidationError('The credential import conflicts with an existing record');
    const retained = {
      sourceFormat: quarantine.sourceFormat,
      sourceVersion: quarantine.sourceVersion,
      failure: quarantine.failure,
      encryptedPayload: this.encrypt(provider, { payload: JSON.stringify(quarantine) }, 'quarantine'),
    };
    // Readers reject this version instead of stripping quarantine records.
    state.version = 2;
    state.providers.push({
      provider,
      encrypted: null,
      publicValues: {},
      updatedAt: Date.now(),
      quarantine: retained,
    });
    state.imports.push(marker);
  }

  /** Operator repair only. The caller must authorize access to the retained secret payload. */
  readQuarantineState(state: CredentialState, provider: string): CredentialQuarantine | null {
    this.descriptor(provider);
    const retained = state.providers.find((record) => record.provider === provider)?.quarantine;
    if (!retained) return null;
    try {
      const decoded = this.decrypt(provider, retained.encryptedPayload, 'quarantine');
      if (typeof decoded.payload !== 'string') throw new Error('Invalid quarantine payload');
      const original = quarantineSchema.parse(JSON.parse(decoded.payload));
      if (
        original.sourceFormat !== retained.sourceFormat ||
        original.sourceVersion !== retained.sourceVersion ||
        original.failure !== retained.failure
      )
        throw new Error('Quarantine metadata changed');
      return original;
    } catch {
      throw new CredentialDecryptionError(provider);
    }
  }

  /** Explicit repair. The caller must authorize and fence its revision in the same transaction. */
  replaceState(state: CredentialState, provider: string, values: CredentialValues): void {
    const next = structuredClone(state);
    this.removeState(next, provider);
    this.configureState(next, provider, values);
    Object.assign(state, next);
  }

  /** Apply within the same transaction as the caller's selection and authorization changes. */
  configureState(
    state: CredentialState,
    provider: string,
    patch: Record<string, string | number | boolean | null>,
  ): void {
    const descriptor = this.descriptor(provider);
    for (const [key, value] of Object.entries(patch)) {
      const field = descriptor.fields.find((item) => item.id === key);
      if (
        !field ||
        (value !== null && typeof value !== field.kind) ||
        (typeof value === 'string' && value.length > 16384) ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new CredentialValidationError('Invalid provider credential field');
    }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl) {
      try {
        endpoint(patch.baseUrl);
      } catch {
        throw new CredentialValidationError(
          'Endpoint must be an HTTP(S) URL without credentials, query, or fragment',
        );
      }
    }
    const record = state.providers.find((item) => item.provider === provider);
    const values = record ? this.storedValues(record) : {};
    const endpointChanged = Object.hasOwn(patch, 'baseUrl') && patch.baseUrl !== values.baseUrl;
    if (endpointChanged) {
      if (!Object.hasOwn(patch, 'compatibleApiKey')) delete values.compatibleApiKey;
      if (!Object.hasOwn(patch, 'allowAnonymous')) delete values.allowAnonymous;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete values[key];
      else values[key] = value;
    }
    const validated = valuesSchema.parse(values);
    if (Object.keys(validated).length === 0) {
      state.providers = state.providers.filter((item) => item.provider !== provider);
      return;
    }
    const secrets: CredentialValues = {};
    const publicValues: CredentialValues = {};
    for (const [id, value] of Object.entries(validated)) {
      const field = descriptor.fields.find((item) => item.id === id);
      if (!field) throw new Error('Unknown stored provider field');
      (field.secret ? secrets : publicValues)[id] = value;
    }
    const encrypted = Object.keys(secrets).length ? this.encrypt(provider, secrets) : null;
    let endpointBinding = endpointChanged ? undefined : record?.endpointBinding;
    if (Object.hasOwn(patch, 'compatibleApiKey')) {
      const effectiveEndpoint = values.baseUrl;
      endpointBinding =
        typeof patch.compatibleApiKey === 'string' && typeof effectiveEndpoint === 'string'
          ? endpoint(effectiveEndpoint)
          : undefined;
    }
    state.providers = state.providers.filter((item) => item.provider !== provider);
    state.providers.push({
      provider,
      encrypted,
      publicValues,
      endpointBinding,
      updatedAt: Date.now(),
    });
  }

  /** Explicit authorized removal also works when the old encryption key is unavailable. */
  removeState(state: CredentialState, provider: string): void {
    this.descriptor(provider);
    state.providers = state.providers.filter((item) => item.provider !== provider);
  }

  describeState(state: CredentialState, provider: string) {
    const descriptor = this.descriptor(provider);
    const record = state.providers.find((item) => item.provider === provider);
    const quarantined = record?.quarantine !== undefined;
    const stored = record && !quarantined ? this.storedValues(record) : {};
    const values = quarantined ? {} : this.resolveState(state, provider);
    return {
      provider,
      ...(quarantined ? { error: 'credential_repair_required' as const } : {}),
      fields: descriptor.fields.map((field) => ({
        id: field.id,
        ...(field.id === 'compatibleApiKey' &&
        stored.compatibleApiKey !== undefined &&
        values.compatibleApiKey === undefined
          ? { error: 'endpoint_binding_mismatch' as const }
          : {}),
        configured: values[field.id] !== undefined && values[field.id] !== '',
        source: stored[field.id] !== undefined ? ('stored' as const) : ('unset' as const),
        ...(field.secret ? {} : { value: values[field.id] }),
      })),
    };
  }
}

/** Store-backed vault for applications that keep credential state in its own store. */
export class CredentialVault extends CredentialCodec implements CredentialStore {
  private readonly store: StateStore<CredentialState>;
  constructor(options: VaultOptions) {
    super(options);
    this.store = options.store;
  }

  async resolve(provider: string): Promise<CredentialValues> {
    return this.resolveState(await this.store.read(), provider);
  }

  async configure(provider: string, patch: Record<string, string | number | boolean | null>): Promise<void> {
    await this.store.transact((state) => this.configureState(state, provider, patch));
  }

  async remove(provider: string): Promise<void> {
    await this.store.transact((state) => this.removeState(state, provider));
  }

  async describe(provider: string) {
    return this.describeState(await this.store.read(), provider);
  }
}
