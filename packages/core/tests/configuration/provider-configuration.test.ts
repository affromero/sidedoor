import { expect, it } from 'vitest';
import { apiProviders } from '../../src/ai/configuration/providers';
import { providerDescriptors } from '../../src/ai/configuration/catalog';
import { ProviderRegistry, type CredentialValues } from '../../src/ai';

function validate(provider: string, credentials: CredentialValues) {
  const adapter = apiProviders().find((item) => item.descriptor.id === provider);
  if (!adapter?.validateConfiguration) throw new Error('Provider must validate its configuration');
  adapter.validateConfiguration({ credentials, signal: new AbortController().signal });
}
it('adds canonical credential help for Google', () => {
  const google = providerDescriptors().find((provider) => provider.id === 'google');
  expect(google?.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'apiKey',
        helpUrl: 'https://aistudio.google.com/apikey',
      }),
    ]),
  );
});
it('rejects official credentials for custom endpoints and accepts explicitly scoped endpoint keys', () => {
  for (const provider of ['openai', 'anthropic']) {
    expect(() => validate(provider, { apiKey: 'official-key' })).not.toThrow();
    expect(() =>
      validate(provider, { apiKey: 'official-key', baseUrl: 'https://custom.example/v1' }),
    ).toThrow('credentials');
    expect(() =>
      validate(provider, { compatibleApiKey: 'endpoint-key', baseUrl: 'https://custom.example/v1' }),
    ).not.toThrow();
  }
});
it('keeps keyless local configurations and explicit anonymous compatible endpoints usable', () => {
  for (const provider of ['ollama', 'llamacpp', 'vllm']) expect(() => validate(provider, {})).not.toThrow();
  expect(() =>
    validate('openai', { baseUrl: 'http://127.0.0.1:8080/v1', allowAnonymous: true }),
  ).not.toThrow();
  expect(() => validate('google', {})).toThrow();
});

it('does not certify credentials from anonymous or local endpoint reachability', async () => {
  const registry = new ProviderRegistry({
    providers: apiProviders(),
    credentials: {
      async resolve() {
        return { allowAnonymous: true, baseUrl: 'http://127.0.0.1:8080/v1' };
      },
    },
  });
  for (const provider of ['openai', 'ollama'])
    expect(await registry.validateCredentials(provider)).toMatchObject({
      status: 'inconclusive',
      readiness: { code: 'unsupported' },
    });
});
