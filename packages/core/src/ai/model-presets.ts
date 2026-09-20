export interface ModelPreset {
  id: string;
  displayName: string;
  shortDisplayName: string;
  tier: 'fast' | 'balanced' | 'best' | 'max';
  contextWindow: number;
  maxOutputTokens: number;
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  isReasoning?: boolean;
}

/** Presets describe known models. Runtime discovery remains authoritative for availability. */
const presets: Record<string, readonly ModelPreset[]> = {
  anthropic: [
    {
      id: 'claude-haiku-4-5-20251001',
      displayName: 'Claude Haiku 4.5',
      shortDisplayName: 'Haiku 4.5',
      tier: 'fast',
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      shortDisplayName: 'Sonnet 4.6',
      tier: 'balanced',
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
    {
      id: 'claude-opus-4-6',
      displayName: 'Claude Opus 4.6',
      shortDisplayName: 'Opus 4.6',
      tier: 'best',
      contextWindow: 200000,
      maxOutputTokens: 128000,
    },
  ],
  openai: [
    {
      id: 'gpt-5-nano',
      displayName: 'GPT-5 Nano',
      shortDisplayName: '5 Nano',
      tier: 'fast',
      contextWindow: 400000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
    {
      id: 'gpt-5-mini',
      displayName: 'GPT-5 Mini',
      shortDisplayName: '5 Mini',
      tier: 'fast',
      contextWindow: 400000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
    {
      id: 'gpt-5',
      displayName: 'GPT-5',
      shortDisplayName: '5',
      tier: 'balanced',
      contextWindow: 400000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
    {
      id: 'gpt-5.2',
      displayName: 'GPT-5.2',
      shortDisplayName: '5.2',
      tier: 'best',
      contextWindow: 400000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
    {
      id: 'gpt-5.4-nano',
      displayName: 'GPT-5.4 Nano',
      shortDisplayName: '5.4 Nano',
      tier: 'fast',
      contextWindow: 400000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
    {
      id: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini',
      shortDisplayName: '5.4 Mini',
      tier: 'fast',
      contextWindow: 400000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
    {
      id: 'gpt-5.4',
      displayName: 'GPT-5.4',
      shortDisplayName: '5.4',
      tier: 'balanced',
      contextWindow: 1050000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
    {
      id: 'gpt-5.4-pro',
      displayName: 'GPT-5.4 Pro',
      shortDisplayName: '5.4 Pro',
      tier: 'best',
      contextWindow: 1050000,
      maxOutputTokens: 128000,
      isReasoning: true,
    },
  ],
  'claude-code': [
    {
      id: 'haiku',
      displayName: 'Haiku',
      shortDisplayName: 'Haiku 4.5',
      tier: 'fast',
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
    {
      id: 'sonnet',
      displayName: 'Sonnet',
      shortDisplayName: 'Sonnet 4.6',
      tier: 'balanced',
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
    {
      id: 'opus',
      displayName: 'Opus',
      shortDisplayName: 'Opus 4.6',
      tier: 'best',
      contextWindow: 200000,
      maxOutputTokens: 128000,
    },
  ],
  codex: [],
  local: [],
  together: [],
  deepgram: [],
  assemblyai: [],
  groq: [
    {
      id: 'llama-3.1-8b-instant',
      displayName: 'Llama 3.1 8B Instant',
      shortDisplayName: 'Llama 8B',
      tier: 'fast',
      contextWindow: 131072,
      maxOutputTokens: 131072,
      pricing: {
        inputPerMTok: 0.05,
        outputPerMTok: 0.08,
      },
    },
    {
      id: 'llama-3.3-70b-versatile',
      displayName: 'Llama 3.3 70B Versatile',
      shortDisplayName: 'Llama 70B',
      tier: 'balanced',
      contextWindow: 131072,
      maxOutputTokens: 32768,
      pricing: {
        inputPerMTok: 0.59,
        outputPerMTok: 0.79,
      },
    },
    {
      id: 'openai/gpt-oss-120b',
      displayName: 'GPT-OSS 120B',
      shortDisplayName: 'GPT-OSS 120B',
      tier: 'best',
      contextWindow: 131072,
      maxOutputTokens: 65536,
      isReasoning: true,
      pricing: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.6,
      },
    },
  ],
  xai: [
    {
      id: 'grok-4-fast',
      displayName: 'Grok 4 Fast',
      shortDisplayName: 'Grok 4 Fast',
      tier: 'balanced',
      contextWindow: 1000000,
      maxOutputTokens: 32768,
      pricing: {
        inputPerMTok: 1.25,
        outputPerMTok: 2.5,
      },
    },
    {
      id: 'grok-4',
      displayName: 'Grok 4',
      shortDisplayName: 'Grok 4',
      tier: 'best',
      contextWindow: 1000000,
      maxOutputTokens: 32768,
      isReasoning: true,
      pricing: {
        inputPerMTok: 1.25,
        outputPerMTok: 2.5,
      },
    },
  ],
  deepseek: [
    {
      id: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      shortDisplayName: 'V4 Flash',
      tier: 'balanced',
      contextWindow: 1000000,
      maxOutputTokens: 65536,
      pricing: {
        inputPerMTok: 0.14,
        outputPerMTok: 0.28,
      },
    },
    {
      id: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      shortDisplayName: 'V4 Pro',
      tier: 'best',
      contextWindow: 1000000,
      maxOutputTokens: 65536,
      isReasoning: true,
      pricing: {
        inputPerMTok: 0.435,
        outputPerMTok: 0.87,
      },
    },
  ],
  mistral: [
    {
      id: 'mistral-small-latest',
      displayName: 'Mistral Small',
      shortDisplayName: 'Small',
      tier: 'fast',
      contextWindow: 128000,
      maxOutputTokens: 16384,
      pricing: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.6,
      },
    },
    {
      id: 'mistral-medium-latest',
      displayName: 'Mistral Medium',
      shortDisplayName: 'Medium',
      tier: 'balanced',
      contextWindow: 131072,
      maxOutputTokens: 16384,
      pricing: {
        inputPerMTok: 0.4,
        outputPerMTok: 2,
      },
    },
    {
      id: 'mistral-large-latest',
      displayName: 'Mistral Large',
      shortDisplayName: 'Large',
      tier: 'best',
      contextWindow: 256000,
      maxOutputTokens: 32768,
      pricing: {
        inputPerMTok: 0.5,
        outputPerMTok: 1.5,
      },
    },
  ],
  nvidia: [
    {
      id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
      displayName: 'Nemotron Super 49B',
      shortDisplayName: 'Nemotron 49B',
      tier: 'balanced',
      contextWindow: 131072,
      maxOutputTokens: 65536,
      isReasoning: true,
    },
    {
      id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      displayName: 'Nemotron Ultra 253B',
      shortDisplayName: 'Nemotron 253B',
      tier: 'best',
      contextWindow: 131072,
      maxOutputTokens: 32768,
      isReasoning: true,
    },
  ],
  gladia: [],
  speechmatics: [],
  google: [
    {
      id: 'gemini-3.1-flash-lite-preview',
      displayName: 'Gemini 3.1 Flash Lite',
      shortDisplayName: 'Flash Lite 3.1',
      tier: 'fast',
      contextWindow: 1000000,
      maxOutputTokens: 64000,
    },
    {
      id: 'gemini-3.1-pro-preview',
      displayName: 'Gemini 3.1 Pro',
      shortDisplayName: 'Pro 3.1',
      tier: 'balanced',
      contextWindow: 1000000,
      maxOutputTokens: 64000,
    },
  ],
};

/** Each consumer receives independent metadata for pricing enrichment and presentation. */
export function modelPresets(provider: string): ModelPreset[] {
  const models = presets[provider];
  if (!models) throw new Error(`Unknown model preset provider: ${provider}`);
  return structuredClone(models) as ModelPreset[];
}

/** Document assistants retain their existing suggestions independently of extraction defaults. */
export const documentSuggestions: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  anthropic: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-5.5', 'gpt-5.5-mini'],
  ollama: ['qwen3:4b', 'qwen3:8b', 'gemma3:4b'],
  llamacpp: [],
  vllm: [],
};
