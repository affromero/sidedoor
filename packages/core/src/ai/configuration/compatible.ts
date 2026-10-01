import { ProviderError, type Capability } from '../index';
import { providerConnection } from './connection';
import type { SelectedApi } from './providers';

export interface CompatibleApiSelectionInput {
  provider: string;
  label: string;
  endpoint: string;
  apiKey?: string;
  /** Require a key when validating or executing, rather than while capturing configuration. */
  requiresKey?: boolean;
  transport?: 'api' | 'local';
  capabilities?: readonly Capability[];
  /** Supply the saved credential's binding after authorizing its owner and revision. */
  credentialBinding?: { protocol: string; endpoint: string };
}

export type CompatibleApiSelection = Extract<SelectedApi, { transport: 'compatible' }>;
export type CompatibleModelSelection = CompatibleApiSelection & { model: string };

/** Capture one explicit compatible endpoint without looking up credentials or choosing a backend. */
export function captureCompatibleApi(input: CompatibleApiSelectionInput): CompatibleApiSelection {
  if (!input.endpoint.trim()) throw new ProviderError('invalid_request', 'A compatible endpoint is required');
  const connection = providerConnection(
    { apiKey: input.apiKey ?? '' },
    { defaultBaseUrl: input.endpoint.trim(), requiresKey: false },
  );
  if (connection.apiKey && input.credentialBinding) {
    const binding = input.credentialBinding;
    const bound = providerConnection({}, { defaultBaseUrl: binding.endpoint, requiresKey: false });
    if (binding.protocol !== 'compatible' || bound.baseUrl !== connection.baseUrl)
      throw new ProviderError('invalid_request', 'The saved credential belongs to a different endpoint');
  }
  return {
    transport: 'compatible',
    descriptor: {
      id: input.provider,
      label: input.label,
      transport: input.transport ?? 'api',
      fields: [],
      models: [],
      capabilities: [...(input.capabilities ?? ['text', 'vision', 'structured'])],
    },
    credentials: { apiKey: connection.apiKey },
    baseUrl: connection.baseUrl,
    requiresKey: input.requiresKey ?? false,
  };
}

/** Model IDs belong to the server. Applications remove any product-specific routing prefix first. */
export function captureCompatibleModel(
  input: CompatibleApiSelectionInput & { model: string },
): CompatibleModelSelection {
  const model = input.model.trim();
  if (!model) throw new ProviderError('invalid_request', 'A compatible model is required');
  return { ...captureCompatibleApi(input), model };
}
