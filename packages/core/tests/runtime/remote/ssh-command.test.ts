import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { agentEnvironment, agentInvocation, shellQuote } from '../../../src/runtime/process/environment';
import { ProcessRunner } from '../../../src/runtime/process/process';
import { acquireSshTrustCommand } from '../../../src/runtime/ssh/ssh-command';

it('rejects malformed trust commands before creating a connection resource', async () => {
  for (const originalCommand of ['   ', '"unfinished', 'invalid\0command'])
    await expect(acquireSshTrustCommand({ originalCommand })).rejects.toThrow('Invalid SSH trust command');
});

it.skipIf(!process.env.SIDEDOOR_TEST_SSH_HOST)(
  'observes the authenticated key and vetoes a mismatch despite existing host trust',
  async () => {
    const connection = {
      host: process.env.SIDEDOOR_TEST_SSH_HOST!,
      identityFile: process.env.SIDEDOOR_TEST_SSH_KEY!,
      knownHostsFile: process.env.SIDEDOOR_TEST_SSH_KNOWN_HOSTS!,
    };
    const fields = (await readFile(connection.knownHostsFile, 'utf8')).trim().split(/\s+/);
    const expected = { algorithm: fields[1]!, key: fields[2]! };
    for (const mismatch of [false, true]) {
      const hook = await acquireSshTrustCommand({
        originalCommand: 'none',
        expected: mismatch ? { ...expected, key: 'different' } : expected,
      });
      try {
        const invocation = agentInvocation('id', ['-un'], connection);
        const execution = new ProcessRunner().execute({
          ...invocation,
          args: ['-F', '/dev/null', '-o', `KnownHostsCommand=${hook.command}`, ...invocation.args],
          environment: agentEnvironment(process.env),
          timeoutMs: 5000,
        });
        if (mismatch) await expect(execution).rejects.toMatchObject({ code: 'exit_failed' });
        else {
          expect((await execution).stdout.trim()).toBe('root');
          expect(await hook.observedKey()).toEqual(expected);
        }
      } finally {
        await hook.release();
      }
    }
  },
);

it.skipIf(!process.env.SIDEDOOR_TEST_SSH_HOST)(
  'preserves original trust command failure even when a known-host file trusts the server',
  async () => {
    const hook = await acquireSshTrustCommand({ originalCommand: '/bin/false' });
    try {
      const invocation = agentInvocation('id', ['-un'], {
        host: process.env.SIDEDOOR_TEST_SSH_HOST!,
        identityFile: process.env.SIDEDOOR_TEST_SSH_KEY!,
        knownHostsFile: process.env.SIDEDOOR_TEST_SSH_KNOWN_HOSTS!,
      });
      await expect(
        new ProcessRunner().execute({
          ...invocation,
          args: ['-F', '/dev/null', '-o', `KnownHostsCommand=${hook.command}`, ...invocation.args],
          environment: agentEnvironment(process.env),
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ code: 'exit_failed' });
    } finally {
      await hook.release();
    }
  },
);

it.skipIf(!process.env.SIDEDOOR_TEST_SSH_HOST)(
  'preserves command-provided trust, literal executable tokens, and OpenSSH argument expansion',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidedoor-original-trust-'));
    const executable = join(directory, 'trust %I${HOME}');
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" >&2\nexec cat ${shellQuote(process.env.SIDEDOOR_TEST_SSH_KNOWN_HOSTS!)}\n`,
      { mode: 0o700 },
    );
    const hook = await acquireSshTrustCommand({
      originalCommand: `"${executable}" "%H" "a b" "literal %%t"`,
    });
    try {
      const invocation = agentInvocation('id', ['-un'], {
        host: process.env.SIDEDOOR_TEST_SSH_HOST!,
        identityFile: process.env.SIDEDOOR_TEST_SSH_KEY!,
        knownHostsFile: '/dev/null',
      });
      const result = await new ProcessRunner().execute({
        ...invocation,
        args: [
          '-F',
          '/dev/null',
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          `KnownHostsCommand=${hook.command}`,
          ...invocation.args,
        ],
        environment: agentEnvironment(process.env),
        timeoutMs: 5000,
      });
      expect(result.stdout.trim()).toBe('root');
      expect(result.stderr).toContain('a b\nliteral %t\n');
      expect((await hook.observedKey()).algorithm).toBe('ssh-ed25519');
    } finally {
      await hook.release();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
