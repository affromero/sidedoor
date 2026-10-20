import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  HouseholdProfileService,
  HouseholdProfileManagement,
  DeviceService,
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
  const ownerId = (await store.read()).principals.find((principal) => principal.role === 'owner')!.id;
  await new HouseholdProfileService(access).select(owner, ownerId);
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
  const guest = await access.enterHousehold('owner password for testing');
  return { access, store, owner, guest, profiles: new HouseholdProfileService(access) };
}

async function selfRemovalFixture() {
  const values = await fixture();
  const ownerId = (await values.access.authenticate(values.owner, true)).principal!.id;
  const member = await values.store.transact((state) => {
    state.householdProfiles = [
      { id: ownerId, name: 'Owner', epoch: 0 },
      { id: 'profile', name: 'Learner', epoch: 0 },
      { id: 'dormant', name: 'Pending owner', epoch: 0 },
    ];
    return values.access.issueSession(state, 'profile', 'Member session');
  });
  await values.profiles.select(values.owner, ownerId);
  const devices = new DeviceService({ access: values.access, scopesFor: () => ['app'] });
  const device = await devices.redeemPairing(await devices.issuePairing(member, ['app'], 'Member phone'));
  const management = new HouseholdProfileManagement(values.access, {
    devices,
    requiredDeviceScopes: ['app'],
    ownerDeviceScope: 'owner',
  });
  return { ...values, member, device, devices, management, ownerId };
}

