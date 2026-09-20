import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CredentialCodec, initialCredentialState } from '../src/configuration';
import {
  providerCredentials,
  providerIdentity,
  providerCompatibleConnection,
} from '../src/providers/catalog';

it('retains provider-specific compatible endpoints without falling back to another service', () => {
  expect(providerCompatibleConnection('groq')).toEqual({
    baseURL: 'https://api.groq.com/openai/v1',
  });
  expect(providerCompatibleConnection('nvidia')).toEqual({
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });
  const edited = providerCompatibleConnection('groq')!;
  edited.baseURL = 'https://unrelated.example';
  expect(providerCompatibleConnection('groq')?.baseURL).toBe('https://api.groq.com/openai/v1');
  expect(providerCompatibleConnection('anthropic')).toBeNull();
  expect(() => providerCompatibleConnection('constructor')).toThrow('Unknown provider');
});

it('uses one credential authority across supported OpenAI and Deepgram modalities', () => {
  for (const provider of ['openai', 'deepgram']) {
    const speech = providerCredentials(provider, 'speech');
    const transcription = providerCredentials(provider, 'transcription');
    expect(speech.credentialProvider).toBe(provider);
    expect(transcription.fields).toEqual(speech.fields);
    expect(speech.fields).toEqual([expect.objectContaining({ id: 'apiKey', secret: true, required: true })]);
  }
  expect(() => providerCredentials('deepgram', 'text')).toThrow('does not support');
});

it('keeps the MiniMax integration explicitly bound to FAL credentials', () => {
  const selected = providerCredentials('minimax', 'speech');
  expect(selected).toMatchObject({
    provider: 'minimax',
    modality: 'speech',
    credentialProvider: 'fal',
    helpUrl: providerCredentials('fal', 'speech').helpUrl,
  });
  expect(selected.fields[0]?.placeholder).toContain('FAL');
  expect(() => providerCredentials('minimax', 'text')).toThrow('does not support');
});

it('preserves optional usage configuration and isolates caller form mutations', () => {
  const original = providerCredentials('cartesia', 'speech');
  expect(original.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'adminApiKey', secret: true, required: false }),
      expect.objectContaining({ id: 'monthlyCreditLimit', kind: 'number', secret: false, required: false }),
    ]),
  );
  const edited = providerCredentials('cartesia', 'speech');
  edited.fields[0]!.label = 'Changed';
  edited.fields.pop();
  expect(providerCredentials('cartesia', 'speech')).toEqual(original);
  const identity = providerIdentity('openai');
  identity.modalities.length = 0;
  expect(providerIdentity('openai').modalities).toContain('speech');
});

it('keeps local authentication optional and rejects unknown identities', () => {
  for (const modality of ['text', 'speech', 'transcription'] as const)
    expect(providerCredentials('local', modality).fields).toEqual([
      expect.objectContaining({ id: 'apiKey', required: false, secret: true }),
    ]);
  for (const provider of ['unknown', '__proto__', 'constructor'])
    expect(() => providerIdentity(provider)).toThrow('Unknown provider');
});

it('keeps music service credentials separate from text and speech providers', () => {
  const selected = providerCredentials('suno', 'music');
  expect(selected.credentialProvider).toBe('sunoapi');
  expect(selected.fields).toEqual(providerCredentials('sunoapi', 'music').fields);
  selected.fields[0]!.label = 'Changed';
  expect(providerCredentials('suno', 'music').fields[0]?.label).toBe('API Key');
  expect(() => providerCredentials('suno', 'text')).toThrow(/support/);
  expect(providerCredentials('pexels', 'visual').fields).toEqual([
    expect.objectContaining({ id: 'apiKey', secret: true }),
  ]);
  expect(() => providerCredentials('pexels', 'speech')).toThrow(/support/);
});

it('preserves custom Cartesia usage-plan strings through credential storage', () => {
  const metadata = providerCredentials('cartesia', 'speech');
  const codec = new CredentialCodec({
    namespace: 'test',
    encryptionKey: randomBytes(32),
    descriptors: () => [
      {
        id: 'cartesia',
        label: 'Cartesia',
        transport: 'api',
        capabilities: ['speech'],
        models: [],
        fields: [...metadata.fields, ...metadata.configurationFields],
      },
    ],
  });
  const state = initialCredentialState();
  codec.configureState(state, 'cartesia', {
    apiKey: 'test-key',
    usagePlan: 'enterprise-plan',
    monthlyCreditLimit: 1234,
    billingResetDay: 12,
  });
  expect(codec.resolveState(state, 'cartesia')).toMatchObject({
    apiKey: 'test-key',
    usagePlan: 'enterprise-plan',
    monthlyCreditLimit: 1234,
    billingResetDay: 12,
  });
  metadata.configurationFields[0]!.label = 'Changed';
  expect(providerCredentials('cartesia', 'speech').configurationFields[0]?.label).toBe('Usage Plan');
});
it('requires both parts of personal PlayHT authentication', () => {
  expect(providerCredentials('playht', 'speech').fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'apiKey', required: true, secret: true }),
      expect.objectContaining({ id: 'userId', required: true, secret: true }),
    ]),
  );
});

it('describes object storage credentials without deployment environment access', () => {
  for (const provider of ['r2', 's3']) {
    const credential = providerCredentials(provider, 'storage');
    expect(credential.fields.map((field) => field.id)).toEqual(['accessKeyId', 'secretAccessKey']);
    expect(credential.fields.every((field) => field.secret)).toBe(true);
  }
});
