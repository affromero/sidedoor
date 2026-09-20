import { z } from 'zod';
import { readRequestBytes, RequestBodyTooLargeError } from '../runtime/request';
import { AccessError, AccessService, newToken, isAccessError } from './service';
import { PasskeyService } from './passkeys';
import { PasskeyManagement } from './passkey-management';
import { PASSWORD_INPUT_MAX_BYTES } from './password';
import { hasAccessErrorBrand } from './error-brand';
import { InvitationService } from './invitations';
import type { DeviceService } from './devices';
import type { HouseholdProfileService } from './profiles';

/** Stable HTTP status for a rejected access operation, including custom app routes. */
export function accessErrorStatus(error: AccessError): number {
  const statuses = {
    unauthorized: 401,
    forbidden: 403,
    invalid: 400,
    rate_limited: 429,
    conflict: 409,
  };
  return statuses[error.code];
}

export interface AccessHttpOptions {
  access: AccessService;
  origin: string;
  /** Explicit browser origins sharing password authority. WebAuthn ceremonies use origin only. */
  passwordOrigins?: string[];
  /** Enable only behind a trusted ingress that supplies internal request URLs. Browser hints select configured origins only. */
  trustedProxy?: boolean;
  /** Use the direct Host authority when a framework normalizes Request.url. This does not trust forwarded headers. */
  useHostHeader?: boolean;
  /** Allow native JSON clients without browser headers. Does not enable CORS or relax passkey origins. */
  allowOriginlessJsonClients?: boolean;
  name: string;
  cookieName?: string;
  devices?: Pick<DeviceService, 'list' | 'issuePairing' | 'revoke'>;
  profiles?: HouseholdProfileService;
}
const text = z.string().min(1).max(1024);
const passwordInput = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= PASSWORD_INPUT_MAX_BYTES);
const loginSchema = z.object({
  name: text,
  password: passwordInput,
  deviceName: z.string().max(100).optional(),
});
const claimSchema = z.object({
  token: text,
  name: text,
  password: text,
  mode: z.enum(['household', 'individual']),
});
const credentialBase = z.object({
  id: text,
  rawId: text,
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});
const registrationSchema = z.object({
  ceremony: text,
  name: z.string().max(100).optional(),
  response: credentialBase.extend({
    response: z.object({
      clientDataJSON: z.string().max(16000),
      attestationObject: z.string().max(48000),
      transports: z
        .array(z.enum(['usb', 'nfc', 'ble', 'cable', 'internal', 'hybrid', 'smart-card']))
        .optional(),
    }),
  }),
});
const authenticationSchema = z.object({
  ceremony: text,
  name: z.string().max(100).optional(),
  response: credentialBase.extend({
    response: z.object({
      clientDataJSON: z.string().max(16000),
      authenticatorData: z.string().max(16000),
      signature: z.string().max(16000),
      userHandle: z.string().max(1024).optional(),
    }),
  }),
});

export async function readAccessJson(request: Request): Promise<unknown> {
  if (!request.body) throw new AccessError('invalid');
  try {
    return JSON.parse(Buffer.from(await readRequestBytes(request, 64000)).toString('utf8'));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw new AccessError('invalid');
    throw error;
  }
}

export function cookieValue(request: Request, name: string): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';');
  for (const value of values) {
    const offset = value.indexOf('=');
    if (value.slice(0, offset).trim() === name) return value.slice(offset + 1).trim();
  }
  return null;
}

function configuredOrigin(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid application origin');
  return url;
}

export function validateAccessOrigins(options: Pick<AccessHttpOptions, 'origin' | 'passwordOrigins'>) {
  const canonical = configuredOrigin(options.origin);
  const origins = [
    canonical.origin,
    ...(options.passwordOrigins ?? []).map((value) => configuredOrigin(value).origin),
  ];
  if (new Set(origins).size !== origins.length) throw new Error('Duplicate application origin');
  return { canonicalOrigin: canonical.origin, passwordOrigins: origins.slice(1) };
}

