import type { Capability, ProviderDescriptor } from '../browser';
import { providerCredentials } from '../../providers/catalog';
import { documentSuggestions } from './model-presets';
export { modelPresets, type ModelPreset } from './model-presets';

export interface ModelInfo {
  id: string;
  name: string;
  costPer1kInput: number;
  costPer1kOutput: number;
}
export interface ProviderMeta {
  displayName: string;
  models: ModelInfo[];
  allowCustomModel?: boolean;
  allowCustomBaseUrl?: boolean;
  defaultBaseUrl?: string;
}

/** Existing extraction presets. Runtime discovery supplies additional models without changing app defaults. */
const definitions = {
  anthropic: {
    displayName: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    allowCustomBaseUrl: true,
    models: [
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        costPer1kInput: 0.001,
        costPer1kOutput: 0.005,
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      },
    ],
  },
  openai: {
    displayName: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', costPer1kInput: 0.0004, costPer1kOutput: 0.0016 }],
  },
  ollama: {
    displayName: 'Ollama',
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    models: [],
  },
  llamacpp: {
    displayName: 'llama.cpp',
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:8080/v1',
    models: [],
  },
  vllm: {
    displayName: 'vLLM',
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:8000/v1',
    models: [],
  },
  google: {
    displayName: 'Google',
    allowCustomModel: true,
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', costPer1kInput: 0.00015, costPer1kOutput: 0.0035 },
    ],
  },
  'claude-code': {
    displayName: 'Claude Code (Max)',
    models: [
      { id: 'sonnet', name: 'Claude Sonnet (via CLI)', costPer1kInput: 0, costPer1kOutput: 0 },
      { id: 'opus', name: 'Claude Opus (via CLI)', costPer1kInput: 0, costPer1kOutput: 0 },
    ],
  },
  codex: {
    displayName: 'OpenAI Codex (CLI)',
    models: [{ id: 'codex', name: 'Codex CLI', costPer1kInput: 0, costPer1kOutput: 0 }],
  },
} satisfies Record<string, ProviderMeta>;
export type ProviderId = keyof typeof definitions;
export const PROVIDER_IDS = Object.keys(definitions) as ProviderId[];
export const PROVIDER_METADATA: Record<string, ProviderMeta> = definitions;
export const CLI_PROVIDERS: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };
export const LOCAL_PROVIDER_IDS = ['ollama', 'llamacpp', 'vllm'] as const;
export const LOCAL_PROVIDERS = new Set<string>(LOCAL_PROVIDER_IDS);

export function modelSuggestions(
  provider: string,
  profile: 'document' | 'extraction' = 'extraction',
): string[] {
  if (profile === 'document' && documentSuggestions[provider]) return [...documentSuggestions[provider]];
  const metadata = PROVIDER_METADATA[provider];
  if (!metadata) throw new Error(`Unknown model suggestion provider: ${provider}`);
  return metadata.models.map((model) => model.id);
}

export function providerDescriptors(): ProviderDescriptor[] {
  return Object.entries(PROVIDER_METADATA).map(([id, metadata]) => {
    const cli = Boolean(CLI_PROVIDERS[id]);
    const capabilities: Capability[] = ['text', 'vision', 'structured'];
    if (!cli) capabilities.push('tools');
    if (['anthropic', 'google', 'claude-code', 'codex'].includes(id)) capabilities.push('web');
    return {
      id,
      label: metadata.displayName,
      transport: cli ? 'cli' : LOCAL_PROVIDERS.has(id) ? 'local' : 'api',
      capabilities,
      fields: [
        ...providerCredentials(id, 'text').fields.map((field) => ({
          ...field,
          label: field.id === 'apiKey' ? 'API key' : field.label,
        })),
        ...(metadata.allowCustomBaseUrl
          ? [
              {
                id: 'baseUrl',
                label: 'API endpoint',
                kind: 'string' as const,
                secret: false,
                required: false,
                placeholder: metadata.defaultBaseUrl,
              },
              {
                id: 'compatibleApiKey',
                label: 'Custom endpoint API key',
                kind: 'string' as const,
                secret: true,
                required: false,
              },
              {
                id: 'allowAnonymous',
                label: 'Endpoint needs no API key',
                kind: 'boolean' as const,
                secret: false,
                required: false,
              },
            ]
          : []),
      ].filter((field) => field.id !== 'allowAnonymous' || id !== 'anthropic'),
      models: metadata.models.map((model) => ({ id: model.id, label: model.name, capabilities })),
    };
  });
}
