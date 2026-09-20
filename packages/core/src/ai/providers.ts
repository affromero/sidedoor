import { createAnthropicProvider } from './anthropic';
import { createCompatibleProvider } from './openai-compatible';
import { createResponsesProvider } from './openai-responses';
import { createGoogleProvider } from './google';
import { providerDescriptors, PROVIDER_METADATA } from './catalog';
import {
  ProviderRegistry,
  type CredentialValues,
  type ProviderAdapter,
  type ProviderDescriptor,
  type RegistryOptions,
} from './index';
export { providerConnection } from './connection';

interface CapturedApiIdentity {
  descriptor: ProviderDescriptor;
  credentials: CredentialValues;
}

export type SelectedApi = CapturedApiIdentity &
  (
    | { transport: 'compatible'; baseUrl: string; requiresKey: boolean }
    | { transport: 'responses'; baseUrl?: string; webSearchType?: 'web_search' | 'web_search_preview' }
    | { transport: 'anthropic' }
  );

export interface SelectedApiOptions {
  fetch?: typeof fetch;
  streaming?: boolean;
  maxRetries?: number;
  timeoutMode?: RegistryOptions['timeoutMode'];
  compatible?: {
    normalizeV1?: boolean;
    maxTokensParameter?: 'max_tokens' | 'max_completion_tokens';
    assistantImages?: boolean;
  };
  anthropic?: { webSearchMaxUses?: number | null };
}

/** Generation and validation share this exact captured transport and credential selection. */
export function createSelectedApiRegistry(
  selection: SelectedApi,
  options: SelectedApiOptions = {},
): ProviderRegistry {
  const descriptor = structuredClone(selection.descriptor);
  const credentials = { ...selection.credentials };
  const common = {
    descriptor,
    streaming: options.streaming,
    maxRetries: options.maxRetries,
    fetch: options.fetch,
  };
  const adapter =
    selection.transport === 'anthropic'
      ? createAnthropicProvider({ ...common, ...options.anthropic })
      : selection.transport === 'responses'
        ? createResponsesProvider({
            ...common,
            defaultBaseUrl: selection.baseUrl,
            webSearchType: selection.webSearchType,
          })
        : createCompatibleProvider({
            ...common,
            ...options.compatible,
            defaultBaseUrl: selection.baseUrl,
            requiresKey: selection.requiresKey,
          });
  return new ProviderRegistry({
    providers: [adapter],
    timeoutMode: options.timeoutMode,
    credentials: {
      async resolve() {
        return { ...credentials };
      },
    },
  });
}

/** Provider-specific construction is owned here. Consumers supply credentials and select capabilities. */
export function apiProviders(
  options: {
    openaiTransport?: 'chat' | 'responses';
    streaming?: boolean;
    maxTokensParameter?: 'max_tokens' | 'max_completion_tokens';
  } = {},
): ProviderAdapter[] {
  return providerDescriptors()
    .filter((descriptor) => descriptor.transport !== 'cli')
    .map((descriptor) => {
      if (descriptor.id === 'anthropic')
        return createAnthropicProvider({ descriptor, streaming: options.streaming });
      if (descriptor.id === 'google')
        return createGoogleProvider(descriptor, { streaming: options.streaming });
      if (descriptor.id === 'openai' && options.openaiTransport === 'responses')
        return createResponsesProvider({
          streaming: options.streaming,
          descriptor: { ...descriptor, capabilities: [...descriptor.capabilities, 'web'] },
        });
      return createCompatibleProvider({
        descriptor,
        defaultBaseUrl: PROVIDER_METADATA[descriptor.id]?.defaultBaseUrl ?? 'https://api.openai.com/v1',
        requiresKey: descriptor.transport === 'api',
        normalizeV1: descriptor.transport === 'local',
        streaming: options.streaming,
        maxTokensParameter:
          options.maxTokensParameter ??
          (descriptor.transport === 'local' ? 'max_tokens' : 'max_completion_tokens'),
      });
    });
}
