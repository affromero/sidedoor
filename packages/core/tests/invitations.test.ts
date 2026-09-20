import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessService, InvitationService, accessStateSchema, initialAccessState } from '../src/access';
import { FileStateStore } from '../src/storage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(mode: 'individual' | 'household' = 'household') {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-invite-'));
  directories.push(directory);
  const access = new AccessService({
    store: new FileStateStore({
      path: join(directory, 'access.json'),
      initial: initialAccessState,
      parse: (value) => accessStateSchema.parse(value),
    }),
  });
  const owner = await access.claimOwner(
    await access.issueOperatorToken(),
    'Owner',
    'owner password for testing',
    mode,
  );
  return { access, owner, invites: new InvitationService(access) };
}
describe('instance invitations', () => {
  it('rejects account enrollment on a household invitation without consuming it', async () => {
    const { access, invites, owner } = await fixture();
    const code = await invites.issue(owner);
    await expect(
      invites.redeem(code, { name: 'Member', password: 'member password for testing' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect((await access.authenticate(await invites.redeem(code))).principal).toBeNull();
    expect((await access.store.read()).principals.map((principal) => principal.name)).toEqual(['Owner']);
  });

  it('admits a household browser without granting owner identity', async () => {
    const { access, invites, owner } = await fixture();
    const code = await invites.issue(owner);
    const results = await Promise.allSettled([invites.redeem(code), invites.redeem(code)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const success = results.find((result) => result.status === 'fulfilled');
    if (success?.status !== 'fulfilled') throw new Error('Invitation failed');
    expect((await access.authenticate(success.value)).principal).toBeNull();
    await expect(invites.issue(success.value)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('preserves explicitly reusable household invitations until revoked', async () => {
    const { access, invites, owner } = await fixture();
    const code = await invites.issue(owner, { uses: null });
    expect((await access.authenticate(await invites.redeem(code))).principal).toBeNull();
    expect((await access.authenticate(await invites.redeem(code))).principal).toBeNull();
    const saved = (await invites.list(owner))[0]!;
    await invites.revoke(owner, saved.id);
    await expect(invites.redeem(code)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('creates a new member without taking over an existing identity', async () => {
    const { access, invites, owner } = await fixture('individual');
    const code = await invites.issue(owner);
    await expect(
      invites.redeem(code, { name: 'owner', password: 'attacker supplied password' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const member = await invites.redeem(code, { name: 'Member', password: 'member password for testing' });
    expect((await access.authenticate(member)).principal).toMatchObject({ name: 'Member', role: 'member' });
    await expect(
      invites.redeem(code, { name: 'Another', password: 'another password for testing' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('does not revive an old invitation when the access mode changes back', async () => {
    const { access, invites, owner } = await fixture('individual');
    const code = await invites.issue(owner);
    await access.setMode(owner, 'household');
    await access.setMode(owner, 'individual');
    await expect(
      invites.redeem(code, { name: 'Member', password: 'member password for testing' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('invalidates household invitations after the admission password changes', async () => {
    const { access, invites, owner } = await fixture();
    const code = await invites.issue(owner);
    await access.configureHousehold(owner, 'a new household password');
    await expect(invites.redeem(code)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
