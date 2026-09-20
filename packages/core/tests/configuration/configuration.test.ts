import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CredentialCodec,
  CredentialDecryptionError,
  CredentialRepairRequiredError,
  CredentialValidationError,
  CredentialVault,
  credentialStateSchema,
  initialCredentialState,
} from '../../src/configuration/index';
import { FileStateStore } from '../../src/storage/index';
import type { ProviderDescriptor } from '../../src/ai/browser';

const directories: string[] = [];
it.each<Record<string, string | number | boolean | null>>([
  { unknown: 'secret' },
  { apiKey: 'x'.repeat(16385) },
  { monthlyLimit: Infinity },
  { monthlyLimit: 'wrong' },
])('rejects invalid credential input without mutating stored state', (patch) => {
  const codec = new CredentialCodec({ namespace: 'test', descriptors: () => [descriptor] });
  const state = initialCredentialState();
  expect(() => codec.configureState(state, 'test', patch)).toThrow(CredentialValidationError);
  expect(state).toEqual(initialCredentialState());
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const descriptor: ProviderDescriptor = {
  id: 'test',
  label: 'Test',
  transport: 'api',
  capabilities: ['text'],
  models: [],
  fields: [
    { id: 'apiKey', label: 'Key', secret: true, required: true, kind: 'string' },
    { id: 'monthlyLimit', label: 'Limit', secret: false, required: false, kind: 'number' },
  ],
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-vault-'));
  directories.push(directory);
  const path = join(directory, 'credentials.json');
  const store = new FileStateStore({
    path,
    initial: initialCredentialState,
    parse: (value) => credentialStateSchema.parse(value),
  });
  const options = {
    store,
    encryptionKey: randomBytes(32),
    namespace: 'test',
    descriptors: () => [descriptor],
  };
  return { path, vault: new CredentialVault(options), options };
}

describe('provider credentials', () => {
  it('retains damaged imports privately until explicit repair', async () => {
    const { options, path } = await fixture();
    const codec = new CredentialCodec(options);
    const original = {
      sourceFormat: 'test-import',
      sourceVersion: 1,
      payload: 'opaque-damaged-secret',
      failure: 'decryption_failed' as const,
    };
    await options.store.transact((state) => codec.quarantineState(state, 'test', original));
    const state = await options.store.read();
    expect(state.version).toBe(2);
    expect(codec.readQuarantineState(state, 'test')).toEqual(original);
    expect(await readFile(path, 'utf8')).not.toContain(original.payload);
    expect(() => codec.resolveState(state, 'test')).toThrow(CredentialRepairRequiredError);
    expect(codec.describeState(state, 'test')).toMatchObject({ error: 'credential_repair_required' });
    expect(() => codec.configureState(state, 'test', { apiKey: 'replacement' })).toThrow(
      CredentialRepairRequiredError,
    );
    const before = structuredClone(state);
    codec.quarantineState(state, 'test', original);
    expect(state).toEqual(before);
    expect(() => codec.quarantineState(state, 'test', { ...original, payload: 'different' })).toThrow(
      CredentialValidationError,
    );
    expect(() => codec.replaceState(state, 'test', { unknown: 'invalid' })).toThrow(
      CredentialValidationError,
    );
    expect(state).toEqual(before);
    codec.replaceState(state, 'test', { apiKey: 'replacement' });
    codec.quarantineState(state, 'test', original);
    expect(new CredentialCodec(options).resolveState(state, 'test').apiKey).toBe('replacement');
    expect(codec.readQuarantineState(state, 'test')).toBeNull();
    codec.removeState(state, 'test');
    codec.quarantineState(state, 'test', original);
    expect(state.providers).toEqual([]);
    expect(state.version).toBe(2);
    expect(credentialStateSchema.safeParse({ ...before, version: 1 }).success).toBe(false);
  });

  it('rejects quarantine ciphertext across providers, namespaces, and executable credential envelopes', async () => {
    const { options } = await fixture();
    const codec = new CredentialCodec({
      ...options,
      descriptors: () => [descriptor, { ...descriptor, id: 'other' }],
    });
    const state = initialCredentialState();
    codec.quarantineState(state, 'test', {
      sourceFormat: 'test',
      sourceVersion: 1,
      payload: 'retained',
      failure: 'invalid_format',
    });
    const record = state.providers[0]!;
    const otherNamespace = new CredentialCodec({ ...options, namespace: 'other' });
    expect(() => otherNamespace.readQuarantineState(state, 'test')).toThrow(CredentialDecryptionError);
    record.provider = 'other';
    expect(() => codec.readQuarantineState(state, 'other')).toThrow(CredentialDecryptionError);
    record.provider = 'test';
    record.encrypted = record.quarantine!.encryptedPayload;
    delete record.quarantine;
    expect(() => codec.resolveState(state, 'test')).toThrow(CredentialDecryptionError);
  });

  it('leaves stored imports unchanged when quarantine encryption or a surrounding transaction fails', async () => {
    const { options } = await fixture();
    const codec = new CredentialCodec(options);
    const original = {
      sourceFormat: 'test',
      sourceVersion: 1,
      payload: 'retained',
      failure: 'invalid_format' as const,
    };
    const state = initialCredentialState();
    const missingKey = new CredentialCodec({ ...options, encryptionKey: undefined });
    expect(() => missingKey.quarantineState(state, 'test', original)).toThrow('persistent 32-byte');
    expect(state).toEqual(initialCredentialState());
    expect(() =>
      codec.quarantineState(state, 'test', { ...original, payload: 'x'.repeat(1024 * 1024 + 1) }),
    ).toThrow();
    expect(state).toEqual(initialCredentialState());
    await expect(
      options.store.transact((stored) => {
        codec.quarantineState(stored, 'test', original);
        throw new Error('Transaction failed');
      }),
    ).rejects.toThrow('Transaction failed');
    expect(await options.store.read()).toEqual(initialCredentialState());
  });

  it('isolates healthy providers and keys import markers to the vault', async () => {
    const { options } = await fixture();
    const codec = new CredentialCodec({
      ...options,
      descriptors: () => [descriptor, { ...descriptor, id: 'other' }],
    });
    const state = initialCredentialState();
    const original = {
      sourceFormat: 'test',
      sourceVersion: 1,
      payload: 'retained',
      failure: 'invalid_format' as const,
    };
    codec.quarantineState(state, 'test', original);
    codec.configureState(state, 'other', { apiKey: 'healthy' });
    expect(codec.resolveState(state, 'other')).toEqual({ apiKey: 'healthy' });
    const otherState = initialCredentialState();
    new CredentialCodec({ ...options, encryptionKey: randomBytes(32) }).quarantineState(
      otherState,
      'test',
      original,
    );
    expect(otherState.imports).not.toEqual(state.imports);
    const retained = state.providers.find((record) => record.provider === 'test')!.quarantine!;
    retained.encryptedPayload = state.providers.find((record) => record.provider === 'other')!.encrypted!;
    expect(() => codec.readQuarantineState(state, 'test')).toThrow(CredentialDecryptionError);
  });

  it('allows explicit removal of unreadable credentials without decrypting them', async () => {
    const { options, vault } = await fixture();
    await vault.configure('test', { apiKey: 'saved-key' });
    const changedKeyVault = new CredentialVault({ ...options, encryptionKey: randomBytes(32) });
    await expect(changedKeyVault.resolve('test')).rejects.toThrow('Stored credentials');
    await options.store.transact((state) => changedKeyVault.removeState(state, 'test'));
    expect(await changedKeyVault.resolve('test')).toEqual({});
    await changedKeyVault.configure('test', { apiKey: 'replacement-key' });
    expect(await changedKeyVault.resolve('test')).toEqual({ apiKey: 'replacement-key' });
  });

  it('refuses to expose public settings when a descriptor marks them as secret', async () => {
    const { options, vault } = await fixture();
    await vault.configure('test', { monthlyLimit: 50 });
    const changed = new CredentialVault({
      ...options,
      descriptors: () => [
        { ...descriptor, fields: descriptor.fields.map((field) => ({ ...field, secret: true })) },
      ],
    });
    await expect(changed.describe('test')).rejects.toThrow('public');
  });

  it('unbinds a saved endpoint credential when the saved endpoint changes', async () => {
    const { options } = await fixture();
    const fields = [
      ...descriptor.fields,
      ...['baseUrl', 'compatibleApiKey'].map((id) => ({
        id,
        label: id,
        kind: 'string' as const,
        secret: id === 'compatibleApiKey',
        required: false,
      })),
    ];
    const vault = new CredentialVault({
      ...options,
      descriptors: () => [{ ...descriptor, fields }],
    });
    await vault.configure('test', {
      apiKey: 'official-key',
      baseUrl: 'https://new.example/v1',
      compatibleApiKey: 'new-endpoint-key',
    });
    expect(await vault.resolve('test')).toEqual({
      apiKey: 'official-key',
      baseUrl: 'https://new.example/v1',
      compatibleApiKey: 'new-endpoint-key',
    });
    await vault.configure('test', { baseUrl: 'https://third.example/v1' });
    expect((await vault.resolve('test')).compatibleApiKey).toBeUndefined();
  });

  it('allows empty vault reads without an encryption key and rejects durable secret writes', async () => {
    const { options } = await fixture();
    const vault = new CredentialVault({ ...options, encryptionKey: undefined });
    expect(await vault.resolve('test')).toEqual({});
    expect((await vault.describe('test')).fields).toContainEqual({
      id: 'apiKey',
      configured: false,
      source: 'unset',
    });
    await expect(vault.configure('test', { apiKey: 'private-key' })).rejects.toThrow('persistent');
    expect(await vault.resolve('test')).toEqual({});
  });

  it('rolls back a credential patch when the surrounding configuration transaction fails', async () => {
    const { vault, options } = await fixture();
    await vault.configure('test', { apiKey: 'previous-key' });
    await expect(
      options.store.transact((state) => {
        vault.configureState(state, 'test', { apiKey: 'replacement-key' });
        throw new Error('Selection was rejected');
      }),
    ).rejects.toThrow('Selection');
    expect(await vault.resolve('test')).toEqual({ apiKey: 'previous-key' });
  });

  it('encrypts secrets and exposes presence without exposing their values', async () => {
    const { vault, path } = await fixture();
    await vault.configure('test', { apiKey: 'private-key', monthlyLimit: 50 });
    expect(await vault.resolve('test')).toEqual({ apiKey: 'private-key', monthlyLimit: 50 });
    expect(await readFile(path, 'utf8')).not.toContain('private-key');
    expect(await vault.describe('test')).toEqual({
      provider: 'test',
      fields: [
        { id: 'apiKey', configured: true, source: 'stored' },
        { id: 'monthlyLimit', configured: true, source: 'stored', value: 50 },
      ],
    });
  });

  it('preserves omitted settings and clears configuration after removal', async () => {
    const { vault } = await fixture();
    await vault.configure('test', { apiKey: 'private-key', monthlyLimit: 50 });
    await vault.configure('test', { monthlyLimit: 100 });
    expect(await vault.resolve('test')).toEqual({ apiKey: 'private-key', monthlyLimit: 100 });
    await vault.remove('test');
    expect(await vault.resolve('test')).toEqual({});
  });

  it('surfaces a decryption failure instead of silently using another credential', async () => {
    const { vault, options } = await fixture();
    await vault.configure('test', { apiKey: 'private-key' });
    const wrongKey = new CredentialVault({ ...options, encryptionKey: randomBytes(32) });
    await expect(wrongKey.resolve('test')).rejects.toThrow();
  });
});
