import type { CredentialField } from '../ai/browser';

export type ProviderModality =
  'text' | 'speech' | 'transcription' | 'music' | 'visual' | 'storage' | 'pricing';

export interface CompatibleApiConnection {
  baseURL: string;
}

interface Identity {
  label: string;
  helpUrl: string;
  fields: readonly CredentialField[];
  fieldsByModality?: Partial<Record<ProviderModality, readonly CredentialField[]>>;
  configurationFields?: readonly CredentialField[];
  modalities: readonly ProviderModality[];
  /** Explicit credential authority for the selected integration, such as MiniMax through FAL. */
  credentialProvider?: string;
  fieldPresentation?: Record<string, { placeholder?: string; label?: string }>;
  compatibleApi?: CompatibleApiConnection;
}

const identities: Record<string, Identity> = {
  pricetoken: {
    label: 'PriceToken',
    helpUrl: 'https://pricetoken.com',
    fields: [{ id: 'apiKey', label: 'API Key', kind: 'string', required: true, secret: true }],
    modalities: ['pricing'],
  },
  r2: {
    label: 'Cloudflare R2',
    helpUrl: 'https://developers.cloudflare.com/r2/api/s3/tokens/',
    fields: [
      { id: 'accessKeyId', label: 'Access Key ID', kind: 'string', required: true, secret: true },
      {
        id: 'secretAccessKey',
        label: 'Secret Access Key',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['storage'],
  },
  s3: {
    label: 'Amazon S3',
    helpUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
    fields: [
      { id: 'accessKeyId', label: 'Access Key ID', kind: 'string', required: true, secret: true },
      {
        id: 'secretAccessKey',
        label: 'Secret Access Key',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['storage'],
  },
  sunoapi: {
    label: 'Suno API (sunoapi.org)',
    helpUrl: 'https://docs.sunoapi.org/suno-api/quickstart',
    fields: [{ id: 'apiKey', label: 'API Key', kind: 'string', required: true, secret: true }],
    modalities: ['music'],
  },
  suno: {
    label: 'Suno',
    helpUrl: 'https://docs.sunoapi.org/suno-api/quickstart',
    fields: [],
    credentialProvider: 'sunoapi',
    modalities: ['music'],
  },
  pexels: {
    label: 'Pexels',
    helpUrl: 'https://www.pexels.com/api/documentation/',
    fields: [{ id: 'apiKey', label: 'API Key', kind: 'string', required: true, secret: true }],
    modalities: ['visual'],
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'sk-ant-...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text'],
  },
  openai: {
    label: 'OpenAI',
    helpUrl: 'https://platform.openai.com/api-keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'sk-...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text', 'speech', 'transcription', 'storage'],
  },
  'claude-code': {
    label: 'Claude Code (CLI)',
    helpUrl: '',
    fields: [],
    modalities: ['text'],
  },
  codex: {
    label: 'Codex (CLI)',
    helpUrl: '',
    fields: [],
    modalities: ['text'],
  },
  local: {
    label: 'Local model (Ollama / vLLM / LM Studio)',
    helpUrl: '',
    fields: [],
    fieldsByModality: {
      text: [{ id: 'apiKey', label: 'API key', kind: 'string', required: false, secret: true }],
      speech: [{ id: 'apiKey', label: 'API key', kind: 'string', required: false, secret: true }],
      transcription: [{ id: 'apiKey', label: 'API key', kind: 'string', required: false, secret: true }],
    },
    modalities: ['text', 'speech', 'transcription'],
  },
  together: {
    compatibleApi: { baseURL: 'https://api.together.xyz/v1' },
    label: 'Together AI',
    helpUrl: 'https://api.together.xyz/settings/api-keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text', 'transcription'],
  },
  deepgram: {
    label: 'Deepgram (STT)',
    helpUrl: 'https://console.deepgram.com/',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['speech', 'transcription'],
  },
  assemblyai: {
    label: 'AssemblyAI (STT)',
    helpUrl: 'https://www.assemblyai.com/app',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['transcription'],
  },
  groq: {
    compatibleApi: { baseURL: 'https://api.groq.com/openai/v1' },
    label: 'Groq',
    helpUrl: 'https://console.groq.com/keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'gsk_...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text', 'transcription'],
  },
  xai: {
    compatibleApi: { baseURL: 'https://api.x.ai/v1' },
    label: 'xAI (Grok)',
    helpUrl: 'https://console.x.ai/',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'xai-...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text'],
  },
  deepseek: {
    compatibleApi: { baseURL: 'https://api.deepseek.com/v1' },
    label: 'DeepSeek',
    helpUrl: 'https://platform.deepseek.com/api_keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'sk-...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text'],
  },
  mistral: {
    compatibleApi: { baseURL: 'https://api.mistral.ai/v1' },
    label: 'Mistral',
    helpUrl: 'https://console.mistral.ai/api-keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'Your Mistral API key',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text', 'speech'],
  },
  nvidia: {
    compatibleApi: { baseURL: 'https://integrate.api.nvidia.com/v1' },
    label: 'NVIDIA NIM',
    helpUrl: 'https://build.nvidia.com/',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'nvapi-...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text'],
  },
  gladia: {
    label: 'Gladia (STT)',
    helpUrl: 'https://app.gladia.io/',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['transcription'],
  },
  speechmatics: {
    label: 'Speechmatics (STT)',
    helpUrl: 'https://portal.speechmatics.com/',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['transcription'],
  },
  google: {
    label: 'Google (Gemini)',
    helpUrl: 'https://aistudio.google.com/apikey',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'AIza...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['text'],
  },
  elevenlabs: {
    label: 'ElevenLabs',
    helpUrl: 'https://elevenlabs.io/app/settings/api-keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'xi-xxxxxxxxxxxxxxxxxxxx',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['speech', 'transcription'],
  },
  cartesia: {
    configurationFields: [
      { id: 'usagePlan', label: 'Usage Plan', kind: 'string', required: false, secret: false },
    ],
    label: 'Cartesia',
    helpUrl: 'https://play.cartesia.ai/keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'sk_car_...',
        kind: 'string',
        required: true,
        secret: true,
      },
      {
        id: 'adminApiKey',
        label: 'Admin API Key',
        placeholder: 'sk_car_admin_... (optional, for usage)',
        kind: 'string',
        required: false,
        secret: true,
      },
      {
        id: 'monthlyCreditLimit',
        label: 'Monthly Credit Limit',
        placeholder: 'Optional, e.g. 1000000',
        kind: 'number',
        required: false,
        secret: false,
      },
      {
        id: 'billingResetDay',
        label: 'Billing Reset Day',
        placeholder: 'Optional, 1-31',
        kind: 'number',
        required: false,
        secret: false,
      },
    ],
    modalities: ['speech', 'transcription'],
  },
  hume: {
    label: 'Hume AI',
    helpUrl: 'https://platform.hume.ai/settings/keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'Your Hume AI API key',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['speech'],
  },
  fal: {
    label: 'Fal',
    helpUrl: 'https://fal.ai/dashboard/keys',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: 'fal_sk_...',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['speech'],
  },
  minimax: {
    label: 'MiniMax',
    helpUrl: '',
    fields: [],
    modalities: ['speech'],
    credentialProvider: 'fal',
    fieldPresentation: { apiKey: { placeholder: 'Your FAL API key' } },
  },
  replicate: {
    label: 'Replicate',
    helpUrl: 'https://replicate.com/account/api-tokens',
    fields: [
      {
        id: 'apiKey',
        label: 'API Token',
        placeholder: 'r8_xxxxxxxxxxxx',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['speech'],
  },
  kokoro: {
    label: 'Kokoro (Local)',
    helpUrl: '',
    fields: [],
    modalities: ['speech'],
  },
  rime: {
    label: 'Rime',
    helpUrl: 'https://app.rime.ai/tokens',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['speech'],
  },
  playht: {
    label: 'PlayHT',
    helpUrl: 'https://play.ht/studio/api-access',
    fields: [
      {
        id: 'apiKey',
        label: 'API Key',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
      {
        id: 'userId',
        label: 'User ID',
        placeholder: '',
        kind: 'string',
        required: true,
        secret: true,
      },
    ],
    modalities: ['speech'],
  },
  ollama: {
    label: 'Ollama',
    helpUrl: '',
    fields: [],
    modalities: ['text'],
  },
  llamacpp: {
    label: 'llama.cpp',
    helpUrl: '',
    fields: [],
    modalities: ['text'],
  },
  vllm: {
    label: 'vLLM',
    helpUrl: '',
    fields: [],
    modalities: ['text'],
  },
};

function identity(provider: string): Identity {
  if (!Object.hasOwn(identities, provider)) throw new Error(`Unknown provider: ${provider}`);
  return identities[provider]!;
}

export function providerIdentity(provider: string) {
  const entry = identity(provider);
  return { id: provider, label: entry.label, modalities: [...entry.modalities] };
}

export function providerCompatibleConnection(provider: string): CompatibleApiConnection | null {
  const connection = identity(provider).compatibleApi;
  return connection ? { ...connection } : null;
}

/** Descriptors only. Credentials must be selected by the caller; this module never reads the environment. */
export function providerCredentials(provider: string, modality: ProviderModality) {
  const entry = identity(provider);
  if (!entry.modalities.includes(modality))
    throw new Error(`Provider ${provider} does not support ${modality}`);
  const credentialProvider = entry.credentialProvider ?? provider;
  const authority = identity(credentialProvider);
  return {
    provider,
    modality,
    credentialProvider,
    configurationFields: structuredClone(authority.configurationFields ?? []),
    helpUrl: authority.helpUrl,
    fields: structuredClone(authority.fieldsByModality?.[modality] ?? authority.fields).map((field) => ({
      ...field,
      ...entry.fieldPresentation?.[field.id],
      helpUrl: authority.helpUrl,
    })),
  };
}
