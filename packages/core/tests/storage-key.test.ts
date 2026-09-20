import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localEncryptionKey } from '../src/storage/key';
import { CredentialCodec, initialCredentialState } from '../src/configuration';
import { providerDescriptors } from '../src/ai/catalog';

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'sidedoor-key-'));
  file = join(directory, 'encryption.key');
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(directory, { recursive: true, force: true });
});

it('creates a private durable key and preserves it across subsequent reads and writes', () => {
  const key = localEncryptionKey(file, { create: true });
  expect(key.byteLength).toBe(32);
  expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
  expect(localEncryptionKey(file, { create: false })).toEqual(key);
  expect(localEncryptionKey(file, { create: true })).toEqual(key);
});

it('never replaces a missing key during credential resolution', () => {
  expect(() => localEncryptionKey(file, { create: false })).toThrow();
  expect(fs.existsSync(file)).toBe(false);
});

it('fails existing encrypted credentials when the local key is lost without generating a replacement', () => {
  const state = initialCredentialState();
  const codec = new CredentialCodec({
    namespace: 'key-loss-test',
    descriptors: providerDescriptors,
    encryptionKey: () =>
      localEncryptionKey(file, { create: !state.providers.some((record) => record.encrypted) }),
  });
  codec.configureState(state, 'anthropic', { apiKey: 'test-only-provider-key' });
  expect(codec.resolveState(state, 'anthropic').apiKey).toBe('test-only-provider-key');
  expect(JSON.stringify(state)).not.toContain('test-only-provider-key');
  const ciphertext = structuredClone(state);
  fs.unlinkSync(file);
  expect(() => codec.resolveState(state, 'anthropic')).toThrow(
    'Stored credentials for anthropic are unavailable',
  );
  expect(fs.existsSync(file)).toBe(false);
  expect(state).toEqual(ciphertext);
});

it.each([0, 16, 33])('rejects a partial or malformed %i-byte key without replacing it', (size) => {
  const original = Buffer.alloc(size, 7);
  fs.writeFileSync(file, original, { mode: 0o600 });
  expect(() => localEncryptionKey(file, { create: true })).toThrow('regular 32-byte file');
  expect(fs.readFileSync(file)).toEqual(original);
});

it('rejects symlinks and exposed permissions without changing the key', () => {
  const target = join(directory, 'original');
  fs.writeFileSync(target, Buffer.alloc(32, 1), { mode: 0o600 });
  fs.symlinkSync(target, file);
  expect(() => localEncryptionKey(file, { create: true })).toThrow();
  expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  fs.unlinkSync(file);
  fs.renameSync(target, file);
  fs.chmodSync(file, 0o640);
  expect(() => localEncryptionKey(file, { create: false })).toThrow('mode 0600');
  expect(fs.statSync(file).mode & 0o7777).toBe(0o640);
});

it('retains a key after a failed durability flush and completes the same key on retry', () => {
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
    throw new Error('disk flush failed');
  });
  syncBuiltinESMExports();
  expect(() => localEncryptionKey(file, { create: true })).toThrow('disk flush failed');
  const retained = fs.readFileSync(file);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  expect(localEncryptionKey(file, { create: true })).toEqual(retained);
});
