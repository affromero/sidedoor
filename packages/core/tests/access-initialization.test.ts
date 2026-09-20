import { scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  accessStateSchema,
  importPasswordHash,
  initialAccessState,
  initializeAccess,
  type Principal,
} from '../src/access';
import { FileStateStore } from '../src/storage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sidedoor-initialization-'));
  directories.push(dir);
  const store = new FileStateStore({
    path: join(dir, 'access.json'),
    initial: initialAccessState,
    parse: (value) => accessStateSchema.parse(value),
  });
  return { store, service: new AccessService({ store }) };
}
function principal(
  id: string,
  name: string,
  password: string | null,
  role: Principal['role'] = 'member',
): Principal {
  const salt = '0123456789abcdef0123456789abcdef';
  return {
    id,
    name,
    role,
    passwordHash:
      password === null
        ? null
        : `scrypt:32768:${salt}:${scryptSync(password, salt, 64, {
            N: 32768,
            r: 8,
            p: 1,
            maxmem: 128 * 1024 * 1024,
          }).toString('hex')}`,
    epoch: 0,
    createdAt: 1,
  };
}

function unversionedPassword(password: string, cost: 16384 | 32768): string {
  const salt = 'fedcba9876543210fedcba9876543210';
  return `${salt}:${scryptSync(password, salt, 64, {
    N: cost,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  }).toString('hex')}`;
}

describe('access initialization', () => {
  it('preserves account IDs, admin roles and supplied passwords without granting passwordless owner access', async () => {
    const { store, service } = await fixture();
    const principals = [
      principal('existing-admin', 'admin', 'old-pass', 'owner'),
      principal('profile', 'family', null),
      principal('passwordless-admin', 'recovery', null, 'owner'),
    ];
    await initializeAccess(store, 'flight-finder-v1', { mode: 'household', principals });
    expect((await store.read()).principals).toEqual(principals);
    const token = await service.login('admin', 'old-pass');
    expect((await service.authenticate(token, true)).principal?.id).toBe('existing-admin');
    await expect(service.login('recovery', '')).rejects.toMatchObject({ code: 'unauthorized' });
    const recovery = await service.issueOperatorToken('passwordless-admin');
    const recovered = await service.recover(recovery, 'a new owner password');
    expect((await service.authenticate(recovered, true)).principal?.id).toBe('passwordless-admin');
  });
  it('runs once under concurrent initialization and never overwrites a changed password', async () => {
    const { store, service } = await fixture();
    const input = {
      mode: 'individual' as const,
      principals: [principal('owner', 'admin', 'old-pass', 'owner')],
    };
    expect(
      (
        await Promise.all([initializeAccess(store, 'v1', input), initializeAccess(store, 'v1', input)])
      ).sort(),
    ).toEqual([false, true]);
    const token = await service.login('admin', 'old-pass');
    await service.rotatePrincipalCredential(token, 'replacement password');
    expect(await initializeAccess(store, 'v1', input)).toBe(false);
    await expect(service.login('admin', 'old-pass')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(
      (await service.authenticate(await service.login('admin', 'replacement password'))).principal?.id,
    ).toBe('owner');
  });
  it('rewrites imported password records after their first successful use', async () => {
    const { store, service } = await fixture();
    const principals = [
      {
        ...principal('earlier', 'Earlier', null, 'owner'),
        passwordHash: importPasswordHash(unversionedPassword('earlier password', 16384)),
      },
      {
        ...principal('current', 'Current', null, 'owner'),
        passwordHash: importPasswordHash(unversionedPassword('current password', 32768)),
      },
    ];
    const householdPasswordHash = importPasswordHash(unversionedPassword('household password', 16384));
    await initializeAccess(store, 'imported-passwords', {
      mode: 'household',
      principals,
      householdPasswordHash,
    });
    const policy = await store.read();
    await service.enterHousehold('household password', 'Imported household', {
      householdEpoch: policy.householdEpoch,
      policyEpoch: policy.policyEpoch,
    });
    await service.login('Earlier', 'earlier password');
    await service.login('Current', 'current password');
    const state = await store.read();
    expect(state.householdPasswordHash).toMatch(/^scrypt:32768:/);
    expect(state.principals.map((entry) => entry.passwordHash)).toEqual([
      expect.stringMatching(/^scrypt:32768:/),
      expect.stringMatching(/^scrypt:32768:/),
    ]);
    expect(state.principals.map((entry) => entry.epoch)).toEqual([1, 1]);
  });
  it('rejects setup sentinels without partially creating accounts', async () => {
    const { store } = await fixture();
    const owner = { ...principal('owner', 'admin', null, 'owner'), passwordHash: 'self-hosted' };
    await expect(
      initializeAccess(store, 'v1', { mode: 'household', principals: [owner] }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.read()).principals).toEqual([]);
  });
  it('keeps names that differ only in case tied to their own credentials', async () => {
    const { store, service } = await fixture();
    await initializeAccess(store, 'v1', {
      mode: 'individual',
      principals: [principal('lower', 'alice', 'lower-pass'), principal('upper', 'Alice', 'upper-pass')],
    });
    expect((await service.authenticate(await service.login('Alice', 'upper-pass'))).principal?.id).toBe(
      'upper',
    );
    expect((await service.authenticate(await service.login('alice', 'lower-pass'))).principal?.id).toBe(
      'lower',
    );
    await expect(service.login('ALICE', 'upper-pass')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(service.login('alice', 'upper-pass')).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
