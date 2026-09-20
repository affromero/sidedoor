import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileStateStore } from '../src/storage';
import {
  RemoteOperationJournal,
  remoteJournalStateSchema,
  initialRemoteJournalState,
} from '../src/runtime/remote-journal';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const registration = {
  remoteUser: 'owner',
  operationRoot: '/home/owner/.local/state/sidedoor/operations',
  connection: { host: 'owner@remote', identityFile: '/private/key', knownHostsFile: '/private/hosts' },
  hostKey: { algorithm: 'ssh-ed25519' as const, key: Buffer.from('test-only-host-key').toString('base64') },
  consumer: { id: 'profile-opaque-id', generation: 3 },
  maximumLifetimeMs: 1000,
};
async function fixture(maxPending = 10) {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-remote-journal-'));
  directories.push(directory);
  const path = join(directory, 'operations.json');
  let now = 10_000;
  const open = () =>
    new RemoteOperationJournal({
      store: new FileStateStore({
        path,
        initial: initialRemoteJournalState,
        parse: (value) => remoteJournalStateSchema.parse(value),
      }),
      now: () => now,
      maxPending,
    });
  return {
    open,
    path,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('retains captured recovery identity across restart and selects timeout cancellation by deadline', async () => {
  const store = await fixture();
  const operation = await store.open().register(registration);
  expect(await store.open().pending()).toEqual([operation]);
  expect(await store.open().dueForCancellation()).toEqual([]);
  store.advance(1000);
  expect(await store.open().dueForCancellation()).toEqual([operation]);
  const persisted = JSON.parse(await readFile(store.path, 'utf8'));
  expect(persisted.operations[0]).toMatchObject({
    consumer: { generation: 3 },
    hostKey: registration.hostKey,
  });
});

it('keeps weaker cleanup and wrong-host acknowledgements pending', async () => {
  const store = await fixture();
  const journal = store.open();
  const operation = await journal.register(registration);
  await expect(
    journal.acknowledge(operation, {
      remoteUser: registration.remoteUser,
      operationRoot: registration.operationRoot,
      operationId: operation.operationId,
      hostKey: { ...registration.hostKey, key: Buffer.from('different-host-key').toString('base64') },
      containment: 'descendants',
    }),
  ).rejects.toThrow('identity mismatch');
  expect(
    await journal.acknowledge(operation, {
      remoteUser: registration.remoteUser,
      operationRoot: registration.operationRoot,
      operationId: operation.operationId,
      hostKey: registration.hostKey,
      containment: 'process-group',
    }),
  ).toBe(false);
  expect(await store.open().pending()).toMatchObject([
    { status: 'uncertain', reason: 'insufficient_containment' },
  ]);
  expect(await journal.dueForCancellation()).toHaveLength(1);
});

it('removes confirmed operations idempotently across concurrent journal instances', async () => {
  const store = await fixture();
  const operation = await store.open().register(registration);
  const receipt = {
    remoteUser: registration.remoteUser,
    operationRoot: registration.operationRoot,
    operationId: operation.operationId,
    hostKey: registration.hostKey,
    containment: 'descendants' as const,
  };
  expect(
    await Promise.all([
      store.open().acknowledge(operation, receipt),
      store.open().acknowledge(operation, receipt),
    ]),
  ).toEqual([true, true]);
  expect(await store.open().pending()).toEqual([]);
});

it('rejects a stale registration token or changed consumer before deleting recovery metadata', async () => {
  const store = await fixture();
  const journal = store.open();
  const operation = await journal.register(registration);
  const receipt = {
    remoteUser: registration.remoteUser,
    operationRoot: registration.operationRoot,
    operationId: operation.operationId,
    hostKey: registration.hostKey,
    containment: 'descendants' as const,
  };
  await expect(
    journal.acknowledge({ ...operation, registrationToken: '0'.repeat(32) }, receipt),
  ).rejects.toThrow('registration changed');
  await expect(
    journal.acknowledge({ ...operation, consumer: { ...operation.consumer, generation: 4 } }, receipt),
  ).rejects.toThrow('registration changed');
  expect(await journal.pending()).toEqual([operation]);
  await expect(journal.acknowledge(operation, { ...receipt, remoteUser: 'another-user' })).rejects.toThrow(
    'identity mismatch',
  );
  await expect(
    journal.acknowledge(operation, { ...receipt, operationRoot: '/another/home/operations' }),
  ).rejects.toThrow('identity mismatch');
});

it('rejects new work at capacity without discarding unresolved operations', async () => {
  const store = await fixture(1);
  const journal = store.open();
  const operation = await journal.register(registration);
  store.advance(100_000);
  await journal.uncertain(operation, 'transport_failed');
  await expect(journal.register(registration)).rejects.toThrow('capacity');
  expect(await journal.pending()).toMatchObject([
    { operationId: operation.operationId, status: 'uncertain' },
  ]);
});

it('discards only operations whose persisted state proves no connection was admitted', async () => {
  const store = await fixture();
  const journal = store.open();
  const unstarted = await journal.register(registration);
  await journal.discardUnstarted(unstarted);
  expect(await journal.pending()).toEqual([]);
  const operation = await journal.register(registration);
  await journal.connecting(operation);
  expect(await store.open().pending()).toMatchObject([{ status: 'active' }]);
  await expect(journal.discardUnstarted(operation)).rejects.toThrow('may have connected');
  await expect(journal.connecting(operation)).rejects.toThrow('already admitted');
  expect(await journal.pending()).toHaveLength(1);
});

it('prevents late or uncertain work from entering execution', async () => {
  const store = await fixture();
  const journal = store.open();
  const expired = await journal.register(registration);
  store.advance(1000);
  await expect(journal.connecting(expired)).rejects.toThrow('deadline expired');
  const uncertain = await journal.register(registration);
  await journal.uncertain(uncertain, 'transport_failed');
  await expect(journal.connecting(uncertain)).rejects.toThrow('already admitted');
  await expect(journal.discardUnstarted(uncertain)).rejects.toThrow('may have connected');
});
