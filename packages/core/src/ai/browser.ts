export type Capability = 'text' | 'vision' | 'structured' | 'tools' | 'web' | 'speech' | 'transcription';
export type ReadinessCode =
  | 'ready'
  | 'not_configured'
  | 'missing_credentials'
  | 'not_installed'
  | 'not_authenticated'
  | 'unreachable'
  | 'missing_model'
  | 'unsupported';
export interface ProviderReadiness {
  code: ReadinessCode;
  checkedAt: number;
  /** A documented authenticated endpoint returned its required proof schema. Connectivity alone is insufficient. */
  authentication?: 'verified';
  action?: 'configure' | 'install' | 'login' | 'select_model' | 'retry';
}
/** Valid means the configured authenticated probe succeeded, not that every model is accessible.
 * Only rejected credentials justify disabling a stored credential; missing configuration does not.
 */
export interface CredentialValidation {
  status: 'valid' | 'rejected' | 'missing' | 'inconclusive';
  readiness: ProviderReadiness;
}
export interface CredentialField {
  id: string;
  label: string;
  secret: boolean;
  required: boolean;
  kind: 'string' | 'number' | 'boolean';
  helpUrl?: string;
  placeholder?: string;
}
export interface ModelDescriptor {
  id: string;
  label: string;
  capabilities: readonly Capability[];
  efforts?: readonly string[];
  contextTokens?: number;
  maxOutputTokens?: number;
}
export interface ProviderDescriptor {
  id: string;
  label: string;
  transport: 'api' | 'local' | 'cli' | 'ssh';
  fields: readonly CredentialField[];
  capabilities: readonly Capability[];
  models: readonly ModelDescriptor[];
}

export function compatibleProviders(
  providers: readonly ProviderDescriptor[],
  required: readonly Capability[],
): ProviderDescriptor[] {
  return providers.filter((provider) =>
    required.every((capability) => provider.capabilities.includes(capability)),
  );
}
