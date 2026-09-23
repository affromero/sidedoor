import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  accessStateSchema,
  initialAccessState,
  hashConfiguredPassword,
  PASSWORD_INPUT_MAX_BYTES,
  HouseholdProfileService,
  PrincipalManagement,
  DeviceService,
} from '../../src/access';
import { createAccessHandler, validateAccessOrigins, readAccessJson } from '../../src/access/transport/http';

it('preserves access JSON parsing and rejects oversized or missing bodies', async () => {
  expect(
    await readAccessJson(new Request('https://app.example', { method: 'POST', body: '{"name":"é"}' })),
  ).toEqual({ name: 'é' });
  await expect(readAccessJson(new Request('https://app.example', { method: 'POST' }))).rejects.toMatchObject({
    code: 'invalid',
  });
  await expect(
    readAccessJson(new Request('https://app.example', { method: 'POST', body: ' '.repeat(64001) })),
  ).rejects.toMatchObject({ code: 'invalid' });
  await expect(
    readAccessJson(new Request('https://app.example', { method: 'POST', body: '' })),
  ).rejects.toBeInstanceOf(SyntaxError);
});
import { FileStateStore } from '../../src/storage';

const directories: string[] = [];
it('normalizes canonical and password-only origins without merging their authority', () => {
  expect(
    validateAccessOrigins({
      origin: 'https://PRIVATE.example:443/',
      passwordOrigins: ['http://192.168.1.4:3000/'],
    }),
  ).toEqual({ canonicalOrigin: 'https://private.example', passwordOrigins: ['http://192.168.1.4:3000'] });
  expect(() =>
    validateAccessOrigins({
      origin: 'https://private.example',
      passwordOrigins: ['https://PRIVATE.example:443/'],
    }),
  ).toThrow('Duplicate application origin');
  for (const origin of [
    'https://user:password@private.example',
    'https://private.example/settings',
    'https://private.example?token=secret',
    'file:///tmp',
  ]) {
    expect(() => validateAccessOrigins({ origin })).toThrow('Invalid application origin');
  }
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(origin = 'https://private.example') {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-http-'));
  directories.push(directory);
  const access = new AccessService({
    store: new FileStateStore({
      path: join(directory, 'access.json'),
      initial: initialAccessState,
      parse: (value) => accessStateSchema.parse(value),
    }),
  });
  const claim = await access.issueOperatorToken();
  const handle = createAccessHandler({ access, origin, name: 'Private app' });
  const post = (action: string, body: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request(`${origin}/access/${action}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      action,
    );
  return { access, claim, handle, post };
}
describe('browser access endpoints', () => {
  it('issues a household enrollment ceremony only after password admission on the canonical origin', async () => {
    const { access, claim, post } = await fixture();
    await access.claimOwner(claim, 'Owner', 'owner password for testing', 'household');
    const invited = await access.store.transact((state) => access.issueSession(state, null, 'Invited'));
    expect(
      (await post('household-register-options', {}, { cookie: `sidedoor_session=${invited}` })).status,
    ).toBe(403);
    const guest = await access.enterHousehold('owner password for testing');
    const response = await post('household-register-options', {}, { cookie: `sidedoor_session=${guest}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ceremony: expect.any(String),
      options: { rp: { id: 'private.example' } },
    });
    expect((await post('register-options', {}, { cookie: `sidedoor_session=${guest}` })).status).toBe(403);
  });

  it('pairs only the household profile currently selected by the authenticated browser', async () => {
    const { access, claim } = await fixture();
    await access.claimOwner(claim, 'Owner', 'owner password for testing', 'household');
    await access.store.transact((state) => {
      state.householdProfiles = [
        { id: 'learner', name: 'Learner', epoch: 0 },
        { id: 'other', name: 'Other', epoch: 0 },
      ];
    });
    const guest = await access.enterHousehold('owner password for testing');
    await new HouseholdProfileService(access).select(guest, 'learner');
    const devices = new DeviceService({ access, scopesFor: () => ['app'] });
    const handle = createAccessHandler({
      access,
      devices,
      origin: 'https://private.example',
      name: 'Private app',
    });
    const issue = (defaultProfileId: string) =>
      handle(
        new Request('https://private.example/access/issue-pairing', {
          method: 'POST',
          headers: {
            origin: 'https://private.example',
            'content-type': 'application/json',
            cookie: `sidedoor_session=${guest}`,
          },
          body: JSON.stringify({ scopes: ['app'], name: 'Phone', defaultProfileId }),
        }),
        'issue-pairing',
      );
    expect((await issue('other')).status).toBe(403);
    const response = await issue('learner');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: string };
    expect(await devices.authenticate(await devices.redeemPairing(body.code), ['app'])).toMatchObject({
      principal: null,
      defaultProfileId: 'learner',
    });
  });
  it('allows opted-in native JSON requests while retaining browser and passkey origin checks', async () => {
    const { access, handle: strict } = await fixture();
    const origin = 'https://private.example';
    const handle = createAccessHandler({
      access,
      origin,
      name: 'Private app',
      allowOriginlessJsonClients: true,
    });
    const request = (headers: Record<string, string> = {}, action = 'check-origin', url = origin) =>
      new Request(`${url}/access/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
        body: '{}',
      });
    expect((await strict(request(), 'check-origin')).status).toBe(403);
    expect((await handle(request(), 'check-origin')).status).toBe(200);
    expect((await handle(request({ origin }), 'check-origin')).status).toBe(200);
    const rejectedHeaders: Record<string, string>[] = [
      { origin: 'null' },
      { origin: 'https://attacker.example' },
      { origin: '' },
      { referer: '' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-mode': '' },
      { 'content-type': 'application/jsonp' },
      { 'content-type': 'text/plain' },
    ];
    for (const headers of rejectedHeaders)
      expect((await handle(request(headers), 'check-origin')).status).toBe(403);
    expect(
      (await handle(request({}, 'check-origin', 'https://attacker.example'), 'check-origin')).status,
    ).toBe(403);
    expect((await handle(request({}, 'authentication-options'), 'authentication-options')).status).toBe(403);
    expect((await handle(request(), 'authorize-session')).status).toBe(401);
    const preflight = await handle(
      new Request(`${origin}/access/check-origin`, {
        method: 'OPTIONS',
        headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' },
      }),
      'check-origin',
    );
    expect(preflight.status).toBe(405);
    expect(preflight.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('checks origin without granting admission or disclosing accounts', async () => {
    const { access, post } = await fixture();
    const before = await access.store.read();
    expect((await post('check-origin', {})).status).toBe(200);
    expect((await post('check-origin', {}, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await post('check-origin', { name: 'Owner' })).status).toBe(400);
    expect(await access.store.read()).toEqual(before);
  });

  it('reuses open household admission and protects profile selection from cross-site requests', async () => {
    const { access: original, claim } = await fixture();
    const access = new AccessService({
      store: original.store,
      allowOpenHousehold: true,
      householdSessionTtlMs: 12 * 60 * 60 * 1000,
    });
    const origin = 'https://private.example';
    const handle = createAccessHandler({
      access,
      origin,
      name: 'Private app',
      profiles: new HouseholdProfileService(access),
    });
    const post = (action: string, body: unknown, cookie = '', requestOrigin = origin) =>
      handle(
        new Request(`${origin}/access/${action}`, {
          method: 'POST',
          headers: { origin: requestOrigin, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
        action,
      );
    expect((await post('open-household', {})).status).toBe(403);
    const owner = await access.claimOwner(claim, 'Owner', 'owner password for testing', 'household');
    const ownerId = (await access.store.read()).principals.find(
      (principal) => principal.role === 'owner',
    )!.id;
    await new HouseholdProfileService(access).select(owner, ownerId);
    await access.configureHousehold(owner, null);
    await access.store.transact((state) =>
      state.principals.push({
        id: 'profile',
        name: 'Member',
        role: 'member',
        passwordHash: null,
        epoch: 0,
        createdAt: Date.now(),
      }),
    );
    const admitted = await post('open-household', {});
    expect(admitted.status).toBe(200);
    expect((await admitted.json()).principal).toBeNull();
    const cookie = admitted.headers.get('set-cookie')!.split(';')[0]!;
    const reused = await post('open-household', {}, cookie);
    expect(reused.headers.get('set-cookie')!.split(';')[0]).toBe(cookie);
    expect((await post('select-profile', { id: 'profile' }, cookie, 'https://attacker.example')).status).toBe(
      403,
    );
    expect((await post('select-profile', { id: 'profile' }, cookie)).status).toBe(200);
    const selected = await handle(
      new Request(`${origin}/access/selected-profile`, { headers: { cookie } }),
      'selected-profile',
    );
    expect(await selected.json()).toEqual({ profile: { id: 'profile', name: 'Member' } });
    const current = await handle(new Request(`${origin}/access/session`, { headers: { cookie } }), 'session');
    expect((await current.json()).principal).toBeNull();
    const failed = await post('open-profile', { id: 'missing' });
    expect(failed.status).toBe(403);
    expect(failed.headers.get('set-cookie')).toBeNull();
    const atomic = await post('open-profile', { id: 'profile' });
    expect(atomic.status).toBe(200);
    const atomicCookie = atomic.headers.get('set-cookie')!.split(';')[0]!;
    const atomicProfile = await handle(
      new Request(`${origin}/access/selected-profile`, { headers: { cookie: atomicCookie } }),
      'selected-profile',
    );
    expect(await atomicProfile.json()).toEqual({ profile: { id: 'profile', name: 'Member' } });
  });

  it('validates direct Host authority when a framework normalizes a loopback request URL', async () => {
    const { access } = await fixture();
    const handle = createAccessHandler({
      access,
      origin: 'http://127.0.0.1:3000',
      passwordOrigins: ['http://[::1]:3000'],
      name: 'Local app',
      useHostHeader: true,
    });
    const request = (host: string) =>
      new Request('http://localhost:3000/access/capabilities', { headers: { host } });
    expect((await handle(request('127.0.0.1:3000'), 'capabilities')).status).toBe(200);
    expect((await handle(request('[::1]:3000'), 'capabilities')).status).toBe(200);
    for (const host of [
      '127.0.0.1:3001',
      'unknown.example',
      'user@127.0.0.1:3000',
      '127.0.0.1:3000/path',
      '127.0.0.1:3000,localhost',
      '127.0.0.1:99999',
      '127.0.0.1:3000\\path',
      '127.0.0.1 :3000',
    ])
      expect((await handle(request(host), 'capabilities')).status).toBe(403);
    expect(
      (
        await handle(
          new Request('http://localhost:3000/access/login', {
            method: 'POST',
            headers: {
              host: '127.0.0.1:3000',
              origin: 'http://localhost:3000',
              'content-type': 'application/json',
            },
            body: '{}',
          }),
          'login',
        )
      ).status,
    ).toBe(403);
  });

  it('requires explicit proxy trust and consistent configured browser origins for internal request URLs', async () => {
    const { access, claim } = await fixture();
    const canonical = 'https://private.example';
    const options = { access, origin: canonical, name: 'Private app' };
    const direct = createAccessHandler(options);
    const proxy = createAccessHandler({ ...options, trustedProxy: true });
    const get = (hint: string, extra: Record<string, string> = {}) =>
      new Request('http://internal:3000/access/capabilities', {
        headers: { 'x-sidedoor-origin': hint, ...extra },
      });
    expect((await direct(get(canonical), 'capabilities')).status).toBe(403);
    expect(await (await proxy(get(canonical), 'capabilities')).json()).toEqual({
      password: true,
      passkeys: true,
      householdPasskeys: false,
      openHousehold: false,
    });
    expect((await proxy(get('https://unknown.example'), 'capabilities')).status).toBe(403);
    expect((await proxy(get(canonical, { origin: 'https://other.example' }), 'capabilities')).status).toBe(
      403,
    );
    expect((await proxy(get(canonical, { 'sec-fetch-site': 'cross-site' }), 'capabilities')).status).toBe(
      403,
    );
    const claimed = await proxy(
      new Request('http://internal:3000/access/claim', {
        method: 'POST',
        headers: { origin: canonical, 'content-type': 'application/json' },
        body: JSON.stringify({
          token: claim,
          name: 'Owner',
          password: 'owner account password',
          mode: 'individual',
        }),
      }),
      'claim',
    );
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get('set-cookie')).toContain('Secure');
  });

  it.each(['😀'.repeat(2048), '\u0000'.repeat(8192), '\\"'.repeat(4096)])(
    'accepts bounded configured passwords without applying that allowance to new credentials',
    async (password) => {
      const { access, post, claim } = await fixture();
      const encoded = await hashConfiguredPassword(password);
      await access.store.transact((state) => {
        state.householdPasswordHash = encoded;
      });
      const response = await post('household', { password });
      expect(response.status).toBe(200);
      expect((await response.json()).principal).toBeNull();
      expect(
        (await post('claim', { token: claim, name: 'Owner', password, mode: 'individual' })).status,
      ).toBe(400);
      expect((await post('household', { password: 'a'.repeat(PASSWORD_INPUT_MAX_BYTES + 1) })).status).toBe(
        400,
      );
    },
  );

  it('restricts membership and household policy changes to a recently authenticated owner', async () => {
    const { access, post, claim } = await fixture();
    const ownerResponse = await post('claim', {
      token: claim,
      name: 'Owner',
      password: 'a sufficiently long password',
      mode: 'household',
    });
    const ownerToken = ownerResponse.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    const ownerId = (await access.store.read()).principals.find(
      (principal) => principal.role === 'owner',
    )!.id;
    await new HouseholdProfileService(access).select(ownerToken, ownerId);
    const owner = { cookie: ownerResponse.headers.get('set-cookie')! };
    expect(
      (await post('add-member', { name: 'Member', password: 'member account password' }, owner)).status,
    ).toBe(403);
    const memberId = await new PrincipalManagement(access).mutate(ownerToken, {
      kind: 'create',
      name: 'Member',
    });
    const memberResponse = await post('household', { password: 'a sufficiently long password' });
    const memberToken = memberResponse.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    await new HouseholdProfileService(access).select(memberToken, memberId);
    const member = { cookie: memberResponse.headers.get('set-cookie')! };
    for (const [action, body] of [
      ['set-role', { id: memberId, role: 'owner' }],
      ['set-mode', { mode: 'individual' }],
      ['configure-household', { password: 'household account password' }],
      ['add-member', { name: 'Intruder', password: 'intruder account password' }],
    ] as const)
      expect((await post(action, body, member)).status).toBe(403);
    expect(
      (await post('configure-household', { password: 'household account password' }, owner)).status,
    ).toBe(200);
    const guest = await access.enterHousehold('household account password');
    await new HouseholdProfileService(access).select(guest, ownerId);
    const activeOwner = { cookie: `sidedoor_session=${guest}` };
    expect((await post('set-mode', { mode: 'individual' }, activeOwner)).status).toBe(200);
    await expect(access.authenticate(guest)).rejects.toMatchObject({ code: 'unauthorized' });
    const individualOwner = await post('login', { name: 'Owner', password: 'household account password' });
    const individualOwnerCookie = { cookie: individualOwner.headers.get('set-cookie')! };
    expect((await post('set-role', { id: memberId, role: 'owner' }, individualOwnerCookie)).status).toBe(400);
    expect(
      (await post('configure-household', { password: 'changed household password' }, member)).status,
    ).toBe(401);
  });

  it('admits configured LAN password sessions while binding ceremonies to the canonical origin', async () => {
    const { access, claim } = await fixture();
    const canonical = 'https://private.example';
    const alias = 'http://192.168.1.5:3000';
    const handle = createAccessHandler({
      access,
      origin: canonical,
      passwordOrigins: [alias],
      name: 'Private app',
    });
    const post = (
      host: string,
      action: string,
      body: unknown,
      origin: string | null = host,
      extra: Record<string, string> = {},
    ) =>
      handle(
        new Request(`${host}/access/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...extra },
          body: JSON.stringify(body),
        }),
        action,
      );
    const enrollment = {
      token: claim,
      name: 'Owner',
      password: 'a sufficiently long password',
      mode: 'individual',
    };
    for (const [host, origin] of [
      [canonical, alias],
      [alias, canonical],
      [alias, null],
      ['http://192.168.1.5:3001', 'http://192.168.1.5:3001'],
    ]) {
      const response = await post(host!, 'claim', enrollment, origin);
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await post(alias, 'claim', enrollment, alias, { 'sec-fetch-site': 'cross-site' })).status).toBe(
      403,
    );
    const claimed = await post(alias, 'claim', enrollment);
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get('set-cookie')).not.toContain('Secure');
    const cookie = claimed.headers.get('set-cookie')!;
    for (const action of [
      'register-options',
      'register-passkey',
      'household-register-options',
      'register-household-passkey',
      'authentication-options',
      'authenticate-passkey',
      'household-authentication-options',
      'authenticate-household-passkey',
    ])
      expect((await post(alias, action, {}, alias, { cookie })).status).toBe(403);
    const capability = await handle(new Request(`${alias}/access/capabilities`), 'capabilities');
    expect(await capability.json()).toEqual({
      password: true,
      passkeys: false,
      householdPasskeys: false,
      openHousehold: false,
    });
    const login = await post(canonical, 'login', { name: 'Owner', password: enrollment.password });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('Secure');
    expect(
      (await handle(new Request('https://unknown.example/access/capabilities'), 'capabilities')).status,
    ).toBe(403);
  });

  it('rejects malformed and duplicate configured origins before serving requests', async () => {
    const { access } = await fixture();
    for (const alias of [
      'https://private.example/',
      'https://user:password@other.example',
      'https://other.example/path',
      'https://other.example/?q=1',
      'https://other.example/#fragment',
      'ftp://other.example',
    ])
      expect(() =>
        createAccessHandler({
          access,
          origin: 'https://private.example',
          passwordOrigins: [alias],
          name: 'Private app',
        }),
      ).toThrow();
  });

  it('lets a password-admitted visitor choose Admin without an invitation', async () => {
    const { access, post, claim } = await fixture();
    expect((await post('issue-invitation', {})).status).toBe(403);
    const claimed = await post('claim', {
      token: claim,
      name: 'Owner',
      password: 'a sufficiently long password',
      mode: 'household',
    });
    const ownerId = (await access.store.read()).principals.find(
      (principal) => principal.role === 'owner',
    )!.id;
    const ownerToken = claimed.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    await new HouseholdProfileService(access).select(ownerToken, ownerId);
    expect((await post('issue-invitation', {}, { cookie: claimed.headers.get('set-cookie')! })).status).toBe(
      403,
    );
    const admitted = await post('household', { password: 'a sufficiently long password' });
    expect(admitted.status).toBe(200);
    expect((await admitted.json()).principal).toBeNull();
    const invitedCookie = admitted.headers.get('set-cookie')!;
    expect((await post('issue-invitation', {}, { cookie: invitedCookie })).status).toBe(403);
    const invitedToken = invitedCookie.split(';')[0]!.split('=')[1]!;
    await new HouseholdProfileService(access).select(invitedToken, ownerId);
    expect((await post('authorize-owner', {}, { cookie: invitedCookie })).status).toBe(200);
  });
  it('reports an invalid new password without consuming the owner claim', async () => {
    const { post, claim } = await fixture();
    const body = { token: claim, name: 'Owner', password: 'short', mode: 'individual' };
    expect((await post('claim', body)).status).toBe(400);
    expect((await post('claim', { ...body, password: 'a sufficiently long password' })).status).toBe(200);
  });
  it('issues a protected cookie and revokes the session on logout', async () => {
    const { post, handle, claim } = await fixture();
    const response = await post('claim', {
      token: claim,
      name: 'Owner',
      password: 'a sufficiently long password',
      mode: 'individual',
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    const session = () =>
      handle(new Request('https://private.example/access/session', { headers: { cookie } }), 'session');
    expect((await session()).status).toBe(200);
    expect((await post('logout', {}, { cookie })).status).toBe(200);
    expect((await session()).status).toBe(401);
  });
  it('rejects foreign-origin enrollment before consuming the operator claim', async () => {
    const { post, claim } = await fixture();
    const body = {
      token: claim,
      name: 'Owner',
      password: 'a sufficiently long password',
      mode: 'individual',
    };
    expect((await post('claim', body, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await post('claim', body)).status).toBe(200);
  });
  it('preserves password access on HTTP LAN hosts and reports passkey unavailability', async () => {
    const { post, claim, handle } = await fixture('http://192.168.1.5:3000');
    expect(
      (
        await post('claim', {
          token: claim,
          name: 'Owner',
          password: 'a sufficiently long password',
          mode: 'household',
        })
      ).status,
    ).toBe(200);
    const response = await handle(new Request('http://192.168.1.5:3000/access/capabilities'), 'capabilities');
    expect(await response.json()).toEqual({
      password: true,
      passkeys: false,
      householdPasskeys: false,
      openHousehold: false,
    });
    expect((await post('household', { password: 'a sufficiently long password' })).status).toBe(200);
    expect((await post('login', { name: 'Owner', password: 'a sufficiently long password' })).status).toBe(
      401,
    );
  });
});
