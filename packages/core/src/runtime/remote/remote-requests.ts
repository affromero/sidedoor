import { agentInvocation, type SshConnection } from '../process/environment';
import type { ProcessRequest } from '../process/process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { remoteSessionSupervisor } from './remote-session';

/** Python is an explicit remote prerequisite. The supervisor owns the agent's process group. */
export const remoteSupervisor = `
import base64, json, os, select, signal, subprocess, sys, threading, time
child = None
terminated = False
def terminate(*args):
    global terminated
    if child is not None and not terminated:
        terminated = True
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
def interrupted(*args):
    terminate()
    sys.exit(125)
for event in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(event, interrupted)
signal.signal(signal.SIGALRM, interrupted)
signal.alarm(30)
line = sys.stdin.buffer.readline(32 * 1024 * 1024 + 1)
if len(line) > 32 * 1024 * 1024 or not line.endswith(b'\\n'): sys.exit(126)
payload = json.loads(line)
timeout = payload['timeoutMs'] / 1000
if timeout <= 0 or timeout > 86400: sys.exit(126)
deadline = time.monotonic() + timeout
signal.alarm(0)
environment = {key: os.environ[key] for key in payload['environmentKeys'] if key in os.environ}
environment.update(payload['environment'])
try:
    child = subprocess.Popen(payload['argv'], stdin=subprocess.PIPE, start_new_session=True, env=environment)
    data = base64.b64decode(payload['input'], validate=True)
    def feed():
        try:
            child.stdin.write(data)
            child.stdin.close()
        except BrokenPipeError: pass
    threading.Thread(target=feed, daemon=True).start()
    while child.poll() is None:
        if time.monotonic() >= deadline:
            terminate()
            sys.exit(124)
        ready, _, _ = select.select([sys.stdin], [], [], 0.1)
        if ready and not os.read(sys.stdin.fileno(), 1):
            terminate()
            sys.exit(125)
    sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
finally:
    terminate()
    if child is not None:
        try: child.wait(timeout=1)
        except subprocess.TimeoutExpired: pass
`;

