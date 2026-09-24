import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  HouseholdProfileService,
  PasskeyService,
  accessStateSchema,
  initialAccessState,
  newToken,
  tokenHash,
} from '../../src/access/index';
import { FileStateStore } from '../../src/storage/index';

const origin = 'https://private.example';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();

/** A software authenticator signs real protocol responses. Verification is not mocked. */
function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credential = randomBytes(32);
  const id = credential.toString('base64url');
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  return {
    register(challenge: string): RegistrationResponseJSON {
      const client = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credential.length);
      const authData = Buffer.concat([
        digest('private.example'),
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        credential,
        cose,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, string>>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    login(challenge: string, counter: number, responseOrigin = origin): AuthenticationResponseJSON {
      const client = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge, origin: responseOrigin, crossOrigin: false }),
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([digest('private.example'), Buffer.from([0x05]), count]);
      const signature = sign('sha256', Buffer.concat([authData, digest(client)]), privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      };
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sidedoor-passkey-'));
  directories.push(dir);
  const access = new AccessService({
    store: new FileStateStore({
      path: join(dir, 'state.json'),
      initial: initialAccessState,
      parse: (value) => accessStateSchema.parse(value),
    }),
  });
  const owner = await access.claimOwner(
    await access.issueOperatorToken(),
    'Owner',
    'a long owner password',
    'individual',
  );
  const passkeys = new PasskeyService({ access, origin, name: 'Test' });
  const device = authenticator();
  const registration = await passkeys.registrationOptions(owner, origin);
  await passkeys.register(
    owner,
    registration.ceremony,
    device.register(registration.options.challenge),
    'Laptop',
    origin,
  );
  return { access, owner, passkeys, device };
}

async function householdFixture() {
  const result = await fixture();
  await result.access.setMode(result.owner, 'household');
  await result.access.configureHousehold(result.owner, 'a long household password');
  const ownerId = (await result.access.store.read()).principals.find(
    (principal) => principal.role === 'owner',
  )!.id;
  const owner = await result.access.enterHousehold('a long household password');
  await new HouseholdProfileService(result.access).select(owner, ownerId);
  return { ...result, owner, ownerId };
}

describe('passkey authentication', () => {
  it('enrolls after the shared password and grants Admin only after profile selection', async () => {
    const { access, owner, ownerId, passkeys } = await householdFixture();
    const household = await access.enterHousehold('a long household password');
    expect((await access.authenticate(household)).session.admission).toBe('password');
    const device = authenticator();
    const registration = await passkeys.householdRegistrationOptions(household, origin);
    expect(registration.options.user.name).toBe('Test');
    expect(registration.options.rp.name).toBe('Test');
    await passkeys.registerHousehold(
      household,
      registration.ceremony,
      device.register(registration.options.challenge),
      'Mac',
      origin,
    );
    expect(await passkeys.hasHouseholdPasskeys()).toBe(true);
    expect(await passkeys.listHousehold(owner)).toMatchObject([{ name: 'Mac' }]);
    await expect(passkeys.list(household)).rejects.toMatchObject({ code: 'forbidden' });

    const binding = newToken();
    const challenge = await passkeys.householdAuthenticationOptions(binding, origin);
    const assertion = device.login(challenge.options.challenge, 1);
    const token = await passkeys.loginHousehold(binding, challenge.ceremony, assertion, origin);
    expect((await access.authenticate(token)).session.admission).toBe('passkey');
    expect((await access.authenticate(token)).principal).toBeNull();
    await expect(access.authenticate(token, true)).rejects.toMatchObject({ code: 'forbidden' });
    await new HouseholdProfileService(access).select(token, ownerId);
    expect((await access.authenticate(token, true)).principal?.id).toBe(ownerId);
    await expect(
      passkeys.loginHousehold(binding, challenge.ceremony, assertion, origin),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects household enrollment without a fresh password-entry grant and never crosses passkey scopes', async () => {
    const { access, passkeys, device } = await householdFixture();
    const invited = await access.store.transact((state) => access.issueSession(state, null, 'Invited'));
    await expect(passkeys.householdRegistrationOptions(invited, origin)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const household = await access.enterHousehold('a long household password');
    const householdDevice = authenticator();
    const registration = await passkeys.householdRegistrationOptions(household, origin);
    await passkeys.registerHousehold(
      household,
      registration.ceremony,
      householdDevice.register(registration.options.challenge),
      'Mac',
      origin,
    );
    await expect(passkeys.householdRegistrationOptions(household, origin)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(passkeys.authenticationOptions(newToken(), origin)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const householdBinding = newToken();
    const householdChallenge = await passkeys.householdAuthenticationOptions(householdBinding, origin);
    await expect(
      passkeys.loginHousehold(
        householdBinding,
        householdChallenge.ceremony,
        device.login(householdChallenge.options.challenge, 1),
        origin,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('revokes household passkeys when the shared password changes', async () => {
    const { access, owner, passkeys } = await householdFixture();
    const household = await access.enterHousehold('a long household password');
    const device = authenticator();
    const registration = await passkeys.householdRegistrationOptions(household, origin);
    await passkeys.registerHousehold(
      household,
      registration.ceremony,
      device.register(registration.options.challenge),
      'Mac',
      origin,
    );
    await access.configureHousehold(owner, 'a different household password');
    expect(await passkeys.hasHouseholdPasskeys()).toBe(false);
    await expect(passkeys.householdAuthenticationOptions(newToken(), origin)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('lets the owner revoke one household passkey without removing the others', async () => {
    const { access, owner, ownerId, passkeys } = await householdFixture();
    for (const name of ['Mac', 'Phone']) {
      const household = await access.enterHousehold('a long household password');
      const registration = await passkeys.householdRegistrationOptions(household, origin);
      await passkeys.registerHousehold(
        household,
        registration.ceremony,
        authenticator().register(registration.options.challenge),
        name,
        origin,
      );
    }
    const before = await passkeys.listHousehold(owner);
    expect(before.map((key) => key.name)).toEqual(['Mac', 'Phone']);
    await passkeys.removeHousehold(owner, before[0]!.id);
    const replacement = await access.enterHousehold('a long household password');
    await new HouseholdProfileService(access).select(replacement, ownerId);
    expect((await passkeys.listHousehold(replacement)).map((key) => key.name)).toEqual(['Phone']);
    expect(await passkeys.hasHouseholdPasskeys()).toBe(true);
  });

  it('bounds cryptographic verification attempts for a reusable challenge', async () => {
    const { passkeys, device } = await fixture();
    const binding = newToken();
    const challenge = await passkeys.authenticationOptions(binding, origin);
    const invalid = device.login(challenge.options.challenge, 1, 'https://attacker.example');
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(passkeys.login(binding, challenge.ceremony, invalid, origin)).rejects.toThrow();
    await expect(passkeys.login(binding, challenge.ceremony, invalid, origin)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('atomically rotates one existing session when concurrent passkey reauthentication submits the same assertion', async () => {
    const { access, passkeys, device, owner } = await fixture();
    const binding = newToken();
    const challenge = await passkeys.reauthenticationOptions(owner, binding, origin);
    expect(challenge.options.allowCredentials?.map((key) => key.id)).toEqual(
      (await passkeys.list(owner)).map((key) => key.id),
    );
    const response = device.login(challenge.options.challenge, 1);
    const results = await Promise.allSettled([
      passkeys.reauthenticate(owner, binding, challenge.ceremony, response, origin),
      passkeys.reauthenticate(owner, binding, challenge.ceremony, response, origin),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const successful = results.find((result) => result.status === 'fulfilled');
    if (successful?.status !== 'fulfilled') throw new Error('Missing replacement session');
    expect((await access.authenticate(successful.value, true, true)).principal?.name).toBe('Owner');
    await expect(access.authenticate(owner)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await access.store.read()).sessions).toHaveLength(1);
  });

  it('does not recreate a session revoked after its passkey challenge was issued', async () => {
    const { access, passkeys, device, owner } = await fixture();
    const binding = newToken();
    const challenge = await passkeys.reauthenticationOptions(owner, binding, origin);
    await access.revokeSession(owner, tokenHash(owner));
    await expect(
      passkeys.reauthenticate(
        owner,
        binding,
        challenge.ceremony,
        device.login(challenge.options.challenge, 1),
        origin,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await access.store.read()).sessions).toHaveLength(0);
  });

  it('rejects a different account’s valid passkey without issuing or replacing a session', async () => {
    const { access, passkeys, owner } = await fixture();
    await access.addMember(owner, 'Member', 'member account password');
    const member = await access.login('Member', 'member account password');
    const otherDevice = authenticator();
    const registration = await passkeys.registrationOptions(member, origin);
    await passkeys.register(
      member,
      registration.ceremony,
      otherDevice.register(registration.options.challenge),
      'Member device',
      origin,
    );
    const before = (await access.store.read()).sessions;
    const binding = newToken();
    const challenge = await passkeys.reauthenticationOptions(owner, binding, origin);
    await expect(
      passkeys.reauthenticate(
        owner,
        binding,
        challenge.ceremony,
        otherDevice.login(challenge.options.challenge, 1),
        origin,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await access.store.read()).sessions).toEqual(before);
  });

  it('registers a passkey and signs in using a verified assertion', async () => {
    const { access, passkeys, device, owner } = await fixture();
    expect(await passkeys.list(owner)).toMatchObject([{ name: 'Laptop' }]);
    const binding = newToken();
    const challenge = await passkeys.authenticationOptions(binding, origin);
    const response = device.login(challenge.options.challenge, 1);
    const token = await passkeys.login(binding, challenge.ceremony, response, origin);
    expect((await access.authenticate(token)).principal?.role).toBe('owner');
    await expect(passkeys.login(binding, challenge.ceremony, response, origin)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('rejects an assertion signed for another website', async () => {
    const { passkeys, device } = await fixture();
    const binding = newToken();
    const challenge = await passkeys.authenticationOptions(binding, origin);
    await expect(
      passkeys.login(
        binding,
        challenge.ceremony,
        device.login(challenge.options.challenge, 1, 'https://attacker.example'),
        origin,
      ),
    ).rejects.toThrow();
  });

  it('binds the login ceremony to the initiating browser', async () => {
    const { passkeys, device } = await fixture();
    const challenge = await passkeys.authenticationOptions(newToken(), origin);
    await expect(
      passkeys.login(newToken(), challenge.ceremony, device.login(challenge.options.challenge, 1), origin),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects deleted passkeys and revokes their existing sessions', async () => {
    const { access, owner, passkeys, device } = await fixture();
    const binding = newToken();
    const challenge = await passkeys.authenticationOptions(binding, origin);
    const keys = await passkeys.list(owner);
    await passkeys.remove(owner, keys[0]!.id);
    await expect(access.authenticate(owner)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      passkeys.login(binding, challenge.ceremony, device.login(challenge.options.challenge, 1), origin),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
