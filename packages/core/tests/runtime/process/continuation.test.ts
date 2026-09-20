import { describe, expect, it } from 'vitest';
import {
  ProviderRegistry,
  type GenerationEvent,
  type GenerationRequest,
  type ProviderAdapter,
} from '../../../src/ai';

const request: GenerationRequest = {
  provider: 'provider',
  model: 'model',
  consumerId: 'alice',
  conversationId: 'chat1',
  credentialOwnerId: 'owner',
  messages: [],
};
async function collect(registry: ProviderRegistry, input: GenerationRequest) {
  const events: GenerationEvent[] = [];
  for await (const event of registry.generate(input)) events.push(event);
  return events;
}
function fixture() {
  let apiKey = 'original-provider-key';
  const adapter: ProviderAdapter = {
    descriptor: {
      id: 'provider',
      label: 'Provider',
      transport: 'api',
      capabilities: ['text'],
      models: [],
      fields: [],
    },
    async readiness() {
      return { code: 'ready', checkedAt: 1 };
    },
    async models() {
      return [];
    },
    async *generate(input) {
      if (input.continuation) yield { type: 'text', text: 'resumed' };
      else
        yield {
          type: 'continuation',
          provider: input.provider,
          model: input.model,
          data: [{ type: 'reasoning', encrypted_content: 'private-state' }],
        };
      yield { type: 'finish', reason: 'complete' };
    },
  };
  return {
    registry: new ProviderRegistry({
      providers: [adapter],
      credentials: {
        async resolve() {
          return { apiKey };
        },
      },
    }),
    rotate() {
      apiKey = 'replacement-provider-key';
    },
  };
}
describe('server-owned provider continuation', () => {
  it('completes ordinary inference without issuing reusable state when identities are omitted', async () => {
    const { registry } = fixture();
    expect(
      await collect(registry, {
        ...request,
        consumerId: undefined,
        conversationId: undefined,
        credentialOwnerId: undefined,
      }),
    ).toEqual([{ type: 'finish', reason: 'complete' }]);
  });
  it('requires explicit identity bindings when issuing continuation', async () => {
    const { registry } = fixture();
    await expect(collect(registry, { ...request, consumerId: undefined })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
  it('resumes for the same caller while rejecting tampering and cross-user or cross-conversation reuse', async () => {
    const { registry } = fixture();
    const continuation = (await collect(registry, request)).find((event) => event.type === 'continuation');
    if (continuation?.type !== 'continuation') throw new Error('Missing continuation');
    expect(JSON.stringify(continuation)).not.toContain('private-state');
    expect(typeof continuation.data).toBe('string');
    expect(await collect(registry, { ...request, continuation })).toContainEqual({
      type: 'text',
      text: 'resumed',
    });
    await expect(collect(registry, { ...request, continuation, consumerId: 'bob' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      collect(registry, { ...request, continuation, conversationId: 'chat2' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      collect(registry, { ...request, continuation: { ...continuation, data: [] } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('invalidates continuation after the configured credential changes', async () => {
    const { registry, rotate } = fixture();
    const continuation = (await collect(registry, request)).find((event) => event.type === 'continuation');
    if (continuation?.type !== 'continuation') throw new Error('Missing continuation');
    rotate();
    await expect(collect(registry, { ...request, continuation })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
