import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessService, accessStateSchema, initialAccessState, tokenHash } from '../../src/access/index';
import { FileStateStore } from '../../src/storage/index';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sidedoor-access-'));
  directories.push(dir);
  const store = new FileStateStore({
    path: join(dir, 'access.json'),
    initial: initialAccessState,
    parse: (value) => accessStateSchema.parse(value),
  });
  const service = new AccessService({ store });
  const claim = await service.issueOperatorToken();
  const owner = await service.claimOwner(claim, 'Owner', 'correct horse battery staple', 'household');
  return { store, service, claim, owner };
}

describe('instance access', () => {
  it('rejects admission against a superseded password policy even when the password stays the same', async () => {
    const { service, store, owner } = await fixture();
    await service.configureHousehold(owner, 'household password for guests');
    const before = await store.read();
    await store.transact((state) => {
      state.householdEpoch++;
    });
    await expect(
      service.enterHousehold('household password for guests', 'Browser', {
        householdEpoch: before.householdEpoch,
        policyEpoch: before.policyEpoch,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await store.read()).sessions).toEqual(before.sessions);
    expect(
      (await service.authenticate(await service.enterHousehold('household password for guests'))).principal,
    ).toBeNull();
  });

  it('changes a password with current-password proof without leaving a replacement session after failure', async () => {
    const { service, store, owner } = await fixture();
    const sessions = (await store.read()).sessions;
    await expect(
      service.rotatePrincipalCredential(owner, 'replacement password', 'wrong'),
    ).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect((await store.read()).sessions).toEqual(sessions);
    await expect(
      service.rotatePrincipalCredential(owner, 'short', 'correct horse battery staple'),
    ).rejects.toBeInstanceOf(Error);
    expect((await store.read()).sessions).toEqual(sessions);
    const updated = await service.rotatePrincipalCredential(
      owner,
      'replacement password',
      'correct horse battery staple',
    );
    expect((await service.authenticate(updated)).principal?.role).toBe('owner');
    await expect(service.authenticate(owner)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(
      (await service.authenticate(await service.login('Owner', 'replacement password'))).principal?.role,
    ).toBe('owner');
  });

  it('keeps valid recovery available after invalid recovery submissions', async () => {
    const { service, owner } = await fixture();
    const codes = await service.recoveryCodes(owner);
    for (let index = 0; index < 12; index++) {
      await expect(service.recover(`invalid-${index}`, 'a replacement password')).rejects.toMatchObject({
        code: 'unauthorized',
      });
    }
    const recovered = await service.recover(codes[0]!, 'a replacement password');
    expect((await service.authenticate(recovered)).principal?.role).toBe('owner');
  });
  it('rotates the active session after password verification and revokes other devices after a password change', async () => {
    const { service, owner } = await fixture();
    const phone = await service.login('Owner', 'correct horse battery staple', 'Phone');
    const verified = await service.reauthenticate(owner, 'correct horse battery staple');
    await expect(service.authenticate(owner)).rejects.toMatchObject({ code: 'unauthorized' });
    const updated = await service.rotatePrincipalCredential(verified, 'new owner password for testing');
    await expect(service.authenticate(phone)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(service.authenticate(verified)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await service.authenticate(updated)).principal?.role).toBe('owner');
    await expect(service.login('Owner', 'correct horse battery staple')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(
      (await service.authenticate(await service.login('Owner', 'new owner password for testing'))).principal
        ?.role,
    ).toBe('owner');
  });
  it('requires a one-time operator claim and never stores raw session credentials', async () => {
    const { service, store, claim, owner } = await fixture();
    await expect(
      service.claimOwner(claim, 'Attacker', 'another long password', 'individual'),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await service.authenticate(owner, true)).principal?.name).toBe('Owner');
    const serialized = JSON.stringify(await store.read());
    expect(serialized).not.toContain(owner);
    expect(serialized).not.toContain('correct horse battery staple');
  });

  it('activates a pending owner only once through an epoch-bound local recovery token', async () => {
    const { service, store } = await fixture();
    await store.transact((state) => {
      state.principals.push({
        id: 'dormant',
        name: 'Dormant',
        role: 'member',
        pendingRole: 'owner',
        passwordHash: null,
        epoch: 0,
        createdAt: Date.now(),
      });
    });
    const code = await service.issueOperatorToken('dormant');
    const results = await Promise.allSettled([
      service.recover(code, 'new owner recovery password'),
      service.recover(code, 'new owner recovery password'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const success = results.find((result) => result.status === 'fulfilled');
    if (success?.status !== 'fulfilled') throw new Error('No successful recovery');
    expect((await service.authenticate(success.value, true)).principal).toMatchObject({
      id: 'dormant',
      role: 'owner',
    });
    expect(
      (await store.read()).principals.find((principal) => principal.id === 'dormant')?.pendingRole,
    ).toBeUndefined();
  });

  it('rejects stale operator recovery and never promotes an ordinary recovery code', async () => {
    const { service, store } = await fixture();
    await store.transact((state) => {
      state.principals.push({
        id: 'dormant',
        name: 'Dormant',
        role: 'member',
        pendingRole: 'owner',
        passwordHash: null,
        epoch: 0,
        createdAt: Date.now(),
      });
    });
    const stale = await service.issueOperatorToken('dormant');
    await store.transact((state) => {
      const principal = state.principals.find((entry) => entry.id === 'dormant')!;
      principal.epoch++;
      delete principal.pendingRole;
    });
    await expect(service.recover(stale, 'new owner recovery password')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await store.transact((state) => {
      state.principals.find((entry) => entry.id === 'dormant')!.pendingRole = 'owner';
      state.recoveryCodes.push({ id: tokenHash('ordinary-recovery-code'), principalId: 'dormant' });
    });
    const recovered = await service.recover('ordinary-recovery-code', 'member recovery password');
    expect((await service.authenticate(recovered)).principal).toMatchObject({
      role: 'member',
    });
    expect((await store.read()).principals.find((principal) => principal.id === 'dormant')?.pendingRole).toBe(
      'owner',
    );
  });

  it('does not add owner activation to a previously issued member recovery token', async () => {
    const { service, store } = await fixture();
    await store.transact((state) => {
      state.principals.push({
        id: 'member',
        name: 'Member',
        role: 'member',
        passwordHash: null,
        epoch: 0,
        createdAt: Date.now(),
      });
    });
    const code = await service.issueOperatorToken('member');
    await store.transact((state) => {
      state.principals.find((entry) => entry.id === 'member')!.pendingRole = 'owner';
    });
    const recovered = await service.recover(code, 'member recovery password');
    expect((await service.authenticate(recovered)).principal?.role).toBe('member');
  });

  it('keeps household entry separate from owner privileges', async () => {
    const { service, owner } = await fixture();
    await service.configureHousehold(owner, 'household password for guests');
    const guest = await service.enterHousehold('household password for guests');
    expect((await service.authenticate(guest)).principal).toBeNull();
    await expect(service.authenticate(guest, true)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.recoveryCodes(guest)).rejects.toMatchObject({ code: 'forbidden' });
    await service.configureHousehold(owner, 'replacement household password');
    await expect(service.authenticate(guest)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('revokes one device without signing out another device', async () => {
    const { service, owner } = await fixture();
    const phone = await service.login('Owner', 'correct horse battery staple', 'Phone');
    await service.revokeSession(owner, tokenHash(phone));
    await expect(service.authenticate(phone)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await service.authenticate(owner)).principal?.name).toBe('Owner');
  });

  it('allows one recovery redemption and revokes previous sessions', async () => {
    const { service, owner } = await fixture();
    const codes = await service.recoveryCodes(owner);
    const code = codes[0]!;
    const outcomes = await Promise.allSettled([
      service.recover(code, 'replacement owner password'),
      service.recover(code, 'replacement owner password'),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(service.authenticate(owner)).rejects.toMatchObject({ code: 'unauthorized' });
    const result = outcomes.find((item) => item.status === 'fulfilled');
    if (result?.status !== 'fulfilled') throw new Error('Recovery did not create a session');
    expect((await service.authenticate(result.value)).principal?.role).toBe('owner');
    await expect(service.recover(codes[1]!, 'yet another owner password')).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('prevents members from managing the owner or other members', async () => {
    const { service, owner } = await fixture();
    await service.addMember(owner, 'Member', 'a member password');
    const member = await service.login('Member', 'a member password');
    await expect(service.addMember(member, 'Other', 'another member password')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.revokeSession(member, tokenHash(owner))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await service.sessions(member)).toHaveLength(1);
  });
});
