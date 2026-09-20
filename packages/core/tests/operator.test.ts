import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  AccessService,
  DeviceService,
  accessStateSchema,
  executeAccessCommand,
  initialAccessState,
  removePrincipalFromState,
} from '../src/access';
import { FileStateStore } from '../src/storage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-operator-'));
  directories.push(directory);
  const file = join(directory, 'access.json');
  const store = new FileStateStore({
    path: file,
    initial: initialAccessState,
    parse: (value) => accessStateSchema.parse(value),
  });
  return { file, store, access: new AccessService({ store }) };
}

it('rejects malformed or unsupported local commands before reading stored credentials', async () => {
  const { file, access } = await fixture();
  await writeFile(file, 'corrupt credential store');
  for (const args of [
    [],
    ['recover'],
    ['claim', 'extra'],
    ['list', 'extra'],
    ['recover', 'id', 'extra'],
    ['unknown'],
  ])
    await expect(executeAccessCommand(access, args)).rejects.toThrow('Use access list');
  await expect(executeAccessCommand(access, ['initialize'])).rejects.toThrow(
    'does not provide a local access initialization',
  );
  expect(await readFile(file, 'utf8')).toBe('corrupt credential store');
});

it('protects the last owner inside the shared removal primitive', async () => {
  const { access, store } = await fixture();
  const session = await access.claimOwner(
    await access.issueOperatorToken(),
    'Owner',
    'operator test owner password',
    'household',
  );
  const id = (await access.authenticate(session)).principal!.id;
  await expect(store.transact((state) => removePrincipalFromState(state, id))).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await access.authenticate(session, true)).principal?.id).toBe(id);
});

it('issues a usable local claim and lists identities without credentials', async () => {
  const { access } = await fixture();
  const result = JSON.parse(await executeAccessCommand(access, ['claim'])) as { code: string };
  const owner = await access.claimOwner(result.code, 'Owner', 'operator test owner password', 'household');
  const listing = await executeAccessCommand(access, ['list']);
  expect(JSON.parse(listing)).toMatchObject({ principals: [{ name: 'Owner', role: 'owner' }] });
  expect(listing).not.toContain(result.code);
  expect(listing).not.toContain(owner);
  expect(listing).not.toContain('passwordHash');
  await expect(executeAccessCommand(access, ['recover', 'Owner'])).rejects.toMatchObject({ code: 'invalid' });
});

it('keeps independent operator recovery codes usable for each account', async () => {
  const { access, store } = await fixture();
  await store.transact((state) => {
    state.principals.push(
      { id: 'first', name: 'First', role: 'owner', passwordHash: null, epoch: 0, createdAt: 1 },
      { id: 'second', name: 'Second', role: 'owner', passwordHash: null, epoch: 0, createdAt: 1 },
    );
  });
  const first = await access.issueOperatorToken('first');
  const second = await access.issueOperatorToken('second');
  expect(
    (await access.authenticate(await access.recover(first, 'first recovered password'))).principal?.id,
  ).toBe('first');
  expect(
    (await access.authenticate(await access.recover(second, 'second recovered password'))).principal?.id,
  ).toBe('second');
});

it('issues a scoped device credential only through an application-provided local operator service', async () => {
  const { access } = await fixture();
  const session = await access.claimOwner(
    await access.issueOperatorToken(),
    'Owner',
    'operator test owner password',
    'household',
  );
  const principalId = (await access.authenticate(session)).principal!.id;
  const devices = new DeviceService({ access, scopesFor: () => ['api'], tokenPrefix: 'test_' });
  await expect(executeAccessCommand(access, ['device', principalId])).rejects.toThrow(
    'does not provide local device credentials',
  );
  const output = JSON.parse(
    await executeAccessCommand(access, ['device', principalId, 'Backup'], {
      devices: { service: devices, scopes: ['api'] },
    }),
  ) as { token: string; expiresAt: number };
  expect(output.token).toMatch(/^test_/);
  expect(output.expiresAt).toBeGreaterThan(Date.now());
  expect(await devices.authenticate(output.token, ['api'])).toMatchObject({
    principal: { id: principalId, role: 'owner' },
    name: 'Backup',
    scopes: ['api'],
  });
});

it('reports callback completion only after local initialization succeeds', async () => {
  const { access, store } = await fixture();
  expect(
    JSON.parse(
      await executeAccessCommand(access, ['initialize'], {
        initialize: async () => {
          await store.transact((state) => {
            state.initializations.push('operator-test');
          });
          return { warnings: ['Retained orphan directory'] };
        },
      }),
    ),
  ).toEqual({ operation: 'initialize', warnings: ['Retained orphan directory'] });
  expect((await store.read()).initializations).toContain('operator-test');
});