/** Mount beneath an application-owned route. Authenticated mutation checks also run in the service. */
export function createAccessHandler(options: AccessHttpOptions) {
  const credentials = new PasskeyManagement(options.access);
  const invitations = new InvitationService(options.access);
  const cookieName = options.cookieName ?? 'sidedoor_session';
  const validated = validateAccessOrigins(options);
  const canonical = new URL(validated.canonicalOrigin);
  const origins = [validated.canonicalOrigin, ...validated.passwordOrigins];
  const allowedOrigins = new Set(origins);
  if (!/^[a-zA-Z0-9_-]+$/.test(cookieName)) throw new Error('Invalid session cookie name');
  if (!['http:', 'https:'].includes(canonical.protocol) || canonical.username || canonical.password)
    throw new Error('Invalid application origin');
  const supportsPasskeys = canonical.protocol === 'https:' || canonical.hostname === 'localhost';
  const passkeys = () => {
    if (!supportsPasskeys) throw new AccessError('invalid');
    return new PasskeyService({ access: options.access, origin: options.origin, name: options.name });
  };
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

  return async function handle(request: Request, action: string): Promise<Response> {
    let requestOrigin = new URL(request.url);
    const cookie = (name: string, value: string, age: number) =>
      `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${requestOrigin.protocol === 'https:' ? '; Secure' : ''}`;
    async function signedIn(token: string): Promise<Response> {
      const auth = await options.access.authenticate(token);
      const response = reply({
        principal: auth.principal,
        expiresAt: auth.session.expiresAt,
        sessionId: auth.session.id,
      });
      response.headers.append(
        'Set-Cookie',
        cookie(
          cookieName,
          token,
          Math.max(0, Math.floor((auth.session.expiresAt - options.access.now()) / 1000)),
        ),
      );
      return response;
    }

    try {
      if (options.useHostHeader) {
        const host = request.headers.get('host');
        if (host) {
          if (!/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]+)?$/.test(host))
            throw new AccessError('forbidden');
          try {
            requestOrigin = new URL(`${requestOrigin.protocol}//${host}`);
          } catch {
            throw new AccessError('forbidden');
          }
        }
      }
      const hint = request.headers.get('x-sidedoor-origin');
      const browserOrigin = request.headers.get('origin');
      if (hint && browserOrigin && hint !== browserOrigin) throw new AccessError('forbidden');
      if (!allowedOrigins.has(requestOrigin.origin) && options.trustedProxy) {
        const selected = browserOrigin ?? hint;
        if (
          !selected ||
          !allowedOrigins.has(selected) ||
          request.headers.get('sec-fetch-site') === 'cross-site'
        )
          throw new AccessError('forbidden');
        requestOrigin = new URL(selected);
      }
      if (!allowedOrigins.has(requestOrigin.origin)) throw new AccessError('forbidden');
      if (hint && hint !== requestOrigin.origin) throw new AccessError('forbidden');
      const canonicalRequest = requestOrigin.origin === canonical.origin;
      const passkeyAction = [
        'register-options',
        'register-passkey',
        'authentication-options',
        'authenticate-passkey',
        'reauthentication-options',
        'reauthenticate-passkey',
      ].includes(action);
      if (passkeyAction && !canonicalRequest) throw new AccessError('forbidden');
      const token = cookieValue(request, cookieName) ?? '';
      if (request.method === 'GET') {
        if (action === 'capabilities')
          return reply({
            password: true,
            passkeys: supportsPasskeys && canonicalRequest,
            openHousehold: await options.access.supportsOpenHousehold(),
          });
        if (action === 'session') {
          const auth = await options.access.authenticate(token);
          return reply({
            principal: auth.principal,
            expiresAt: auth.session.expiresAt,
            sessionId: auth.session.id,
          });
        }
        if (action === 'sessions') return reply({ sessions: await options.access.sessions(token) });
        if (action === 'profiles' && options.profiles)
          return reply({ profiles: await options.profiles.list(token) });
        if (action === 'selected-profile' && options.profiles)
          return reply({ profile: await options.profiles.selected(token) });
        if (action === 'passkeys') return reply({ passkeys: await credentials.list(token) });
        if (action === 'invitations') return reply({ invitations: await invitations.list(token) });
        if (action === 'devices' && options.devices)
          return reply({ devices: await options.devices.list(token) });
        return reply({ error: 'not_found' }, 404);
      }
      if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
      const jsonContent =
        /^application\/json(?:\s*;\s*[!#$%&'*+.^_`|~\w-]+=(?:[!#$%&'*+.^_`|~\w-]+|"[^"\r\n]*"))*\s*$/i.test(
          request.headers.get('content-type') ?? '',
        );
      const originlessClient =
        options.allowOriginlessJsonClients === true &&
        !passkeyAction &&
        jsonContent &&
        !request.headers.has('origin') &&
        !request.headers.has('referer') &&
        !Array.from(request.headers.keys()).some((name) => name.startsWith('sec-fetch-'));
      if (
        (!originlessClient && request.headers.get('origin') !== requestOrigin.origin) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        throw new AccessError('forbidden');
      if (!jsonContent) return reply({ error: 'unsupported_media_type' }, 415);
      if (Number(request.headers.get('content-length') ?? 0) > 64_000)
        return reply({ error: 'body_too_large' }, 413);
      const body = await readAccessJson(request);
      if (action === 'check-origin') {
        z.object({}).strict().parse(body);
        return reply({ ok: true });
      }
      if (action === 'open-profile' && options.profiles) {
        const input = z.object({ id: text }).parse(body);
        return await signedIn(await options.profiles.enterOpen(input.id, token));
      }
      if (action === 'authorize-session' || action === 'authorize-owner') {
        z.object({}).strict().parse(body);
        await options.access.authenticate(token, action === 'authorize-owner');
        return reply({ ok: true });
      }
      if (action === 'select-profile' && options.profiles) {
        const input = z.object({ id: text.nullable() }).parse(body);
        await options.profiles.select(token, input.id);
        return reply({ ok: true });
      }
      if (action === 'open-household') {
        z.object({}).strict().parse(body);
        return await signedIn(await options.access.enterOpenHousehold('Household browser', token));
      }
      if (action === 'add-member') {
        const input = z.object({ name: text, password: text }).parse(body);
        return reply({ id: await options.access.addMember(token, input.name, input.password) }, 201);
      }
      if (action === 'set-role') {
        const input = z.object({ id: text, role: z.enum(['owner', 'member']) }).parse(body);
        await options.access.setRole(token, input.id, input.role);
        return reply({ ok: true });
      }
      if (action === 'set-mode') {
        await options.access.setMode(
          token,
          z.object({ mode: z.enum(['household', 'individual']) }).parse(body).mode,
        );
        return reply({ ok: true });
      }
      if (action === 'configure-household') {
        await options.access.configureHousehold(
          token,
          z.object({ password: text.nullable() }).parse(body).password,
        );
        return reply({ ok: true });
      }
      if (action === 'issue-invitation') {
        const input = z
          .object({
            ttlMs: z.number().int().positive().optional(),
            uses: z.number().int().positive().nullable().optional(),
          })
          .parse(body);
        return reply({ ...(await invitations.issueDetailed(token, input)), origin: requestOrigin.origin });
      }
      if (action === 'redeem-invitation') {
        const input = z
          .object({ code: text, enrollment: z.object({ name: text, password: text }).optional() })
          .parse(body);
        return await signedIn(await invitations.redeem(input.code, input.enrollment));
      }
      if (action === 'revoke-invitation') {
        await invitations.revoke(token, z.object({ id: text }).parse(body).id);
        return reply({ ok: true });
      }
      if (action === 'issue-pairing' && options.devices) {
        const input = z
          .object({ scopes: z.array(text).min(1).max(32), name: text, defaultProfileId: text.optional() })
          .parse(body);
        return reply({
          code: await options.devices.issuePairing(token, input.scopes, input.name, {
            defaultProfileId: input.defaultProfileId,
          }),
        });
      }
      if (action === 'revoke-device' && options.devices) {
        await options.devices.revoke(token, z.object({ id: text }).parse(body).id);
        return reply({ ok: true });
      }
      if (action === 'login') {
        const input = loginSchema.parse(body);
        return await signedIn(await options.access.login(input.name, input.password, input.deviceName));
      }
      if (action === 'reauthenticate')
        return await signedIn(
          await options.access.reauthenticate(
            token,
            z.object({ password: passwordInput }).parse(body).password,
          ),
        );
      if (action === 'change-password') {
        const input = z.object({ password: text, currentPassword: passwordInput.optional() }).parse(body);
        return await signedIn(
          await options.access.rotatePrincipalCredential(token, input.password, input.currentPassword),
        );
      }
      if (action === 'household') {
        const input = z
          .object({
            password: passwordInput,
            policy: z
              .object({
                householdEpoch: z.number().int().nonnegative(),
                policyEpoch: z.number().int().nonnegative(),
              })
              .optional(),
          })
          .parse(body);
        return await signedIn(
          await options.access.enterHousehold(input.password, 'Household browser', input.policy),
        );
      }
      if (action === 'claim') {
        const input = claimSchema.parse(body);
        return await signedIn(
          await options.access.claimOwner(input.token, input.name, input.password, input.mode),
        );
      }
      if (action === 'recover') {
        const input = z.object({ code: text, password: text }).parse(body);
        return await signedIn(await options.access.recover(input.code, input.password));
      }
      if (action === 'logout') {
        if (token) await options.access.logout(token);
        const response = reply({ ok: true });
        response.headers.append('Set-Cookie', cookie(cookieName, '', 0));
        return response;
      }
      if (action === 'revoke-session') {
        await options.access.revokeSession(token, z.object({ id: text }).parse(body).id);
        return reply({ ok: true });
      }
      if (action === 'recovery-codes') return reply({ codes: await options.access.recoveryCodes(token) });
      if (action === 'register-options')
        return reply(await passkeys().registrationOptions(token, canonical.origin));
      if (action === 'register-passkey') {
        const input = registrationSchema.parse(body);
        await passkeys().register(
          token,
          input.ceremony,
          input.response,
          input.name ?? 'Passkey',
          canonical.origin,
        );
        return reply({ ok: true });
      }
      if (action === 'authentication-options' || action === 'reauthentication-options') {
        const binding = newToken();
        const response = reply(
          action === 'reauthentication-options'
            ? await passkeys().reauthenticationOptions(token, binding, canonical.origin)
            : await passkeys().authenticationOptions(binding, canonical.origin),
        );
        response.headers.append('Set-Cookie', cookie(`${cookieName}_ceremony`, binding, 300));
        return response;
      }
      if (action === 'authenticate-passkey' || action === 'reauthenticate-passkey') {
        const input = authenticationSchema.parse(body);
        const binding = cookieValue(request, `${cookieName}_ceremony`) ?? '';
        const response = await signedIn(
          action === 'reauthenticate-passkey'
            ? await passkeys().reauthenticate(
                token,
                binding,
                input.ceremony,
                input.response,
                canonical.origin,
              )
            : await passkeys().login(binding, input.ceremony, input.response, canonical.origin, input.name),
        );
        response.headers.append('Set-Cookie', cookie(`${cookieName}_ceremony`, '', 0));
        return response;
      }
      if (action === 'remove-passkey') {
        await credentials.remove(token, z.object({ id: text }).parse(body).id);
        return reply({ ok: true });
      }
      return reply({ error: 'not_found' }, 404);
    } catch (error) {
      if (hasAccessErrorBrand(error, 'password_busy')) return reply({ error: 'rate_limited' }, 429);
      if (hasAccessErrorBrand(error, 'password_policy')) return reply({ error: 'invalid_password' }, 400);
      if (isAccessError(error)) return reply({ error: error.code }, accessErrorStatus(error));
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply({ error: 'invalid_request' }, 400);
      return reply({ error: 'access_failed' }, 503);
    }
  };
}
