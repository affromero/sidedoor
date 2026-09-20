import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
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
import { RemoteSessionRunner, type RemoteExecutionRequest } from '../../../src/runtime/remote/remote-runner';
import { ProcessRunner } from '../../../src/runtime/process/process';
import { agentEnvironment, agentInvocation } from '../../../src/runtime/process/environment';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it.skipIf(process.platform !== 'darwin')(
  'retains uncertainty when only process-group containment is available',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidedoor-group-scope-'));
    directories.push(directory);
    await writeFile(join(directory, 'ssh'), '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n', {
      mode: 0o700,
    });
    const algorithm = Buffer.from('ssh-ed25519');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(algorithm.length);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(32);
    const journal = new RemoteOperationJournal({
      store: new FileStateStore({
        path: join(directory, 'journal.json'),
        initial: initialRemoteJournalState,
        parse: (value) => remoteJournalStateSchema.parse(value),
      }),
    });
    const runner = new RemoteSessionRunner(journal);
    let output = '';
    const run = async () => {
      for await (const chunk of runner.stream({
        connection: { host: 'fixture.invalid' },
        hostKey: {
          algorithm: 'ssh-ed25519',
          key: Buffer.concat([prefix, algorithm, size, randomBytes(32)]).toString('base64'),
        },
        remoteUser: userInfo().username,
        operationRoot: join(directory, 'operations'),
        consumer: { id: 'fixture', generation: 1 },
        command: process.execPath,
        args: ['-e', "process.stdout.write('result')"],
        files: [],
        remoteEnvironmentKeys: ['PATH', 'HOME'],
        transportEnvironment: { ...agentEnvironment(process.env), PATH: directory + ':' + process.env.PATH },
        timeoutMs: 10_000,
      })) {
        if (chunk.channel === 'stdout') output += chunk.text;
      }
    };
    await expect(run()).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ code: 'insufficient_containment' })]),
    });
    expect(output).toBe('result');
    expect(await journal.pending()).toMatchObject([
      { status: 'uncertain', reason: 'insufficient_containment' },
    ]);
  },
);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-runner-'));
  directories.push(directory);
  const connection = {
    host: process.env.SIDEDOOR_TEST_SSH_HOST!,
    identityFile: process.env.SIDEDOOR_TEST_SSH_KEY,
    knownHostsFile: process.env.SIDEDOOR_TEST_SSH_KNOWN_HOSTS,
  };
  const fields = (await readFile(connection.knownHostsFile!, 'utf8')).trim().split(/\s+/);
  const journal = new RemoteOperationJournal({
    store: new FileStateStore({
      path: join(directory, 'journal.json'),
      initial: initialRemoteJournalState,
      parse: (value) => remoteJournalStateSchema.parse(value),
    }),
  });
  const request: RemoteExecutionRequest = {
    connection,
    hostKey: remoteHostKeySchema.parse({ algorithm: fields[1], key: fields[2] }),
    remoteUser: 'root',
    operationRoot: '/tmp/sidedoor-runner-' + randomBytes(16).toString('hex'),
    consumer: { id: 'fixture', generation: 1 },
    command: 'python3',
    args: [],
    files: [],
    remoteEnvironmentKeys: ['PATH', 'HOME'],
    transportEnvironment: agentEnvironment(process.env),
    timeoutMs: 10_000,
  };
  const runner = new RemoteSessionRunner(journal);
  const remote = (script: string, args: string[] = []) =>
    new ProcessRunner().execute({
      ...agentInvocation('python3', ['-c', script, ...args], connection),
      environment: request.transportEnvironment,
      timeoutMs: 5000,
    });
  const cleanup = () =>
    remote('import shutil,sys;shutil.rmtree(sys.argv[1],ignore_errors=True)', [request.operationRoot]);
  return { directory, journal, request, runner, remote, cleanup };
}

describe.skipIf(!process.env.SIDEDOOR_TEST_SSH_HOST)('shared remote execution lifecycle', () => {
  it('uploads files, preserves stdin and clears its operation after verified cleanup', async () => {
    const context = await fixture();
    try {
      const file = join(context.directory, 'image.png');
      await writeFile(file, 'image content');
      let output = '';
      for await (const chunk of context.runner.stream({
        ...context.request,
        files: [file],
        input: 'question',
        args: ['-c', "import sys; print(open(sys.argv[1]).read()+':'+sys.stdin.read())", { file: 0 }],
      })) {
        if (chunk.channel === 'stdout') output += chunk.text;
      }
      expect(output.trim()).toBe('image content:question');
      expect(await context.journal.pending()).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });
  it('preserves failed execution after successful remote cleanup', async () => {
    const context = await fixture();
    try {
      const run = async () => {
        for await (const chunk of context.runner.stream({
          ...context.request,
          args: ['-c', "import sys; print('partial'); sys.exit(7)"],
        })) {
          if (chunk.channel === 'stdout') expect(chunk.text).toContain('partial');
        }
      };
      await expect(run()).rejects.toMatchObject({ code: 'exit_failed', exitCode: 7 });
      expect(await context.journal.pending()).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });
  it.each(['return', 'throw'] as const)(
    'interrupts a pending read with %s and waits for cleanup',
    async (method) => {
      const context = await fixture();
      try {
        const stream = context.runner.stream({
          ...context.request,
          args: ['-c', 'import os,time; print(os.getpid(),flush=True); time.sleep(60)'],
        });
        let output = '';
        while (!output.includes('\n')) {
          const chunk = await stream.next();
          if (chunk.done) throw new Error('Remote process did not start');
          if (chunk.value.channel === 'stdout') output += chunk.value.text;
        }
        const pid = Number(output.trim());
        expect(pid).toBeGreaterThan(1);
        const pending = stream.next().catch((error) => error as unknown);
        if (method === 'return') await stream.return();
        else {
          const original = new Error('consumer stopped');
          await expect(stream.throw(original)).rejects.toBe(original);
        }
        await pending;
        expect(await context.journal.pending()).toEqual([]);
        const probe = await context.remote('import os,sys; print(os.path.exists("/proc/"+sys.argv[1]))', [
          String(pid),
        ]);
        expect(probe.stdout.trim()).toBe('False');
      } finally {
        await context.cleanup();
      }
    },
  );
  it('does not register unused streams and discards preparation failures before connection', async () => {
    const context = await fixture();
    try {
      const unused = context.runner.stream(context.request);
      await unused.return();
      expect((await unused.next()).done).toBe(true);
      await unused.return();
      expect(await context.journal.pending()).toEqual([]);
      const stream = context.runner.stream({
        ...context.request,
        files: [join(context.directory, 'missing.png')],
      });
      await expect(stream.next()).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await context.journal.pending()).toEqual([]);
      const probe = await context.remote('import os,sys; print(os.path.exists(sys.argv[1]))', [
        context.request.operationRoot,
      ]);
      expect(probe.stdout.trim()).toBe('False');
    } finally {
      await context.cleanup();
    }
  });
  it('enforces the execution deadline and completes independent recovery', async () => {
    const context = await fixture();
    try {
      let output = '';
      const run = async () => {
        for await (const chunk of context.runner.stream({
          ...context.request,
          timeoutMs: 1500,
          args: ['-c', "import time; print('ready',flush=True); time.sleep(60)"],
        })) {
          if (chunk.channel === 'stdout') output += chunk.text;
        }
      };
      await expect(run()).rejects.toThrow(/timed out/);
      expect(output).toContain('ready');
      expect(await context.journal.pending()).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });
});
