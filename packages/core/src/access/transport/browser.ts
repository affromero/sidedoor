export {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from '@simplewebauthn/browser';

import { startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';

export interface BrowserSession {
  principal: { id: string; name: string; role: 'owner' | 'member' } | null;
  expiresAt: number;
  sessionId?: string;
}
export interface BrowserPasskey {
  id: string;
  name: string;
  createdAt: number;
  backedUp: boolean;
}
export interface BrowserStoredSession {
  id: string;
  name: string;
  expiresAt: number;
  principalId: string | null;
}
export interface AccessCapabilities {
  password: boolean;
  passkeys: boolean;
  householdPasskeys?: boolean;
  openHousehold?: boolean;
}
export class AccessClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super(code);
    this.name = 'AccessClientError';
  }
}
let activeCeremony: object | null = null;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const changesCredential = (action: string) =>
  ![
    'login',
    'household',
    'open-household',
    'authentication-options',
    'household-authentication-options',
    'reauthentication-options',
    'register-options',
    'household-register-options',
    'session',
    'capabilities',
  ].includes(action);
const invalidSuccess = (action: string) =>
  new AccessClientError(changesCredential(action) ? 'outcome_unknown' : 'invalid_response', 200);

/** Browser-only client. Cookies remain HttpOnly; credentials never enter URLs or browser storage. */
export class AccessClient {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { endpoint?: string; fetch?: typeof fetch } = {}) {
    const endpoint = options.endpoint ?? '/api/access';
    if (!/^\/(?!\/)[a-zA-Z0-9/_-]+$/.test(endpoint))
      throw new Error('Access endpoint must be a same-origin path');
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<Result>(action: string, body?: unknown, signal?: AbortSignal): Promise<Result> {
    if (!/^[a-z-]+$/.test(action)) throw new Error('Invalid access action');
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/${action}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(globalThis.location?.origin ? { 'X-Sidedoor-Origin': globalThis.location.origin } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      const uncertain = body !== undefined && changesCredential(action);
      throw new AccessClientError(
        uncertain ? 'outcome_unknown' : signal?.aborted ? 'cancelled' : 'network_error',
      );
    }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status >= 500 && body !== undefined && changesCredential(action))
        throw new AccessClientError('outcome_unknown', response.status);
      const code =
        value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error
          : 'request_failed';
      throw new AccessClientError(code, response.status);
    }
    if (!record(value)) throw invalidSuccess(action);
    return value as Result;
  }

  async capabilities(signal?: AbortSignal): Promise<AccessCapabilities> {
    const result = await this.request<Record<string, unknown>>('capabilities', undefined, signal);
    if (typeof result.password !== 'boolean' || typeof result.passkeys !== 'boolean')
      throw invalidSuccess('capabilities');
    if (result.openHousehold !== undefined && typeof result.openHousehold !== 'boolean')
      throw invalidSuccess('capabilities');
    if (result.householdPasskeys !== undefined && typeof result.householdPasskeys !== 'boolean')
      throw invalidSuccess('capabilities');
    return {
      password: result.password,
      passkeys: result.passkeys,
      ...(typeof result.householdPasskeys === 'boolean'
        ? { householdPasskeys: result.householdPasskeys }
        : {}),
      ...(typeof result.openHousehold === 'boolean' ? { openHousehold: result.openHousehold } : {}),
    };
  }
  private async sessionRequest(
    action: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    const result = await this.request<Record<string, unknown>>(action, body, signal);
    const principal = result.principal;
    if (
      typeof result.expiresAt !== 'number' ||
      !Number.isFinite(result.expiresAt) ||
      result.expiresAt <= 0 ||
      (principal !== null &&
        (!record(principal) ||
          typeof principal.id !== 'string' ||
          !principal.id ||
          typeof principal.name !== 'string' ||
          !principal.name ||
          (principal.role !== 'owner' && principal.role !== 'member')))
    )
      throw invalidSuccess(action);
    if (result.sessionId !== undefined && typeof result.sessionId !== 'string') throw invalidSuccess(action);
    return {
      expiresAt: result.expiresAt,
      principal: principal as BrowserSession['principal'],
      ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {}),
    };
  }

  async passkeys(signal?: AbortSignal): Promise<BrowserPasskey[]> {
    return this.passkeyList('passkeys', signal);
  }

  async householdPasskeys(signal?: AbortSignal): Promise<BrowserPasskey[]> {
    return this.passkeyList('household-passkeys', signal);
  }

  private async passkeyList(action: string, signal?: AbortSignal): Promise<BrowserPasskey[]> {
    const result = await this.request<{ passkeys?: unknown }>(action, undefined, signal);
    if (
      !Array.isArray(result.passkeys) ||
      !result.passkeys.every(
        (key) =>
          record(key) &&
          typeof key.id === 'string' &&
          typeof key.name === 'string' &&
          typeof key.createdAt === 'number' &&
          typeof key.backedUp === 'boolean',
      )
    )
      throw new AccessClientError('invalid_response');
    return result.passkeys as BrowserPasskey[];
  }

  async sessions(signal?: AbortSignal): Promise<BrowserStoredSession[]> {
    const result = await this.request<{ sessions?: unknown }>('sessions', undefined, signal);
    if (
      !Array.isArray(result.sessions) ||
      !result.sessions.every(
        (session) =>
          record(session) &&
          typeof session.id === 'string' &&
          typeof session.name === 'string' &&
          typeof session.expiresAt === 'number' &&
          (session.principalId === null || typeof session.principalId === 'string'),
      )
    )
      throw new AccessClientError('invalid_response');
    return result.sessions as BrowserStoredSession[];
  }

  async recoveryCodes(signal?: AbortSignal): Promise<string[]> {
    const result = await this.request<{ codes?: unknown }>('recovery-codes', {}, signal);
    if (
      !Array.isArray(result.codes) ||
      !result.codes.length ||
      !result.codes.every((code) => typeof code === 'string' && code.length > 0)
    )
      throw invalidSuccess('recovery-codes');
    return result.codes;
  }

  changePassword(password: string, signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessionRequest('change-password', { password }, signal);
  }

  async mutation(action: string, body: unknown, signal?: AbortSignal): Promise<void> {
    const result = await this.request<{ ok?: unknown }>(action, body, signal);
    if (result.ok !== true) throw invalidSuccess(action);
  }
  session(signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessionRequest('session', undefined, signal);
  }
  login(name: string, password: string, signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessionRequest('login', { name, password }, signal);
  }
  enterHousehold(password: string, signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessionRequest('household', { password }, signal);
  }
  enterOpenHousehold(signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessionRequest('open-household', {}, signal);
  }
  redeemInvitation(
    code: string,
    enrollment?: { name: string; password: string },
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    return this.sessionRequest('redeem-invitation', { code, ...(enrollment ? { enrollment } : {}) }, signal);
  }
  claim(
    token: string,
    name: string,
    password: string,
    mode: 'household' | 'individual',
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    return this.sessionRequest('claim', { token, name, password, mode }, signal);
  }
  recover(code: string, password: string, signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessionRequest('recover', { code, password }, signal);
  }

  private async ceremony<Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    signal?.throwIfAborted();
    if (activeCeremony) throw new AccessClientError('ceremony_busy');
    const owner = {};
    activeCeremony = owner;
    const abort = () => {
      if (activeCeremony === owner) WebAuthnAbortService.cancelCeremony();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AccessClientError) throw error;
      if (
        signal?.aborted ||
        (error instanceof Error && ['NotAllowedError', 'AbortError'].includes(error.name))
      )
        throw new AccessClientError('cancelled');
      throw new AccessClientError('passkey_failed');
    } finally {
      signal?.removeEventListener('abort', abort);
      if (activeCeremony === owner) activeCeremony = null;
    }
  }

  authenticatePasskey(signal?: AbortSignal): Promise<BrowserSession> {
    return this.passkeyAuthentication(false, signal);
  }

  authenticateHouseholdPasskey(signal?: AbortSignal): Promise<BrowserSession> {
    return this.passkeyAuthentication(false, signal, true);
  }

  reauthenticatePasskey(signal?: AbortSignal): Promise<BrowserSession> {
    return this.passkeyAuthentication(true, signal);
  }

  reauthenticatePassword(password: string, signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessionRequest('reauthenticate', { password }, signal);
  }

  private passkeyAuthentication(
    reauthenticate: boolean,
    signal?: AbortSignal,
    household = false,
  ): Promise<BrowserSession> {
    return this.ceremony(async () => {
      const ceremony = await this.request<{
        ceremony: string;
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
      }>(
        reauthenticate
          ? 'reauthentication-options'
          : household
            ? 'household-authentication-options'
            : 'authentication-options',
        {},
        signal,
      );
      if (
        typeof ceremony.ceremony !== 'string' ||
        !ceremony.ceremony ||
        !record(ceremony.options) ||
        typeof ceremony.options.challenge !== 'string' ||
        typeof ceremony.options.rpId !== 'string'
      )
        throw invalidSuccess('authentication-options');
      signal?.throwIfAborted();
      const response = await startAuthentication({ optionsJSON: ceremony.options });
      signal?.throwIfAborted();
      return this.sessionRequest(
        reauthenticate
          ? 'reauthenticate-passkey'
          : household
            ? 'authenticate-household-passkey'
            : 'authenticate-passkey',
        { ceremony: ceremony.ceremony, response },
        signal,
      );
    }, signal);
  }

  registerPasskey(name: string, signal?: AbortSignal): Promise<{ ok: true }> {
    return this.registerPasskeyFor(name, signal, false);
  }

  registerHouseholdPasskey(name: string, signal?: AbortSignal): Promise<{ ok: true }> {
    return this.registerPasskeyFor(name, signal, true);
  }

  private registerPasskeyFor(
    name: string,
    signal: AbortSignal | undefined,
    household: boolean,
  ): Promise<{ ok: true }> {
    return this.ceremony(async () => {
      const ceremony = await this.request<{
        ceremony: string;
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
      }>(household ? 'household-register-options' : 'register-options', {}, signal);
      if (
        typeof ceremony.ceremony !== 'string' ||
        !ceremony.ceremony ||
        !record(ceremony.options) ||
        typeof ceremony.options.challenge !== 'string' ||
        !record(ceremony.options.rp) ||
        !record(ceremony.options.user) ||
        !Array.isArray(ceremony.options.pubKeyCredParams)
      )
        throw invalidSuccess('register-options');
      signal?.throwIfAborted();
      const response = await startRegistration({ optionsJSON: ceremony.options });
      signal?.throwIfAborted();
      const result = await this.request<{ ok?: unknown }>(
        household ? 'register-household-passkey' : 'register-passkey',
        { ceremony: ceremony.ceremony, response, name },
        signal,
      );
      if (result.ok !== true) throw invalidSuccess('register-passkey');
      return { ok: true as const };
    }, signal);
  }
}
