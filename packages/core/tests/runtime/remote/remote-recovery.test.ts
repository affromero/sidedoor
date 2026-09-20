import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStateStore } from '../../../src/storage';
import {
  RemoteOperationJournal,
  initialRemoteJournalState,
  remoteJournalStateSchema,
  remoteHostKeySchema,
} from '../../../src/runtime/remote/remote-journal';
import { RemoteOperationRecovery } from '../../../src/runtime/remote/remote-recovery';
import { ProcessRunner } from '../../../src/runtime/process/process';
import { agentEnvironment, agentInvocation } from '../../../src/runtime/process/environment';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function recoveryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-recovery-'));
  directories.push(directory);
  const connection = {
    host: process.env.SIDEDOOR_TEST_SSH_HOST!,
    identityFile: process.env.SIDEDOOR_TEST_SSH_KEY,
    knownHostsFile: process.env.SIDEDOOR_TEST_SSH_KNOWN_HOSTS,
  };
  const fields = (await readFile(connection.knownHostsFile!, 'utf8')).trim().split(/\s+/);
  const hostKey = remoteHostKeySchema.parse({ algorithm: fields[1], key: fields[2] });
  const stateStore = () =>
    new FileStateStore({
      path: join(directory, 'journal.json'),
      initial: initialRemoteJournalState,
      parse: (value) => remoteJournalStateSchema.parse(value),
    });
  const open = () => new RemoteOperationJournal({ store: stateStore() });
  const operationRoot = '/tmp/sidedoor-recovery-' + randomBytes(16).toString('hex');
  const journal = open();
  const operation = await journal.register({
    connection,
    hostKey,
    remoteUser: 'root',
    operationRoot,
    consumer: { id: 'fixture', generation: 1 },
    maximumLifetimeMs: 30_000,
  });
  const environment = agentEnvironment(process.env);
  const remote = (script: string, args: string[] = []) =>
    new ProcessRunner().execute({
      ...agentInvocation('python3', ['-c', script, ...args], connection),
      environment,
      timeoutMs: 5000,
    });
  const cleanup = () =>
    remote('import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)', [operationRoot]);
  return { open, stateStore, journal, operation, environment, remote, cleanup };
}

describe.skipIf(!process.env.SIDEDOOR_TEST_SSH_HOST)('durable recovery over pinned SSH', () => {
  it('finishes a retry without connecting when journal deletion committed but its response was lost', async () => {
    const fixture = await recoveryFixture();
    try {
      const store = fixture.stateStore();
      let loseResponse = true;
      const journal = new RemoteOperationJournal({
        store: {
          read: () => store.read(),
          async transact(operation) {
            const result = await store.transact(operation);
            if (loseResponse) {
              loseResponse = false;
              throw new Error('journal response lost');
            }
            return result;
          },
        },
      });
      await expect(
        new RemoteOperationRecovery(journal).recover(fixture.operation, { environment: fixture.environment }),
      ).rejects.toMatchObject({ code: 'transport_failed' });
      expect(await fixture.open().pending()).toEqual([]);
      await expect(
        new RemoteOperationRecovery(fixture.open()).recover(fixture.operation, {
          environment: fixture.environment,
          signal: AbortSignal.abort(),
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
  it('removes interrupted upload files and clears the durable record only after confirmation', async () => {
    const fixture = await recoveryFixture();
    try {
      const { operation } = fixture;
      await fixture.journal.connecting(operation);
      await fixture.remote(
        "import os,sys; path=os.path.join(sys.argv[1],sys.argv[2],'data'); os.makedirs(path,mode=0o700); os.chmod(sys.argv[1],0o700); os.chmod(os.path.dirname(path),0o700); open(os.path.join(path,'image.png'),'wb').write(b'partial')",
        [operation.operationRoot, operation.operationId],
      );
      await new RemoteOperationRecovery(fixture.open()).recover(operation, {
        environment: fixture.environment,
      });
      expect(await fixture.open().pending()).toEqual([]);
      const check = await fixture.remote(
        "import os,sys; path=os.path.join(sys.argv[1],sys.argv[2]); print(os.path.exists(os.path.join(path,'data')),os.path.exists(os.path.join(path,'cancelled')))",
        [operation.operationRoot, operation.operationId],
      );
      expect(check.stdout.trim()).toBe('False True');
      await new RemoteOperationRecovery(fixture.open()).recover(operation, {
        environment: fixture.environment,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('retains uncertainty across restart when a supervisor left execution unconfirmed', async () => {
    const fixture = await recoveryFixture();
    try {
      const { operation } = fixture;
      await fixture.journal.connecting(operation);
      await fixture.remote(
        "import os,sys; path=os.path.join(sys.argv[1],sys.argv[2]); os.makedirs(path,mode=0o700); os.chmod(sys.argv[1],0o700); os.mkdir(os.path.join(path,'data'),0o700); open(os.path.join(path,'execution-pending'),'wb').close()",
        [operation.operationRoot, operation.operationId],
      );
      await expect(
        new RemoteOperationRecovery(fixture.journal).recover(operation, { environment: fixture.environment }),
      ).rejects.toMatchObject({ operationId: operation.operationId, code: 'cleanup_failed' });
      expect(await fixture.open().pending()).toMatchObject([
        { status: 'uncertain', reason: 'cleanup_failed' },
      ]);
      const check = await fixture.remote(
        "import os,sys; print(os.path.isdir(os.path.join(sys.argv[1],sys.argv[2],'data')))",
        [operation.operationRoot, operation.operationId],
      );
      expect(check.stdout.trim()).toBe('True');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects changed recovery bindings before creating remote state', async () => {
    const fixture = await recoveryFixture();
    try {
      await expect(
        new RemoteOperationRecovery(fixture.journal).recover(
          { ...fixture.operation, remoteUser: 'someone-else' },
          { environment: fixture.environment },
        ),
      ).rejects.toThrow('registration changed');
      const check = await fixture.remote('import os,sys; print(os.path.exists(sys.argv[1]))', [
        fixture.operation.operationRoot,
      ]);
      expect(check.stdout.trim()).toBe('False');
      expect(await fixture.open().pending()).toEqual([fixture.operation]);
    } finally {
      await fixture.cleanup();
    }
  });
});
