import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { shellQuote } from './environment';

/** OpenSSH expands command arguments but leaves the executable literal. */
function separateExecutable(command: string): { executable: string; tail: string } {
  if (command.length > 65536 || /[\0\r\n]/.test(command)) throw new Error('Invalid SSH trust command');
  let index = 0;
  while (command[index] === ' ' || command[index] === '\t') index++;
  let executable = '';
  let quote = '';
  for (; index < command.length; index++) {
    const character = command[index]!;
    const next = command[index + 1];
    if (character === '\\') {
      if (next === "'" || next === '"' || next === '\\' || (!quote && next === ' ')) {
        executable += next;
        index++;
      } else executable += character;
    } else if (!quote && (character === ' ' || character === '\t')) break;
    else if (!quote && (character === '"' || character === "'")) quote = character;
    else if (quote === character) quote = '';
    else executable += character;
  }
  if (quote || !executable) throw new Error('Invalid SSH trust command');
  return { executable, tail: command.slice(index) };
}

export interface OfferedSshKey {
  algorithm: string;
  key: string;
}

const offeredKeySchema = z
  .object({
    algorithm: z.string().regex(/^[a-zA-Z0-9@._+-]{1,128}$/),
    key: z.string().regex(/^[A-Za-z0-9+/]{16,65536}={0,2}$/),
  })
  .strict()
  .refine(({ algorithm, key }) => {
    const bytes = Buffer.from(key, 'base64');
    return (
      bytes.toString('base64') === key &&
      bytes.length >= 4 &&
      bytes.readUInt32BE(0) === Buffer.byteLength(algorithm) &&
      bytes.subarray(4, 4 + Buffer.byteLength(algorithm)).toString() === algorithm
    );
  }, 'Invalid SSH key encoding');

// This helper supplies no known-host entries. Only the original command can supply trust.
const captureProgram = String.raw`
const fs = require('node:fs');
const [capture, configuration, reason, algorithm, key] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(configuration, 'utf8'));
if (!['ORDER', 'HOSTNAME', 'ADDRESS'].includes(reason)) process.exit(1);
if (reason === 'ORDER') {
  if (algorithm !== 'NONE' || key !== 'NONE') process.exit(1);
  process.exit(0);
}
if (!/^[a-zA-Z0-9@._+-]{1,128}$/.test(algorithm) ||
    !/^[A-Za-z0-9+/]{16,65536}={0,2}$/.test(key)) process.exit(1);
const bytes = Buffer.from(key, 'base64');
if (bytes.toString('base64') !== key || bytes.length < 4 ||
    bytes.readUInt32BE(0) !== Buffer.byteLength(algorithm) ||
    bytes.subarray(4, 4 + Buffer.byteLength(algorithm)).toString() !== algorithm) process.exit(1);
if (expected && (expected.algorithm !== algorithm || expected.key !== key)) process.exit(1);
const descriptor = fs.openSync(capture, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
try {
  if (fs.fstatSync(descriptor).size > 262144) process.exitCode = 1;
  else fs.writeSync(descriptor, JSON.stringify({ algorithm, key }) + '\n');
} finally { fs.closeSync(descriptor); }
`;

export interface SshTrustCommand {
  /** Supply as the value of KnownHostsCommand, without shell evaluation. */
  command: string;
  /** Read only after strict SSH authentication and the remote response both succeed. */
  observedKey(): Promise<OfferedSshKey>;
  /** Await every SSH process before releasing this resource. */
  release(): Promise<void>;
}

/** Adds a veto within known-host checking. Callers must prevent DNS/localhost verification bypasses. */
export async function acquireSshTrustCommand(options: {
  originalCommand?: string;
  expected?: OfferedSshKey;
}): Promise<SshTrustCommand> {
  const original =
    options.originalCommand && options.originalCommand.trim().toLowerCase() !== 'none'
      ? separateExecutable(options.originalCommand)
      : undefined;
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-ssh-trust-'));
  try {
    const capture = join(directory, 'observations');
    const configuration = join(directory, 'expected.json');
    const helper = join(directory, 'capture.cjs');
    const wrapper = join(directory, 'command');
    await writeFile(capture, '', { mode: 0o600, flag: 'wx' });
    await writeFile(configuration, JSON.stringify(options.expected ?? null), { mode: 0o600, flag: 'wx' });
    await writeFile(helper, captureProgram, { mode: 0o600, flag: 'wx' });
    const invoke = [process.execPath, helper, capture, configuration].map(shellQuote).join(' ');
    const delegate = original ? `exec ${shellQuote(original.executable)} "$@"` : 'exit 0';
    await writeFile(wrapper, `#!/bin/sh\n${invoke} "$1" "$2" "$3" || exit 1\nshift 3\n${delegate}\n`, {
      mode: 0o700,
      flag: 'wx',
    });
    let removal: Promise<void> | undefined;
    return {
      command: `"${wrapper.replace(/[\\'"]/g, '\\$&')}" %I %t %K${original?.tail ?? ''}`,
      async observedKey() {
        const content = await readFile(capture, 'utf8');
        if (!content || content.length > 350000) throw new Error('Missing or excessive SSH key observations');
        const observations = content
          .trimEnd()
          .split('\n')
          .map((line) => offeredKeySchema.parse(JSON.parse(line)));
        const first = observations[0]!;
        if (observations.some((item) => item.algorithm !== first.algorithm || item.key !== first.key))
          throw new Error('Conflicting SSH key observations');
        return first;
      },
      release() {
        removal ??= rm(directory, { recursive: true, force: true });
        return removal;
      },
    };
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'SSH trust command preparation and cleanup failed', {
        cause: cleanup,
      });
    }
    throw error;
  }
}
