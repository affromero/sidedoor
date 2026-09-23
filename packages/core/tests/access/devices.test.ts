import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  DeviceService,
  HouseholdProfileService,
  accessStateSchema,
  initialAccessState,
  tokenHash,
  initializeHouseholdDevices,
} from '../../src/access';
import { FileStateStore } from '../../src/storage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-device-'));
  directories.push(directory);
  const store = new FileStateStore({
    path: join(directory, 'access.json'),
    initial: initialAccessState,
    parse: (value) => accessStateSchema.parse(value),
  });
  const access = new AccessService({ store });
  const owner = await access.claimOwner(
    await access.issueOperatorToken(),
    'Owner',
    'owner password for testing',
    'household',
  );
  const ownerId = (await store.read()).principals.find((principal) => principal.role === 'owner')!.id;
  await new HouseholdProfileService(access).select(owner, ownerId);
  const devices = new DeviceService({
    access,
    scopesFor: (principal) => (principal?.role === 'owner' ? ['read', 'admin'] : ['read']),
  });
  return { access, devices, store, owner };
}
describe('device access', () => {
  it('binds delegated Admin scopes to the selected household Admin profile', async () => {
    const { access, devices, store, owner } = await fixture();
    const ownerId = (await store.read()).principals.find((principal) => principal.role === 'owner')!.id;
    await store.transact((state) => {
      state.householdProfiles = [
        { id: ownerId, name: 'Owner', epoch: 0, ownerPrincipalId: ownerId },
        { id: 'reader', name: 'Reader', epoch: 0 },
      ];
    });
    const profiles = new HouseholdProfileService(access);
    await profiles.select(owner, ownerId);
    await expect(devices.issuePairing(owner, ['admin'], 'Unbound')).rejects.toMatchObject({
      code: 'forbidden',
    });
    const paired = await devices.issuePairing(owner, ['read', 'admin'], 'Owner phone', {
      defaultProfileId: ownerId,
    });
    const token = await devices.redeemPairing(paired);
    expect(await devices.authenticate(token, ['admin'])).toMatchObject({
      principal: { id: ownerId, role: 'owner' },
      defaultProfileId: ownerId,
    });
    const reader = await access.enterHousehold('owner password for testing');
    await profiles.select(reader, 'reader');
    await expect(
      devices.issuePairing(reader, ['admin'], 'Reader phone', { defaultProfileId: 'reader' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await devices.list(owner)).map((device) => device.id)).toContain(tokenHash(token));
    await store.transact((state) => {
      state.householdProfiles![0]!.ownerPrincipalId = 'reader';
    });
    await expect(devices.authenticate(token, ['admin'])).rejects.toMatchObject({ code: 'forbidden' });
    expect(await devices.authenticate(token, ['read'])).toMatchObject({ defaultProfileId: ownerId });
  });

  it('reports device availability using the same expiry, scope and authority rules as authentication', async () => {
    const { devices, store, owner } = await fixture();
    const token = await devices.redeemPairing(await devices.issuePairing(owner, ['read'], 'Phone'));
    const id = tokenHash(token);
    const state = await store.read();
    expect(devices.statusFromState(state, id, ['read'])).toBe('active');
    expect(devices.statusFromState(state, id, ['admin'])).toBe('unavailable');
    state.householdEpoch++;
    expect(devices.statusFromState(state, id, ['read'])).toBe('unavailable');
    expect(() => devices.authenticateFromState(state, token, ['read'])).toThrow();
    state.deviceTokens[0]!.expiresAt = 1;
    expect(devices.statusFromState(state, id, ['read'])).toBe('expired');
    state.deviceTokens = [];
    expect(devices.statusFromState(state, id, ['read'])).toBe('unavailable');
  });
  it('enforces the active device limit under concurrent pairing without consuming the rejected code', async () => {
    const { access, owner } = await fixture();
    const devices = new DeviceService({ access, scopesFor: () => ['read'], maxDevicesPerProfile: 1 });
    const first = await devices.issuePairing(owner, ['read'], 'First');
    const second = await devices.issuePairing(owner, ['read'], 'Second');
    const results = await Promise.allSettled([devices.redeemPairing(first), devices.redeemPairing(second)]);
    const accepted = results.find((result) => result.status === 'fulfilled');
    expect(accepted?.status).toBe('fulfilled');
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'rate_limited' }) }),
    ]);
    if (accepted?.status !== 'fulfilled') throw new Error('No device paired');
    await devices.revoke(owner, tokenHash(accepted.value));
    const rejectedCode = results[0]?.status === 'rejected' ? first : second;
    const replacement = await devices.redeemPairing(rejectedCode);
    expect((await devices.authenticate(replacement, ['read'])).id).toBe(tokenHash(replacement));
  });

  it('authenticates the complete prefixed device credential without changing pairing codes', async () => {
    const { access, owner } = await fixture();
    const devices = new DeviceService({ access, scopesFor: () => ['read'], tokenPrefix: 'sk_sotto_' });
    const pair = await devices.issuePairing(owner, ['read'], 'Phone');
    expect(pair).not.toMatch(/^sk_sotto_/);
    const token = await devices.redeemPairing(pair);
    expect(token).toMatch(/^sk_sotto_[A-Za-z0-9_-]{43}$/);
    expect((await devices.authenticate(token, ['read'])).name).toBe('Phone');
    await expect(devices.authenticate(token.slice('sk_sotto_'.length), ['read'])).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('requires both owner identity and delegated management scope to revoke other devices', async () => {
    const { access, store, owner } = await fixture();
    const devices = new DeviceService({
      access,
      scopesFor: (principal) => (principal?.role === 'owner' ? ['read', 'admin'] : ['read']),
      managementScope: 'admin',
    });
    const target = await devices.redeemPairing(await devices.issuePairing(owner, ['read'], 'Target'));
    const limited = await devices.redeemPairing(await devices.issuePairing(owner, ['read'], 'Limited'));
    await expect(devices.revokeForDevice(limited, tokenHash(target))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await devices.listForDevice(limited)).map((device) => device.name)).toEqual(['Limited']);
    const guest = await access.enterHousehold('owner password for testing');
    const household = await devices.redeemPairing(await devices.issuePairing(guest, ['read'], 'Household'));
    await expect(devices.revokeForDevice(household, tokenHash(target))).rejects.toMatchObject({
      code: 'forbidden',
    });
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    await store.transact((state) => {
      state.householdProfiles = [{ id: ownerId, name: 'Owner', epoch: 0, ownerPrincipalId: ownerId }];
    });
    await new HouseholdProfileService(access).select(owner, ownerId);
    const manager = await devices.redeemPairing(
      await devices.issuePairing(owner, ['read', 'admin'], 'Manager', { defaultProfileId: ownerId }),
    );
    expect((await devices.listForDevice(manager)).map((device) => device.name)).toContain('Target');
    await devices.revokeForDevice(manager, tokenHash(target));
    await expect(devices.authenticate(target, ['read'])).rejects.toMatchObject({ code: 'unauthorized' });
    await devices.revokeForDevice(limited, tokenHash(limited));
    await expect(devices.authenticate(limited, ['read'])).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('lets an initialized household device revoke itself without owner authority', async () => {
    const { access, store } = await fixture();
    const devices = new DeviceService({
      access,
      scopesFor: () => ['read'],
      managementScope: 'admin',
      tokenPrefix: 'sk_sotto_',
    });
    await store.transact((state) => {
      state.householdProfiles = [{ id: 'learner', name: 'Learner', epoch: 0 }];
      initializeHouseholdDevices(
        state,
        'initial-devices',
        [
          {
            hash: tokenHash('initial-token'),
            defaultProfileId: 'learner',
            name: 'Initial tablet',
            createdAt: 1,
            expiresAt: null,
            scopes: ['read'],
          },
        ],
        ['read'],
      );
    });
    expect(await devices.listForDevice('initial-token')).toEqual([
      {
        id: tokenHash('initial-token'),
        name: 'Initial tablet',
        scopes: ['read'],
        createdAt: 1,
        expiresAt: null,
      },
    ]);
    await devices.revokeForDevice('initial-token', tokenHash('initial-token'));
    await expect(devices.authenticate('initial-token', ['read'])).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('pairs the selected household profile and rejects stale selection or profile generations', async () => {
    const { access, devices, store, owner } = await fixture();
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    await store.transact((state) => {
      state.householdProfiles = [
        { id: ownerId, name: 'Admin', epoch: 0 },
        { id: 'first', name: 'First', epoch: 0 },
        { id: 'second', name: 'Second', epoch: 0 },
      ];
    });
    const guest = await access.enterHousehold('owner password for testing');
    const profiles = new HouseholdProfileService(access);
    await profiles.select(owner, ownerId);
    await profiles.select(guest, 'first');
    await expect(
      devices.issuePairing(owner, ['read'], 'Owner phone', { defaultProfileId: 'first' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await profiles.select(guest, 'second');
    await expect(
      devices.issuePairing(guest, ['read'], 'Phone', { defaultProfileId: 'first' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const stalePair = await devices.issuePairing(guest, ['read'], 'Phone', { defaultProfileId: 'second' });
    await store.transact((state) => {
      state.householdProfiles![2]!.epoch++;
    });
    await expect(devices.redeemPairing(stalePair)).rejects.toMatchObject({ code: 'unauthorized' });
    await profiles.select(guest, 'second');
    const device = await devices.redeemPairing(
      await devices.issuePairing(guest, ['read'], 'Phone', { defaultProfileId: 'second' }),
    );
    expect(await devices.authenticate(device, ['read'])).toMatchObject({
      principal: null,
      defaultProfileId: 'second',
      expiresAt: expect.any(Number),
    });
    await store.transact((state) => {
      state.householdProfiles![2] = { id: 'second', name: 'Replacement learner', epoch: 2 };
    });
    await expect(devices.authenticate(device, ['read'])).rejects.toMatchObject({ code: 'unauthorized' });
    const ownerDevice = await devices.redeemPairing(
      await devices.issuePairing(owner, ['admin'], 'Owner phone', { defaultProfileId: ownerId }),
    );
    expect((await devices.authenticate(ownerDevice, ['admin'])).principal?.role).toBe('owner');
  });
  it('preserves initialized household tokens through new pairing and restricts their revocation to owners', async () => {
    const { access, devices, store, owner } = await fixture();
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    await store.transact((state) => {
      state.householdProfiles = [
        { id: ownerId, name: 'Admin', epoch: 0 },
        { id: 'learner', name: 'Learner', epoch: 0 },
      ];
      initializeHouseholdDevices(
        state,
        'initial-devices',
        [
          {
            hash: tokenHash('initial-raw'),
            defaultProfileId: 'learner',
            name: 'Existing tablet',
            createdAt: 1,
            expiresAt: null,
            scopes: ['read'],
          },
        ],
        ['read'],
      );
    });
    await new HouseholdProfileService(access).select(owner, ownerId);
    expect(await devices.authenticate('initial-raw', ['read'])).toMatchObject({
      principal: null,
      defaultProfileId: 'learner',
      expiresAt: null,
    });
    await expect(devices.authenticate('initial-raw', ['admin'])).rejects.toMatchObject({ code: 'forbidden' });
    const paired = await devices.redeemPairing(await devices.issuePairing(owner, ['read'], 'New phone'));
    expect((await devices.authenticate(paired, ['read'])).expiresAt).not.toBeNull();
    expect((await devices.authenticate('initial-raw', ['read'])).expiresAt).toBeNull();
    const household = await access.enterHousehold('owner password for testing');
    await new HouseholdProfileService(access).select(household, 'learner');
    expect(await devices.list(household)).toEqual([]);
    const adminBrowser = await access.enterHousehold('owner password for testing');
    await new HouseholdProfileService(access).select(adminBrowser, ownerId);
    expect((await devices.list(adminBrowser)).some((device) => device.id === tokenHash('initial-raw'))).toBe(
      true,
    );
    await expect(devices.revoke(household, tokenHash('initial-raw'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await devices.revoke(adminBrowser, tokenHash('initial-raw'));
    await expect(devices.authenticate('initial-raw', ['read'])).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await store.transact((state) => {
      expect(initializeHouseholdDevices(state, 'initial-devices', [], ['read'])).toBe(false);
    });
    await expect(devices.authenticate('initial-raw', ['read'])).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
  it.each(['profile deletion', 'individual mode', 'password rotation'])(
    'invalidates an initialized household device after %s',
    async (change) => {
      const { access, devices, store, owner } = await fixture();
      const ownerId = (await access.authenticate(owner, true)).principal!.id;
      await store.transact((state) => {
        state.householdProfiles = [
          { id: ownerId, name: 'Admin', epoch: 0 },
          { id: 'learner', name: 'Learner', epoch: 0 },
        ];
        initializeHouseholdDevices(
          state,
          'devices',
          [
            {
              hash: tokenHash('initialized'),
              defaultProfileId: 'learner',
              name: 'Phone',
              createdAt: 1,
              expiresAt: null,
              scopes: ['read'],
            },
          ],
          ['read'],
        );
      });
      await new HouseholdProfileService(access).select(owner, ownerId);
      expect((await devices.authenticate('initialized', ['read'])).defaultProfileId).toBe('learner');
      if (change === 'profile deletion') {
        await store.transact((state) => {
          state.householdProfiles = [];
        });
      } else if (change === 'individual mode') {
        await access.setMode(owner, 'individual');
      } else {
        await access.configureHousehold(owner, 'replacement household password');
      }
      await expect(devices.authenticate('initialized', ['read'])).rejects.toMatchObject({
        code: 'unauthorized',
      });
    },
  );
  it('rejects initialization batches atomically when a profile or scope is invalid', async () => {
    const { store } = await fixture();
    const before = await store.read();
    await expect(
      store.transact((state) =>
        initializeHouseholdDevices(
          state,
          'invalid',
          [
            {
              hash: tokenHash('raw'),
              defaultProfileId: 'missing',
              name: 'Device',
              createdAt: 1,
              expiresAt: null,
              scopes: ['admin'],
            },
          ],
          ['read'],
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.read()).toEqual(before);
  });
  it('redeems a pairing once and persists only a hash of the device credential', async () => {
    const { devices, store, owner } = await fixture();
    const pair = await devices.issuePairing(owner, ['read'], 'Phone');
    const results = await Promise.allSettled([devices.redeemPairing(pair), devices.redeemPairing(pair)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const success = results.find((result) => result.status === 'fulfilled');
    if (success?.status !== 'fulfilled') throw new Error('Pairing failed');
    expect((await devices.authenticate(success.value, ['read'])).name).toBe('Phone');
    expect(JSON.stringify(await store.read())).not.toContain(success.value);
    await expect(devices.authenticate(success.value, ['admin'])).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rejects pairing after the issuing browser session is revoked', async () => {
    const { access, devices, owner } = await fixture();
    const pair = await devices.issuePairing(owner, ['read'], 'Phone');
    await access.revokeSession(owner, tokenHash(owner));
    await expect(devices.redeemPairing(pair)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('keeps a paired device independent of browser logout and supports its own revocation', async () => {
    const { access, devices, owner } = await fixture();
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    const device = await devices.redeemPairing(await devices.issuePairing(owner, ['read'], 'Phone'));
    await access.revokeSession(owner, tokenHash(owner));
    expect((await devices.authenticate(device, ['read'])).name).toBe('Phone');
    const replacement = await access.enterHousehold('owner password for testing');
    await new HouseholdProfileService(access).select(replacement, ownerId);
    await devices.revoke(replacement, tokenHash(device));
    await expect(devices.authenticate(device, ['read'])).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('limits household delegation and invalidates household devices when the admission password changes', async () => {
    const { access, devices, owner } = await fixture();
    const guest = await access.enterHousehold('owner password for testing');
    await expect(devices.issuePairing(guest, ['admin'], 'Phone')).rejects.toMatchObject({
      code: 'forbidden',
    });
    const device = await devices.redeemPairing(await devices.issuePairing(guest, ['read'], 'Phone'));
    const otherGuest = await access.enterHousehold('owner password for testing');
    expect(await devices.list(otherGuest)).toEqual([]);
    await expect(devices.revoke(otherGuest, tokenHash(device))).rejects.toMatchObject({ code: 'forbidden' });
    await access.configureHousehold(owner, 'replacement household password');
    await expect(devices.authenticate(device, ['read'])).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('reduces device permissions when its owner loses owner privileges', async () => {
    const { access, devices, store, owner } = await fixture();
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    await store.transact((state) => {
      state.householdProfiles = [{ id: ownerId, name: 'Owner', epoch: 0, ownerPrincipalId: ownerId }];
    });
    await new HouseholdProfileService(access).select(owner, ownerId);
    const device = await devices.redeemPairing(
      await devices.issuePairing(owner, ['read', 'admin'], 'Phone', { defaultProfileId: ownerId }),
    );
    await store.transact((state) => {
      state.principals[0]!.role = 'member';
    });
    await expect(devices.authenticate(device, ['admin'])).rejects.toMatchObject({ code: 'forbidden' });
    expect((await devices.authenticate(device, ['read'])).scopes).toEqual(['read']);
  });
});