describe('household profiles', () => {
  it.each(['session', 'device'] as const)(
    'allows a scoped %s to delete only its own member and revoke all associated access',
    async (kind) => {
      const { access, store, owner, guest, member, device, devices, management, profiles, ownerId } =
        await selfRemovalFixture();
      await profiles.select(guest, 'profile');
      const sharedDevice = await devices.redeemPairing(
        await devices.issuePairing(guest, ['app'], 'Shared tablet', { defaultProfileId: 'profile' }),
      );
      const pending = await devices.issuePairing(member, ['app'], 'Another phone');
      const removal = management.prepareRemoveSelf('profile', 0, true);
      await store.transact((state) =>
        removal.apply(state, { kind, token: kind === 'session' ? member : device }),
      );
      const remaining = await store.read();
      expect(remaining.principals.some((principal) => principal.id === 'profile')).toBe(false);
      expect(remaining.householdProfiles?.some((profile) => profile.id === 'profile')).toBe(false);
      expect(remaining.householdProfiles?.some((profile) => profile.id === ownerId)).toBe(true);
      expect((await access.authenticate(owner, true)).principal?.id).toBe(ownerId);
      expect(await profiles.selected(guest)).toBeNull();
      await expect(access.authenticate(member)).rejects.toMatchObject({ code: 'unauthorized' });
      for (const token of [device, sharedDevice])
        await expect(devices.authenticate(token, ['app'])).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(devices.redeemPairing(pending)).rejects.toMatchObject({ code: 'unauthorized' });
    },
  );

  it.each(['session', 'device'] as const)(
    'never grants a self-removing %s household management or another identity',
    async (kind) => {
      const { store, member, device, management, ownerId } = await selfRemovalFixture();
      const credential = { kind, token: kind === 'session' ? member : device };
      for (const operation of [
        management.prepareCreate('New learner'),
        management.prepareUpdate('profile', 'Changed'),
        management.prepareRemove('profile', 0, true),
        management.prepareRemoveSelf('dormant', 0, true),
        management.prepareRemoveSelf(ownerId, 0, true),
      ])
        await expect(store.transact((state) => operation.apply(state, credential))).rejects.toMatchObject({
          code: 'forbidden',
        });
      expect((await store.read()).householdProfiles?.find((profile) => profile.id === 'profile')?.name).toBe(
        'Learner',
      );
    },
  );

  it.each(['session', 'device'] as const)(
    'revalidates revoked, expired and changed-epoch %s credentials at application time',
    async (kind) => {
      for (const failure of ['revoked', 'expired', 'principal-epoch', 'profile-epoch']) {
        const { store, member, device, management } = await selfRemovalFixture();
        const credential = { kind, token: kind === 'session' ? member : device };
        const removal = management.prepareRemoveSelf('profile', 0, true);
        await store.transact((state) => {
          if (failure === 'principal-epoch') state.principals.find((item) => item.id === 'profile')!.epoch++;
          else if (failure === 'profile-epoch')
            state.householdProfiles!.find((item) => item.id === 'profile')!.epoch++;
          else if (kind === 'session') {
            const session = state.sessions.find((item) => item.principalId === 'profile')!;
            if (failure === 'expired') session.expiresAt = 0;
            else state.sessions = state.sessions.filter((item) => item !== session);
          } else {
            const saved = state.deviceTokens.find((item) => item.principalId === 'profile')!;
            if (failure === 'expired') saved.expiresAt = 0;
            else state.deviceTokens = state.deviceTokens.filter((item) => item !== saved);
          }
        });
        await expect(store.transact((state) => removal.apply(state, credential))).rejects.toMatchObject({
          code: failure === 'profile-epoch' ? 'conflict' : 'unauthorized',
        });
        expect((await store.read()).principals.some((principal) => principal.id === 'profile')).toBe(true);
      }
    },
  );

  it('revalidates required native scopes before applying prepared self deletion', async () => {
    const { store, device, management } = await selfRemovalFixture();
    const removal = management.prepareRemoveSelf('profile', 0, true);
    await store.transact((state) => {
      state.deviceTokens.find((item) => item.principalId === 'profile')!.scopes = ['other'];
    });
    const original = await store.read();
    await expect(
      store.transact((state) => removal.apply(state, { kind: 'device', token: device })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await store.read()).toEqual(original);
  });

  it('retains confirmation, protected owners, minimum counts and atomic application rollback for self deletion', async () => {
    const { access, store, member, guest, management, ownerId } = await selfRemovalFixture();
    expect(() => management.prepareRemoveSelf('profile', 0, false)).toThrow();
    const removal = management.prepareRemoveSelf('profile', 0, true);
    await expect(
      store.transact((state) => removal.apply(state, { kind: 'session', token: guest })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    for (const id of [ownerId, 'dormant']) {
      const token = await store.transact((state) => access.issueSession(state, id, 'Protected identity'));
      const protectedRemoval = management.prepareRemoveSelf(id, 0, true);
      await expect(
        store.transact((state) => protectedRemoval.apply(state, { kind: 'session', token })),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
    const minimum = new HouseholdProfileManagement(access, { minimumProfiles: 3 }).prepareRemoveSelf(
      'profile',
      0,
      true,
    );
    await expect(
      store.transact((state) => minimum.apply(state, { kind: 'session', token: member })),
    ).rejects.toMatchObject({ code: 'conflict' });
    const original = await store.read();
    await expect(
      store.transact((state) => {
        removal.apply(state, { kind: 'session', token: member });
        throw new Error('Application cleanup could not commit');
      }),
    ).rejects.toThrow('cleanup');
    expect(await store.read()).toEqual(original);
  });

  it('protects minimum counts and pending owners while keeping household members manageable', async () => {
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
    await store.transact((state) => prepared.apply(state, { kind: 'session', token: guest }));
    expect((await store.read()).householdProfiles).toHaveLength(1);
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
    expect((await access.authenticate(owner)).principal).toBeNull();
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
    const credentialedUpdate = management.prepareUpdate('profile', 'Credentialed label');
    await store.transact((current) => credentialedUpdate.apply(current, { kind: 'session', token: guest }));
    expect((await store.read()).householdProfiles?.[0]?.name).toBe('Credentialed label');
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
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    await store.transact((state) => {
      state.householdProfiles = [{ id: ownerId, name: 'Admin', epoch: 0 }];
    });
    await new HouseholdProfileService(access).select(owner, ownerId);
    const devices = new DeviceService({ access, scopesFor: () => ['app', 'owner'] });
    const management = new HouseholdProfileManagement(access, {
      devices,
      requiredDeviceScopes: ['app'],
      ownerDeviceScope: 'owner',
    });
    const limited = await devices.redeemPairing(
      await devices.issuePairing(owner, ['app'], 'Tablet', { defaultProfileId: ownerId }),
    );
    const prepared = management.prepareCreate('Learner');
    await expect(
      store.transact((state) => prepared.apply(state, { kind: 'device', token: limited })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const delegated = await devices.redeemPairing(
      await devices.issuePairing(owner, ['app', 'owner'], 'Owner tablet', {
        defaultProfileId: ownerId,
      }),
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
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    await store.transact((state) => {
      state.householdProfiles = [
        { id: ownerId, name: 'Admin', epoch: 0 },
        { id: 'profile', name: 'Learner', epoch: 0 },
      ];
    });
    await new HouseholdProfileService(access).select(owner, ownerId);
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
  it('grants Admin settings after household password entry and Admin selection, then removes them on switch', async () => {
    const { access, store, owner, guest, profiles } = await fixture();
    const principal = (await access.authenticate(owner, true)).principal!;
    await store.transact((state) => {
      state.householdProfiles = [{ id: principal.id, name: 'Shared owner library', epoch: 1 }];
    });
    await profiles.select(owner, principal.id);
    await expect(access.authenticate(guest, true)).rejects.toMatchObject({ code: 'forbidden' });
    await profiles.select(guest, principal.id);
    expect(await profiles.selected(guest)).toEqual({ id: principal.id, name: 'Shared owner library' });
    expect((await access.authenticate(guest)).principal).toBeNull();
    expect((await access.authenticate(guest, true)).principal?.id).toBe(principal.id);
    await profiles.select(guest, null);
    await expect(access.authenticate(guest, true)).rejects.toMatchObject({ code: 'forbidden' });
    await profiles.select(guest, principal.id);
    await store.transact((state) => {
      state.householdProfiles = [];
    });
    expect(await profiles.list(guest)).toEqual([]);
    expect(await profiles.selected(guest)).toBeNull();
    await expect(access.authenticate(guest, true)).rejects.toMatchObject({ code: 'forbidden' });
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

  it('invalidates a selected profile when its generation changes', async () => {
    const { store, guest, profiles } = await fixture();
    await profiles.select(guest, 'profile');
    await store.transact((state) => {
      const profile = state.principals.find((principal) => principal.id === 'profile')!;
      profile.epoch++;
    });
    expect(await profiles.selected(guest)).toBeNull();
  });

  it('requires explicit open admission and keeps concurrent gate enable authoritative', async () => {
    const { access, store, owner } = await fixture();
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    const open = new AccessService({ store, allowOpenHousehold: true });
    await open.configureHousehold(owner, null);
    await expect(access.enterOpenHousehold()).rejects.toMatchObject({ code: 'forbidden' });
    const admitted = await open.enterOpenHousehold();
    expect((await open.authenticate(admitted)).principal).toBeNull();
    const expiry = (await open.authenticate(admitted)).session.expiresAt;
    expect(await open.enterOpenHousehold('Same browser', admitted)).toBe(admitted);
    expect((await open.authenticate(admitted)).session.expiresAt).toBe(expiry);
    await new HouseholdProfileService(open).select(admitted, ownerId);
    const [admission, rotation] = await Promise.allSettled([
      open.enterOpenHousehold(),
      access.configureHousehold(admitted, 'concurrent gate password'),
    ]);
    expect(rotation.status).toBe('fulfilled');
    if (admission.status === 'fulfilled')
      await expect(open.authenticate(admission.value)).rejects.toMatchObject({ code: 'unauthorized' });
    else expect(admission.reason).toMatchObject({ code: 'forbidden' });
    await expect(open.authenticate(admitted)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(open.enterOpenHousehold()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await open.supportsOpenHousehold()).toBe(false);
    const replacement = await open.enterHousehold('concurrent gate password');
    await new HouseholdProfileService(open).select(replacement, ownerId);
    await open.configureHousehold(replacement, null);
    const openAdmin = await open.enterOpenHousehold();
    await new HouseholdProfileService(open).select(openAdmin, ownerId);
    await access.setMode(openAdmin, 'individual');
    await expect(open.enterOpenHousehold()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('bounds anonymous session creation per minute without using the password failure bucket', async () => {
    const { store, owner } = await fixture();
    let now = Date.now();
    const open = new AccessService({ store, allowOpenHousehold: true, now: () => now });
    await open.configureHousehold(owner, null);
    for (let index = 0; index < 120; index++) await open.enterOpenHousehold();
    await expect(open.enterOpenHousehold()).rejects.toMatchObject({ code: 'rate_limited' });
    expect((await store.read()).failures.some((failure) => failure.key === 'rate:household')).toBe(false);
    now += 60_001;
    expect((await open.authenticate(await open.enterOpenHousehold())).principal).toBeNull();
  });

  it('selects household content, including Admin, without exposing pending owners', async () => {
    const { access, owner, guest, profiles } = await fixture();
    expect(await profiles.list(guest)).toEqual([
      { id: (await access.authenticate(owner, true)).principal!.id, name: 'Owner' },
      { id: 'profile', name: 'Household member' },
    ]);
    await profiles.select(guest, 'profile');
    expect(await profiles.selected(guest)).toEqual({ id: 'profile', name: 'Household member' });
    expect((await access.authenticate(guest)).principal).toBeNull();
    await expect(access.authenticate(guest, true)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(access.rotatePrincipalCredential(guest, 'replacement password')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(profiles.select(guest, 'dormant')).rejects.toMatchObject({ code: 'forbidden' });
    await profiles.select(owner, 'profile');
    await expect(access.authenticate(owner, true)).rejects.toMatchObject({ code: 'forbidden' });
    await profiles.select(guest, null);
    expect(await profiles.selected(guest)).toBeNull();
  });

  it('keeps a household selection independent of account credentials and rejects replaced profiles', async () => {
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
    expect(await profiles.selected(guest)).toEqual({ id: 'profile', name: 'Household member' });
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
    const ownerId = (await access.authenticate(owner, true)).principal!.id;
    await profiles.select(guest, 'profile');
    await access.configureHousehold(owner, 'replacement household password');
    await expect(profiles.selected(guest)).rejects.toMatchObject({ code: 'unauthorized' });
    const replacement = await access.enterHousehold('replacement household password');
    await profiles.select(replacement, 'profile');
    await profiles.select(replacement, ownerId);
    await access.setMode(replacement, 'individual');
    await expect(profiles.selected(replacement)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