export interface RemoteAgentRequest {
  connection: SshConnection;
  command: string;
  args: readonly string[];
  input?: string | Uint8Array;
  /** Named remote environment fields only. Provider adapters choose the credential fields. */
  remoteEnvironmentKeys: readonly string[];
  remoteEnvironment?: Readonly<Record<string, string>>;
  transportEnvironment: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export function supervisedRemoteRequest(request: RemoteAgentRequest): ProcessRequest {
  const timeoutMs = request.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
    throw new Error('Remote timeout must be between 1 ms and 24 hours');
  const payload =
    JSON.stringify({
      argv: [request.command, ...request.args],
      input: Buffer.from(request.input ?? '').toString('base64'),
      timeoutMs,
      environmentKeys: request.remoteEnvironmentKeys,
      environment: request.remoteEnvironment ?? {},
    }) + '\n';
  if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new Error('Remote invocation is too large');
  const invocation = agentInvocation('python3', ['-c', remoteSupervisor], request.connection);
  return {
    ...invocation,
    input: payload,
    keepInputOpen: true,
    environment: request.transportEnvironment,
    timeoutMs: timeoutMs + 5000,
    maxOutputBytes: request.maxOutputBytes,
    signal: request.signal,
  };
}

export interface RemoteSessionRequest extends Omit<RemoteAgentRequest, 'args'> {
  remoteUser?: string;
  /** Persist this identity before connecting. Reuse it only for recovery, never another execution. */
  operationId: string;
  args: readonly (string | { file: number })[];
  files: readonly string[];
  operationRoot?: string;
}

function sessionIdentity(operationId: string, operationRoot?: string): void {
  if (!/^[a-f0-9]{32}$/.test(operationId)) throw new Error('Invalid remote operation identity');
  if (operationRoot !== undefined && (!operationRoot.startsWith('/') || operationRoot.includes('\0')))
    throw new Error('Remote operation root must be absolute');
}

/** One supervised transport owns attachment writes, execution, and cleanup. */
export async function supervisedSessionRequest(
  request: RemoteSessionRequest,
  remainingMs?: () => number,
): Promise<ProcessRequest> {
  sessionIdentity(request.operationId, request.operationRoot);
  const base = supervisedRemoteRequest({ ...request, args: [] });
  const files: { size: number; extension: string; sha256: string }[] = [];
  for (const path of request.files) {
    request.signal?.throwIfAborted();
    const info = await stat(path);
    if (!info.isFile() || !Number.isSafeInteger(info.size))
      throw new Error('Attachment must be a regular file');
    const extension = extname(path);
    if (!/^[.a-zA-Z0-9]{0,20}$/.test(extension)) throw new Error('Invalid attachment extension');
    const hash = createHash('sha256');
    const source = createReadStream(path, { highWaterMark: 65536, signal: request.signal });
    let size = 0;
    try {
      for await (const chunk of source) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        hash.update(bytes);
      }
    } finally {
      source.destroy();
    }
    if (size !== info.size) throw new Error('Attachment changed during preparation');
    files.push({ size, extension, sha256: hash.digest('hex') });
  }
  for (const arg of request.args) {
    if (typeof arg === 'string') continue;
    if (!Number.isSafeInteger(arg.file) || arg.file < 0 || arg.file >= files.length)
      throw new Error('Invalid attachment argument');
  }
  const payload = {
    operationId: request.operationId,
    operationRoot: request.operationRoot,
    remoteUser: request.remoteUser,
    timeoutMs: request.timeoutMs ?? 600_000,
    argv: [request.command, ...request.args],
    files,
    input: Buffer.from(request.input ?? '').toString('base64'),
    environmentKeys: request.remoteEnvironmentKeys,
    environment: request.remoteEnvironment ?? {},
  };
  const manifest = JSON.stringify(payload) + '\n';
  if (Buffer.byteLength(manifest) > 32 * 1024 * 1024) throw new Error('Remote manifest is too large');
  const invocation = agentInvocation('python3', ['-c', remoteSessionSupervisor], request.connection);
  return {
    ...base,
    ...invocation,
    input: undefined,
    inputStream: () =>
      Readable.from(
        (async function* () {
          const remaining = remainingMs?.() ?? payload.timeoutMs;
          if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > payload.timeoutMs)
            throw new Error('Remote operation deadline expired');
          yield Buffer.from(
            remainingMs ? JSON.stringify({ ...payload, timeoutMs: remaining }) + '\n' : manifest,
          );
          for (let index = 0; index < request.files.length; index++) {
            const file = request.files[index]!;
            const expected = files[index]!.size;
            let received = 0;
            const source = createReadStream(file, { highWaterMark: 65536 });
            try {
              for await (const chunk of source) {
                const bytes = chunk as Buffer;
                received += bytes.length;
                if (received > expected) throw new Error('Attachment changed during upload');
                yield bytes;
              }
              if (received !== expected) throw new Error('Attachment changed during upload');
            } finally {
              source.destroy();
            }
          }
        })(),
        { objectMode: false, highWaterMark: 65536 },
      ),
  };
}

export function remoteRecoveryRequest(
  request: Pick<
    RemoteSessionRequest,
    'operationId' | 'operationRoot' | 'remoteUser' | 'connection' | 'transportEnvironment' | 'signal'
  >,
): ProcessRequest {
  sessionIdentity(request.operationId, request.operationRoot);
  return {
    ...agentInvocation('python3', ['-c', remoteSessionSupervisor], request.connection),
    input:
      JSON.stringify({
        operationId: request.operationId,
        operationRoot: request.operationRoot,
        remoteUser: request.remoteUser,
        timeoutMs: 30_000,
        recover: true,
      }) + '\n',
    keepInputOpen: true,
    environment: request.transportEnvironment,
    timeoutMs: 45_000,
    signal: request.signal,
  };
}
