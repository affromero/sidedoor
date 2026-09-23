import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  AccessService,
  HouseholdProfileService,
  PrincipalManagement,
  accessStateSchema,
  initialAccessState,
} from '../../src/access';
import { FileStateStore } from '../../src/storage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(mode: 'household' | 'individual' = 'individual') {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-principals-'));
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
  if (mode === 'household') {
    const ownerId = (await access.store.read()).principals.find(
      (principal) => principal.role === 'owner',
    )!.id;
    await new HouseholdProfileService(access).select(owner, ownerId);
  }
  return { access, owner, management: new PrincipalManagement(access) };
}

it('preserves passwordless household profiles while requiring credentials for ownership and individual accounts', async () => {
  const { access, owner, management } = await fixture('household');
  const id = await management.mutate(owner, { kind: 'create', name: 'Member' });
  await expect(management.mutate(owner, { kind: 'update', id, role: 'owner' })).rejects.toMatchObject({
    code: 'forbidden',
  });
  await expect(access.setRole(owner, id, 'owner')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(management.mutate(owner, { kind: 'create', name: 'member' })).rejects.toMatchObject({
    code: 'conflict',
  });
  await expect(
    management.mutate(owner, {
      kind: 'update',
      id,
      role: 'owner',
      password: 'member password for testing',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect((await access.store.read()).principals.find((principal) => principal.id === id)?.role).toBe(
    'member',
  );
  await access.setMode(owner, 'individual');
  const individualOwner = await access.login('Owner', 'owner password for testing');
  await expect(
    management.mutate(individualOwner, { kind: 'create', name: 'Passwordless' }),
  ).rejects.toMatchObject({
    code: 'invalid',
  });
});

it('invalidates sessions and recovery after password resets while empty form passwords leave credentials intact', async () => {
  const { access, owner, management } = await fixture();
  const id = await management.mutate(owner, {
    kind: 'create',
    name: 'Member',
    password: 'member password for testing',
  });
  const member = await access.login('Member', 'member password for testing');
  const recovery = await access.recoveryCodes(member);
  await management.mutate(owner, { kind: 'update', id, password: '' });
  expect((await access.authenticate(member)).principal?.id).toBe(id);
  await expect(management.mutate(owner, { kind: 'update', id, password: 'short' })).rejects.toBeInstanceOf(
    Error,
  );
  expect((await access.authenticate(member)).principal?.id).toBe(id);
  await management.mutate(owner, { kind: 'update', id, password: 'replacement password for member' });
  await expect(access.authenticate(member)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(access.recover(recovery[0]!, 'recovery password for member')).rejects.toMatchObject({
    code: 'unauthorized',
  });
  expect(
    (await access.authenticate(await access.login('Member', 'replacement password for member'))).principal
      ?.id,
  ).toBe(id);
});

it('revalidates concurrent owner deletions so one surviving owner retains access', async () => {
  const { access, owner, management } = await fixture();
  const firstId = (await access.authenticate(owner)).principal!.id;
  const secondId = await management.mutate(owner, {
    kind: 'create',
    name: 'Second',
    role: 'owner',
    password: 'second owner password',
  });
  const second = await access.login('Second', 'second owner password');
  await expect(management.mutate(owner, { kind: 'delete', id: firstId })).rejects.toMatchObject({
    code: 'forbidden',
  });
  const deleteSecond = await management.prepare({ kind: 'delete', id: secondId });
  const deleteFirst = await management.prepare({ kind: 'delete', id: firstId });
  const outcomes = await Promise.allSettled([
    access.store.transact((state) => deleteSecond.apply(state, owner)),
    access.store.transact((state) => deleteFirst.apply(state, second)),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  const state = await access.store.read();
  expect(state.principals.filter((principal) => principal.role === 'owner')).toHaveLength(1);
  const survivingToken = state.principals[0]!.id === firstId ? owner : second;
  expect((await access.authenticate(survivingToken)).principal?.role).toBe('owner');
});
