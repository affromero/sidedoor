import { MissingProviderCredentialsError, ProviderError, type CredentialValues } from '../index';

/** Select credentials for the effective endpoint before constructing an SDK client. */
export function providerConnection(
  credentials: CredentialValues,
  options: { defaultBaseUrl: string; normalizeV1?: boolean; requiresKey: boolean; allowAnonymous?: boolean },
) {
  const configured = credentials.baseUrl;
  let base: URL;
  let defaultBase: URL;
  try {
    defaultBase = new URL(options.defaultBaseUrl);
    base = new URL(typeof configured === 'string' && configured ? configured : options.defaultBaseUrl);
  } catch {
    throw new ProviderError('invalid_request', 'Invalid provider endpoint');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new ProviderError('invalid_request', 'Invalid provider endpoint');
  if (options.normalizeV1 && !base.pathname.replace(/\/+$/, '').endsWith('/v1'))
    base.pathname = base.pathname.replace(/\/+$/, '') + '/v1';
  const selected = base.origin === defaultBase.origin ? credentials.apiKey : credentials.compatibleApiKey;
  const apiKey = typeof selected === 'string' ? selected : '';
  if (options.requiresKey && !apiKey && !(options.allowAnonymous && credentials.allowAnonymous === true))
    throw new MissingProviderCredentialsError('Configure credentials for the selected endpoint');
  return { baseUrl: base.href.replace(/\/+$/, ''), apiKey };
}
