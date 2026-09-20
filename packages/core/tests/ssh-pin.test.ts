import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { agentEnvironment, agentInvocation } from '../src/runtime/environment';
import { ProcessRunner } from '../src/runtime/process';
import { withPinnedSshConnection } from '../src/runtime/ssh-pin';
import { remoteHostKeySchema } from '../src/runtime/remote-journal';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function key() {
  const algorithm = Buffer.from('ssh-ed25519');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(algorithm.length);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(32);
  return {
    algorithm: 'ssh-ed25519' as const,
    key: Buffer.concat([prefix, algorithm, length, randomBytes(32)]).toString('base64'),
  };
}

it('enforces endpoint verification and account despite conflicting SSH configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-ssh-config-'));
  directories.push(directory);
  const config = join(directory, 'config');
  await writeFile(
    config,
    'Host *\n User wrong-user\n ControlMaster auto\n ControlPath /tmp/old-master\n RemoteCommand false\n UserKnownHostsFile /tmp/unrelated-hosts\n StrictHostKeyChecking no\n ForwardAgent yes\n PermitLocalCommand yes\n',
  );
  const hostKey = key();
  let pinPath = '';
  await withPinnedSshConnection(
    { connection: { host: 'example.invalid' }, remoteUser: 'owner', hostKey },
    async (connection) => {
      pinPath = connection.pinnedIdentity!.knownHostsFile;
      expect((await stat(pinPath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(pinPath))).mode & 0o777).toBe(0o700);
      expect((await readFile(pinPath, 'utf8')).trim().split(' ').slice(1)).toEqual([
        hostKey.algorithm,
        hostKey.key,
      ]);
      const invocation = agentInvocation('true', [], connection);
      const result = await new ProcessRunner().execute({
        ...invocation,
        args: ['-G', '-F', config, ...invocation.args],
        environment: agentEnvironment(process.env),
      });
      const settings = Object.fromEntries(
        result.stdout
          .trim()
          .split('\n')
          .map((line) => {
            const split = line.indexOf(' ');
            return [line.slice(0, split), line.slice(split + 1)];
          }),
      );
      expect(settings).toMatchObject({
        user: 'owner',
        controlmaster: 'false',
        stricthostkeychecking: 'true',
        forwardagent: 'no',
        permitlocalcommand: 'no',
        hostkeyalgorithms: 'ssh-ed25519',
        globalknownhostsfile: '/dev/null',
      });
      expect(settings.controlpath).toBeUndefined();
      expect(settings.remotecommand).toBeUndefined();
      expect(settings.userknownhostsfile).toBe(pinPath);
      expect(settings.hostkeyalias).toBe(connection.pinnedIdentity!.alias);
    },
  );
  await expect(access(pinPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes private verification files when transport work fails', async () => {
  let pinPath = '';
  await expect(
    withPinnedSshConnection(
      { connection: { host: 'owner@example.invalid' }, remoteUser: 'owner', hostKey: key() },
      async (connection) => {
        pinPath = connection.pinnedIdentity!.knownHostsFile;
        throw new Error('connection failed');
      },
    ),
  ).rejects.toThrow('connection failed');
  await expect(access(dirname(pinPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves execution failure when removing verification files also fails', async () => {
  const execution = new Error('connection failed');
  const cleanup = new Error('pin removal failed');
  const remove = vi.spyOn(filesystem, 'rm').mockRejectedValue(cleanup);
  syncBuiltinESMExports();
  try {
    await expect(
      withPinnedSshConnection(
        { connection: { host: 'example.invalid' }, remoteUser: 'owner', hostKey: key() },
        async (connection) => {
          directories.push(dirname(connection.pinnedIdentity!.knownHostsFile));
          throw execution;
        },
      ),
    ).rejects.toMatchObject({ errors: [execution, cleanup] });
  } finally {
    remove.mockRestore();
    syncBuiltinESMExports();
  }
});

it('rejects inconsistent explicit accounts and malformed public key encoding', async () => {
  await expect(
    withPinnedSshConnection(
      { connection: { host: 'another@example.invalid' }, remoteUser: 'owner', hostKey: key() },
      async () => true,
    ),
  ).rejects.toThrow('account changed');
  await expect(
    withPinnedSshConnection(
      {
        connection: { host: 'example.invalid' },
        remoteUser: 'owner',
        hostKey: { ...key(), key: Buffer.from('invalid-wire-format').toString('base64') },
      },
      async () => true,
    ),
  ).rejects.toThrow('host key encoding');
});

it.skipIf(!process.env.SIDEDOOR_TEST_SSH_HOST)(
  'accepts the pinned SSH server and rejects another key even when ordinary known-hosts trusts it',
  async () => {
    const host = process.env.SIDEDOOR_TEST_SSH_HOST!;
    const knownHostsFile = process.env.SIDEDOOR_TEST_SSH_KNOWN_HOSTS!;
    const fields = (await readFile(knownHostsFile, 'utf8')).trim().split(/\s+/);
    const hostKey = remoteHostKeySchema.parse({ algorithm: fields[1], key: fields[2] });
    const request = {
      connection: { host, knownHostsFile, identityFile: process.env.SIDEDOOR_TEST_SSH_KEY },
      remoteUser: 'root',
      hostKey,
    };
    const invoke = () =>
      withPinnedSshConnection(request, async (connection) =>
        new ProcessRunner().execute({
          ...agentInvocation('id', ['-un'], connection),
          environment: agentEnvironment(process.env),
          timeoutMs: 5000,
        }),
      );
    expect((await invoke()).stdout.trim()).toBe('root');
    if (process.env.SIDEDOOR_TEST_REMOTE_CONTAINER) {
      const rsa = await new ProcessRunner().execute({
        command: 'docker',
        args: ['exec', process.env.SIDEDOOR_TEST_REMOTE_CONTAINER, 'cat', '/etc/ssh/ssh_host_rsa_key.pub'],
        environment: agentEnvironment(process.env),
        timeoutMs: 5000,
      });
      const rsaFields = rsa.stdout.trim().split(/\s+/);
      request.hostKey = remoteHostKeySchema.parse({ algorithm: rsaFields[0], key: rsaFields[1] });
      expect((await invoke()).stdout.trim()).toBe('root');
    }
    request.hostKey = key();
    await expect(invoke()).rejects.toMatchObject({ code: 'exit_failed' });
  },
);
