import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentInvocation, type SshConnection } from './environment';
import { remoteHostKeySchema, type RemoteHostKey } from './remote-journal';

async function removePin(directory: string, primary: { error: unknown } | undefined): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (primary)
      throw new AggregateError([primary.error, error], 'SSH execution and pin cleanup failed', {
        cause: error,
      });
    throw error;
  }
}

export interface PinnedSshConnection {
  connection: SshConnection;
  /** Release only after every process using this connection has settled. */
  release(primary?: { error: unknown }): Promise<void>;
}

interface PinRequest {
  connection: SshConnection;
  remoteUser: string;
  hostKey: RemoteHostKey;
}

/** Endpoint pinning still trusts local SSH routing configuration, including ProxyCommand. */
export async function acquirePinnedSshConnection(request: PinRequest): Promise<PinnedSshConnection> {
  const hostKey = remoteHostKeySchema.parse(request.hostKey);
  const bytes = Buffer.from(hostKey.key, 'base64');
  const algorithm = Buffer.from(hostKey.algorithm);
  if (
    bytes.toString('base64') !== hostKey.key ||
    bytes.length < 4 + algorithm.length ||
    bytes.readUInt32BE(0) !== algorithm.length ||
    !bytes.subarray(4, 4 + algorithm.length).equals(algorithm)
  )
    throw new Error('Invalid SSH host key encoding');
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-ssh-pin-'));
  try {
    const alias = 'sidedoor-' + randomBytes(16).toString('hex');
    const knownHostsFile = join(directory, 'known_hosts');
    await writeFile(knownHostsFile, `${alias} ${hostKey.algorithm} ${hostKey.key}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    const connection: SshConnection = {
      ...request.connection,
      pinnedIdentity: {
        user: request.remoteUser,
        alias,
        knownHostsFile,
        algorithms: hostKey.algorithm === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256' : hostKey.algorithm,
      },
    };
    agentInvocation('true', [], connection);
    let cleanup: Promise<void> | undefined;
    return {
      connection,
      release(primary) {
        cleanup ??= removePin(directory, primary);
        return cleanup;
      },
    };
  } catch (error) {
    await removePin(directory, { error });
    throw error;
  }
}

/** The callback must await every SSH process before returning. */
export async function withPinnedSshConnection<Result>(
  request: PinRequest,
  run: (connection: SshConnection) => Promise<Result>,
): Promise<Result> {
  const pin = await acquirePinnedSshConnection(request);
  let primary: { error: unknown } | undefined;
  try {
    return await run(pin.connection);
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    await pin.release(primary);
  }
}
