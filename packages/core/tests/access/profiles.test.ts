import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  HouseholdProfileService,
  HouseholdProfileManagement,
  DeviceService,
  PrincipalManagement,
  accessStateSchema,
  initialAccessState,
} from '../../src/access';
import { FileStateStore } from '../../src/storage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-profile-'));
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
  await access.configureHousehold(owner, 'household password for testing');
  await store.transact((state) => {
    state.principals.push({
      id: 'profile',
      name: 'Household member',
      role: 'member',
      passwordHash: null,
      epoch: 0,
      createdAt: Date.now(),
    });
    state.principals.push({
      id: 'dormant',
      name: 'Dormant admin',
      role: 'member',
      pendingRole: 'owner',
      passwordHash: null,
      epoch: 0,
      createdAt: Date.now(),
    });
  });
  const guest = await access.enterHousehold('household password for testing');
  return { access, store, owner, guest, profiles: new HouseholdProfileService(access) };
}

describe('household profiles', () => {
  it('protects minimum profile counts, pending owners and profiles converted to private accounts', async () => {
    const { access, store, guest } = await fixture();
    await store.transact((state) => {
      state.householdProfiles = [
        { id: 'profile', name: 'Learner', epoch: 0 },
        { id: 'dormant', name: 'Pending owner', epoch: 0 },
      ];
    });
    const management = new HouseholdProfileManagement(access, {
      allowHouseholdManagement: true,
      minimumProfiles: 2,
    });
    const removal = management.prepareRemove('profile', 0, true);
    await expect(
      store.transact((state) => removal.apply(state, { kind: 'session', token: guest })),
    ).rejects.toMatchObject({ code: 'conflict' });
    const permissiveCount = new HouseholdProfileManagement(access, { allowHouseholdManagement: true });
    const pendingOwner = permissiveCount.prepareRemove('dormant', 0, true);
    await expect(
      store.transact((state) => pendingOwner.apply(state, { kind: 'session', token: guest })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const prepared = permissiveCount.prepareRemove('profile', 0, true);
    await store.transact((state) => {
      state.principals.find((principal) => principal.id === 'profile')!.passwordHash = 'credentialed';
    });
    await expect(
      store.transact((state) => prepared.apply(state, { kind: 'session', token: guest })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await store.read()).householdProfiles).toHaveLength(2);
  });
  it('removes profile-bound authority while retaining household admission and unrelated owner sessions', async () => {
    const { access, store, guest, owner } = await fixture();
    await store.transact((state) => {
      state.householdProfiles = [{ id: 'profile', name: 'Learner', epoch: 2 }];
    });
    const profiles = new HouseholdProfileService(access);
    await profiles.select(guest, 'profile');
    const devices = new DeviceService({ access, scopesFor: () => ['app'] });
    const token = await devices.redeemPairing(
      await devices.issuePairing(guest, ['app'], 'Tablet', { defaultProfileId: 'profile' }),
    );
    const pending = await devices.issuePairing(guest, ['app'], 'Phone', { defaultProfileId: 'profile' });
    const management = new HouseholdProfileManagement(access, { allowHouseholdManagement: true });
    expect(() => management.prepareRemove('profile', 2, false)).toThrow();
    const stale = management.prepareRemove('profile', 1, true);
    await expect(
      store.transact((state) => stale.apply(state, { kind: 'session', token: guest })),
    ).rejects.toMatchObject({ code: 'conflict' });
    const removal = management.prepareRemove('profile', 2, true);
    await store.transact((state) => removal.apply(state, { kind: 'session', token: guest }));
    expect((await access.authenticate(guest)).principal).toBeNull();
    expect((await access.authenticate(owner)).principal?.role).toBe('owner');
    expect(await profiles.selected(guest)).toBeNull();
    await expect(devices.authenticate(token, ['app'])).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(devices.redeemPairing(pending)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await store.read()).principals.some((principal) => principal.id === 'profile')).toBe(false);
  });
  it('renames a household label without changing its login name or selection generation', async () => {
    const { access, store, guest } = await fixture();
    await store.transact((state) => {
      state.householdProfiles = [{ id: 'profile', name: 'Old label', epoch: 4 }];
    });
    const management = new HouseholdProfileManagement(access, { allowHouseholdManagement: true });
    const update = management.prepareUpdate('profile', 'New label');
    await store.transact((state) => update.apply(state, { kind: 'session', token: guest }));
    const state = await store.read();
    expect(state.householdProfiles).toEqual([{ id: 'profile', name: 'New label', epoch: 4 }]);
    expect(state.principals.find((principal) => principal.id === 'profile')?.name).toBe('Household member');
    await store.transact((current) => {
      current.principals.find((principal) => principal.id === 'profile')!.passwordHash = 'credentialed';
    });
    await expect(
      store.transact((current) => update.apply(current, { kind: 'session', token: guest })),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('creates duplicate household labels with distinct login names and rolls back failed application work', async () => {
    const { access, store, owner, guest } = await fixture();
    await store.transact((state) => {
      state.householdProfiles = [];
    });
    const restricted = new HouseholdProfileManagement(access).prepareCreate('New learner');
    await expect(
      store.transact((state) => restricted.apply(state, { kind: 'session', token: guest })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const management = new HouseholdProfileManagement(access, { allowHouseholdManagement: true });
    const first = management.prepareCreate('Sam');
    await expect(
      store.transact((state) => {
        first.apply(state, { kind: 'session', token: guest });
        throw new Error('Application write failed');
      }),
    ).rejects.toThrow('Application write failed');
    expect((await store.read()).principals.some((principal) => principal.id === first.id)).toBe(false);
    await store.transact((state) => first.apply(state, { kind: 'session', token: guest }));
    const second = management.prepareCreate('Sam');
    await store.transact((state) => second.apply(state, { kind: 'session', token: owner }));
    const state = await store.read();
    expect(state.householdProfiles?.map((profile) => profile.name)).toEqual(['Sam', 'Sam']);
    expect(
      state.principals
        .filter((principal) => [first.id, second.id].includes(principal.id))
        .map((principal) => principal.name),
    ).toEqual(['Sam', 'Sam (2)']);
    expect(state.principals.find((principal) => principal.id === first.id)).toMatchObject({
      role: 'member',
      passwordHash: null,
    });
  });

  it('requires delegated owner scope for native owner profile creation and revalidates prepared credentials', async () => {
    const { access, store, owner } = await fixture();
    await store.transact((state) => {
      state.householdProfiles = [];
    });
    const devices = new DeviceService({ access, scopesFor: () => ['app', 'owner'] });
    const management = new HouseholdProfileManagement(access, {
      devices,
      requiredDeviceScopes: ['app'],
      ownerDeviceScope: 'owner',
    });
    const limited = await devices.redeemPairing(await devices.issuePairing(owner, ['app'], 'Tablet'));
    const prepared = management.prepareCreate('Learner');
    await expect(
      store.transact((state) => prepared.apply(state, { kind: 'device', token: limited })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const delegated = await devices.redeemPairing(
      await devices.issuePairing(owner, ['app', 'owner'], 'Owner tablet'),
    );
    await store.transact((state) => prepared.apply(state, { kind: 'device', token: delegated }));
    const revoked = management.prepareCreate('Another learner');
    await access.logout(owner);
    await expect(
      store.transact((state) => revoked.apply(state, { kind: 'session', token: owner })),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('preserves household device profile creation without granting principal authority', async () => {
    const { access, store, owner, guest } = await fixture();
    await store.transact((state) => {
      state.householdProfiles = [{ id: 'profile', name: 'Learner', epoch: 0 }];
    });
    await new HouseholdProfileService(access).select(guest, 'profile');
    const devices = new DeviceService({ access, scopesFor: () => ['app'] });
    const token = await devices.redeemPairing(
      await devices.issuePairing(guest, ['app'], 'Household tablet', { defaultProfileId: 'profile' }),
    );
    const management = new HouseholdProfileManagement(access, {
      devices,
      requiredDeviceScopes: ['app'],
      allowHouseholdManagement: true,
    });
    const prepared = management.prepareCreate('New learner');
    await store.transact((state) => prepared.apply(state, { kind: 'device', token }));
    expect((await store.read()).principals.find((principal) => principal.id === prepared.id)).toMatchObject({
      role: 'member',
      passwordHash: null,
    });
    const identity = await devices.authenticate(token, ['app']);
    expect(identity.principal).toBeNull();
    await devices.revoke(owner, identity.id);
    const other = management.prepareCreate('Another learner');
    await expect(
      store.transact((state) => other.apply(state, { kind: 'device', token })),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('selects independently shared owner content without granting principal authority', async () => {
    const { access, store, owner, guest, profiles } = await fixture();
    const principal = (await access.authenticate(owner)).principal!;
    await store.transact((state) => {
      state.householdProfiles = [{ id: principal.id, name: 'Shared owner library', epoch: 1 }];
    });
    await profiles.select(guest, principal.id);
    expect(await profiles.selected(guest)).toEqual({ id: principal.id, name: 'Shared owner library' });
    expect((await access.authenticate(guest)).principal).toBeNull();
    await expect(access.authenticate(guest, true)).rejects.toMatchObject({ code: 'forbidden' });
    await new PrincipalManagement(access).resetPasswordForOperator(
      principal.id,
      'replacement owner password',
    );
    expect(await profiles.selected(guest)).toEqual({ id: principal.id, name: 'Shared owner library' });
    await store.transact((state) => {
      state.householdProfiles = [];
    });
    expect(await profiles.list(guest)).toEqual([]);
    expect(await profiles.selected(guest)).toBeNull();
    await store.transact((state) => {
      state.householdProfiles = [{ id: principal.id, name: 'Recreated library', epoch: 2 }];
    });
    expect(await profiles.selected(guest)).toBeNull();
  });

  it('does not reinterpret a principal selection as an explicit household profile', async () => {
    const { store, guest, profiles } = await fixture();
    await profiles.select(guest, 'profile');
    await store.transact((state) => {
      state.householdProfiles = [{ id: 'profile', name: 'Independent content', epoch: 0 }];
    });
    expect(await profiles.selected(guest)).toBeNull();
    await profiles.select(guest, 'profile');
    expect(await profiles.selected(guest)).toEqual({ id: 'profile', name: 'Independent content' });
    await store.transact((state) => {
      delete state.householdProfiles;
    });
    expect(await profiles.selected(guest)).toBeNull();
  });

  it('atomically admits a selectable profile without allocating sessions for rejected profiles', async () => {
    const { store, owner } = await fixture();
    const access = new AccessService({ store, allowOpenHousehold: true });
    const profiles = new HouseholdProfileService(access);
    await access.configureHousehold(owner, null);
    const before = (await store.read()).sessions;
    for (const id of ['missing', 'dormant'])
      await expect(profiles.enterOpen(id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await store.read()).sessions).toEqual(before);
    const token = await profiles.enterOpen('profile');
    expect(await profiles.selected(token)).toEqual({ id: 'profile', name: 'Household member' });
    expect((await access.authenticate(token)).principal).toBeNull();
    expect(await profiles.enterOpen('profile', token)).toBe(token);
  });

  it('never resolves a protected profile when open admission races credential enrollment', async () => {
    const { store, owner } = await fixture();
    const access = new AccessService({ store, allowOpenHousehold: true });
    const profiles = new HouseholdProfileService(access);
    await access.configureHousehold(owner, null);
    const [admission, protection] = await Promise.allSettled([
      profiles.enterOpen('profile'),
      store.transact((state) => {
        const profile = state.principals.find((principal) => principal.id === 'profile')!;
        profile.passwordHash = 'externally configured credential';
        profile.epoch++;
      }),
    ]);
    expect(protection.status).toBe('fulfilled');
    if (admission.status === 'fulfilled') expect(await profiles.selected(admission.value)).toBeNull();
    else expect(admission.reason).toMatchObject({ code: 'forbidden' });
  });

  it('never resolves a protected profile when selection races its first credential', async () => {
    const { store, guest, profiles } = await fixture();
    const [selection, protection] = await Promise.allSettled([
      profiles.select(guest, 'profile'),
      store.transact((state) => {
        const profile = state.principals.find((principal) => principal.id === 'profile')!;
        profile.passwordHash = 'new externally configured credential';
        profile.epoch++;
      }),
    ]);
    expect(protection.status).toBe('fulfilled');
    if (selection.status === 'rejected') expect(selection.reason).toMatchObject({ code: 'forbidden' });
    expect(await profiles.selected(guest)).toBeNull();
  });

  it('requires explicit open admission and keeps concurrent gate enable authoritative', async () => {
    const { access, store, owner } = await fixture();
    const open = new AccessService({ store, allowOpenHousehold: true });
    await open.configureHousehold(owner, null);
    await expect(access.enterOpenHousehold()).rejects.toMatchObject({ code: 'forbidden' });
    const admitted = await open.enterOpenHousehold();
    expect((await open.authenticate(admitted)).principal).toBeNull();
    const expiry = (await open.authenticate(admitted)).session.expiresAt;
    expect(await open.enterOpenHousehold('Same browser', admitted)).toBe(admitted);
    expect((await open.authenticate(admitted)).session.expiresAt).toBe(expiry);
    const [admission, rotation] = await Promise.allSettled([
      open.enterOpenHousehold(),
      access.configureHousehold(owner, 'concurrent gate password'),
    ]);
    expect(rotation.status).toBe('fulfilled');
    if (admission.status === 'fulfilled')
      await expect(open.authenticate(admission.value)).rejects.toMatchObject({ code: 'unauthorized' });
    else expect(admission.reason).toMatchObject({ code: 'forbidden' });
    await expect(open.authenticate(admitted)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(open.enterOpenHousehold()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await open.supportsOpenHousehold()).toBe(false);
    await open.configureHousehold(owner, null);
    await access.setMode(owner, 'individual');
    await expect(open.enterOpenHousehold()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('bounds anonymous session creation per minute without using the password failure bucket', async () => {
    const { store, owner } = await fixture();
    let now = Date.now();
    const open = new AccessService({ store, allowOpenHousehold: true, now: () => now });
    await open.configureHousehold(owner, null);
    for (let index = 0; index < 120; index++) await open.enterOpenHousehold();
    await expect(open.enterOpenHousehold()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(
      (await open.authenticate(await open.login('Owner', 'owner password for testing'))).principal?.role,
    ).toBe('owner');
    now += 60_001;
    expect((await open.authenticate(await open.enterOpenHousehold())).principal).toBeNull();
  });

  it('selects content without authenticating an account or exposing dormant administrators', async () => {
    const { access, owner, guest, profiles } = await fixture();
    expect(await profiles.list(guest)).toEqual([{ id: 'profile', name: 'Household member' }]);
    await profiles.select(guest, 'profile');
    expect(await profiles.selected(guest)).toEqual({ id: 'profile', name: 'Household member' });
    expect((await access.authenticate(guest)).principal).toBeNull();
    await expect(access.authenticate(guest, true)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(access.rotatePrincipalCredential(guest, 'replacement password')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(profiles.select(guest, 'dormant')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(profiles.select(owner, 'profile')).rejects.toMatchObject({ code: 'forbidden' });
    await profiles.select(guest, null);
    expect(await profiles.selected(guest)).toBeNull();
  });

  it('invalidates a selection when a profile gains credentials and does not restore it after an epoch change', async () => {
    const { store, guest, profiles } = await fixture();
    await profiles.select(guest, 'profile');
    await store.transact((state) => {
      state.passkeys.push({
        id: 'credential',
        principalId: 'profile',
        publicKey: 'boundary-fixture',
        counter: 0,
        transports: ['internal'],
        name: 'Phone',
        createdAt: Date.now(),
        backedUp: false,
      });
    });
    expect(await profiles.selected(guest)).toBeNull();
    await expect(profiles.select(guest, 'profile')).rejects.toMatchObject({ code: 'forbidden' });
    await store.transact((state) => {
      state.passkeys = [];
      state.principals.find((principal) => principal.id === 'profile')!.epoch++;
    });
    expect(await profiles.selected(guest)).toBeNull();
    await profiles.select(guest, 'profile');
    await store.transact((state) => {
      state.principals = state.principals.filter((principal) => principal.id !== 'profile');
    });
    expect(await profiles.selected(guest)).toBeNull();
  });

  it('revokes selected-profile access when the household password or access mode changes', async () => {
    const { access, owner, guest, profiles } = await fixture();
    await profiles.select(guest, 'profile');
    await access.configureHousehold(owner, 'replacement household password');
    await expect(profiles.selected(guest)).rejects.toMatchObject({ code: 'unauthorized' });
    const replacement = await access.enterHousehold('replacement household password');
    await profiles.select(replacement, 'profile');
    await access.setMode(owner, 'individual');
    await expect(profiles.selected(replacement)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
