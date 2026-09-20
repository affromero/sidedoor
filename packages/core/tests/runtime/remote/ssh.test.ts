import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRunner, type ProcessRequest } from '../../../src/runtime/process/process';
import { agentEnvironment } from '../../../src/runtime/process/environment';
import {
  remoteSupervisor,
  supervisedRemoteRequest,
  supervisedSessionRequest,
  remoteRecoveryRequest,
  remoteSessionSupervisor,
  RemoteOutputDecoder,
} from '../../../src/runtime/ssh/ssh';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sessionFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-remote-'));
  directories.push(directory);
  return {
    directory,
    operationId: randomBytes(16).toString('hex'),
    operationRoot: join(directory, 'operations'),
    connection: { host: 'owner@host' },
    transportEnvironment: agentEnvironment(process.env),
    remoteEnvironmentKeys: ['PATH', 'HOME'],
  };
}

function localSession(request: ProcessRequest): ProcessRequest {
  return { ...request, command: 'python3', args: ['-c', remoteSessionSupervisor] };
}

function frames(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stopFixtureGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
}

// Exercise the remote supervisor locally. The SSH network connection is the substituted boundary.
function remote(script: string, timeoutMs = 1000): ProcessRequest {
  const request = supervisedRemoteRequest({
    connection: { host: 'owner@host' },
    command: process.execPath,
    args: ['-e', script],
    input: 'private prompt',
    remoteEnvironmentKeys: ['PATH', 'HOME'],
    remoteEnvironment: { SELECTED_AUTH: 'configured credential' },
    transportEnvironment: agentEnvironment(process.env),
    timeoutMs,
  });
  return { ...request, command: 'python3', args: ['-c', remoteSupervisor] };
}

describe.skipIf(process.platform === 'win32')('remote agent supervision', () => {
  it('rejects same-size attachment replacement before launching the agent', async () => {
    const fixture = await sessionFixture();
    const file = join(fixture.directory, 'image.png');
    const launched = join(fixture.directory, 'launched');
    await writeFile(file, 'original');
    const request = await supervisedSessionRequest({
      ...fixture,
      command: process.execPath,
      files: [file],
      args: ['-e', "require('node:fs').writeFileSync(process.argv[1],'started')", launched],
    });
    await writeFile(file, 'replaced');
    let failure: unknown;
    try {
      await new ProcessRunner().execute(localSession(request));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'exit_failed',
      diagnostics: { stdout: expect.stringContaining('attachment_changed') },
    });
    await expect(access(launched)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(fixture.operationRoot, fixture.operationId, 'data'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it.skipIf(!process.env.SIDEDOOR_TEST_REMOTE_CONTAINER)(
    'stops Linux descendants that escape into another session before acknowledging cleanup',
    async () => {
      const fixture = await sessionFixture();
      const container = process.env.SIDEDOOR_TEST_REMOTE_CONTAINER!;
      const operationRoot = '/tmp/sidedoor-session-' + fixture.operationId;
      const docker = (args: string[]): ProcessRequest => ({
        command: 'docker',
        args: ['exec', '-i', container, ...args],
        environment: agentEnvironment(process.env),
        timeoutMs: 15_000,
      });
      try {
        const prepared = await supervisedSessionRequest({
          ...fixture,
          connection: process.env.SIDEDOOR_TEST_SSH_HOST
            ? {
                host: process.env.SIDEDOOR_TEST_SSH_HOST,
                identityFile: process.env.SIDEDOOR_TEST_SSH_KEY,
                knownHostsFile: process.env.SIDEDOOR_TEST_SSH_KNOWN_HOSTS,
              }
            : fixture.connection,
          operationRoot,
          command: 'python3',
          files: [],
          args: [
            '-c',
            "import subprocess; child=subprocess.Popen(['python3','-c','import time; time.sleep(60)'],start_new_session=True); print(child.pid,flush=True)",
          ],
        });
        const result = await new ProcessRunner().execute(
          process.env.SIDEDOOR_TEST_SSH_HOST
            ? prepared
            : {
                ...prepared,
                ...docker(['python3', '-c', remoteSessionSupervisor]),
              },
        );
        const messages = frames(result.stdout);
        const pid = Number(
          messages
            .filter((frame) => frame.type === 'data' && frame.channel === 'stdout')
            .map((frame) => Buffer.from(String(frame.data), 'base64').toString())
            .join(''),
        );
        expect(pid).toBeGreaterThan(1);
        expect(messages.at(-1)).toMatchObject({ type: 'cleaned', containment: 'descendants', exitCode: 0 });
        const probe = await new ProcessRunner().execute(
          docker([
            'python3',
            '-c',
            'import os,sys; print(os.path.exists("/proc/"+sys.argv[1]))',
            String(pid),
          ]),
        );
        expect(probe.stdout.trim()).toBe('False');
      } finally {
        await new ProcessRunner().execute(
          docker([
            'python3',
            '-c',
            'import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)',
            operationRoot,
          ]),
        );
      }
    },
  );
  it('recovers an interrupted upload and serializes simultaneous recovery requests', async () => {
    const fixture = await sessionFixture();
    const file = join(fixture.directory, 'partial.png');
    await writeFile(file, Buffer.alloc(1024 * 1024));
    const request = await supervisedSessionRequest({
      ...fixture,
      command: process.execPath,
      files: [file],
      args: ['-e', 'process.exit(0)'],
    });
    const prepared = request.inputStream!();
    const iterator = prepared[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();
    const header = Buffer.from(first.value as Uint8Array).subarray(
      0,
      Buffer.from(first.value as Uint8Array).indexOf(10) + 1,
    );
    let sent = false;
    request.inputStream = () =>
      new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(header);
          this.push(Buffer.alloc(100));
        },
      });
    const original = new ProcessRunner().execute(localSession(request)).then(
      () => null,
      (error) => error as unknown,
    );
    const staged = join(fixture.operationRoot, fixture.operationId, 'data', '0.png');
    await expect
      .poll(async () =>
        access(staged).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const recoveries = await Promise.all(
      [0, 1].map(() => new ProcessRunner().execute(localSession(remoteRecoveryRequest(fixture)))),
    );
    expect(await original).toBeInstanceOf(Error);
    for (const recovered of recoveries)
      expect(frames(recovered.stdout).at(-1)).toMatchObject({
        type: 'cleaned',
        operationId: fixture.operationId,
      });
    await expect(access(staged)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains uncertain execution files when its supervisor is killed before stopping the child', async () => {
    const fixture = await sessionFixture();
    const pidFile = join(fixture.directory, 'pid');
    let pid: number | undefined;
    try {
      const request = await supervisedSessionRequest({
        ...fixture,
        command: process.execPath,
        files: [],
        args: [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000)",
          pidFile,
        ],
      });
      await expect(new ProcessRunner().execute(localSession(request))).rejects.toThrow();
      pid = Number(await readFile(pidFile, 'utf8'));
      expect(() => process.kill(pid!, 0)).not.toThrow();
      await expect(
        new ProcessRunner().execute(localSession(remoteRecoveryRequest(fixture))),
      ).rejects.toMatchObject({ code: 'exit_failed', exitCode: 70 });
      await expect(access(join(fixture.operationRoot, fixture.operationId, 'data'))).resolves.toBeUndefined();
    } finally {
      if (pid) stopFixtureGroup(pid);
    }
  });
  it('uploads duplicate basenames separately and acknowledges cleanup after execution', async () => {
    const fixture = await sessionFixture();
    await mkdir(join(fixture.directory, 'a'));
    await mkdir(join(fixture.directory, 'b'));
    const files = ['a/image.png', 'b/image.png'].map((file) => join(fixture.directory, file));
    await writeFile(files[0]!, 'first');
    await writeFile(files[1]!, 'second');
    const result = await new ProcessRunner().execute(
      localSession(
        await supervisedSessionRequest({
          ...fixture,
          command: process.execPath,
          files,
          args: [
            '-e',
            "const fs=require('node:fs'); process.stdout.write(JSON.stringify(process.argv.slice(1).map(path=>fs.readFileSync(path,'utf8'))))",
            { file: 0 },
            { file: 1 },
          ],
        }),
      ),
    );
    const decoder = new RemoteOutputDecoder({
      operationId: fixture.operationId,
      remoteUser: userInfo().username,
      operationRoot: fixture.operationRoot,
    });
    const output = decoder
      .push({ channel: 'stdout', text: result.stdout })
      .filter((chunk) => chunk.channel === 'stdout')
      .map((chunk) => chunk.text)
      .join('');
    expect(JSON.parse(output)).toEqual(['first', 'second']);
    expect(decoder.finish({}).cleanup).toMatchObject({
      type: 'cleaned',
      operationId: fixture.operationId,
      exitCode: 0,
    });
    await expect(access(join(fixture.operationRoot, fixture.operationId, 'data'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(join(fixture.operationRoot, fixture.operationId, 'cancelled')),
    ).resolves.toHaveLength(0);
  });
  it('streams attachments larger than the invocation manifest limit', async () => {
    const fixture = await sessionFixture();
    const file = join(fixture.directory, 'large.png');
    await writeFile(file, Buffer.alloc(40 * 1024 * 1024, 7));
    const result = await new ProcessRunner().execute(
      localSession(
        await supervisedSessionRequest({
          ...fixture,
          command: process.execPath,
          files: [file],
          timeoutMs: 10_000,
          args: [
            '-e',
            "const fs=require('node:fs'); const bytes=fs.readFileSync(process.argv[1]);process.stdout.write(JSON.stringify({length:bytes.length,valid:bytes.every(byte=>byte===7)}))",
            { file: 0 },
          ],
        }),
      ),
    );
    const output = frames(result.stdout)
      .filter((frame) => frame.type === 'data')
      .map((frame) => Buffer.from(String(frame.data), 'base64').toString())
      .join('');
    expect(JSON.parse(output)).toEqual({ length: 40 * 1024 * 1024, valid: true });
  });
  it('fences a delayed execution when recovery happens before its first connection', async () => {
    const fixture = await sessionFixture();
    const recovery = await new ProcessRunner().execute(localSession(remoteRecoveryRequest(fixture)));
    expect(frames(recovery.stdout).at(-1)).toMatchObject({
      type: 'cleaned',
      operationId: fixture.operationId,
    });
    const output = join(fixture.directory, 'should-not-exist');
    await expect(
      new ProcessRunner().execute(
        localSession(
          await supervisedSessionRequest({
            ...fixture,
            command: process.execPath,
            files: [],
            args: ['-e', "require('node:fs').writeFileSync(process.argv[1],'ran')", output],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'exit_failed' });
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
    const retried = await new ProcessRunner().execute(localSession(remoteRecoveryRequest(fixture)));
    expect(frames(retried.stdout).at(-1)).toMatchObject({
      type: 'cleaned',
      operationId: fixture.operationId,
    });
  });
  it('delivers stdin and only the selected environment to the remote agent', async () => {
    const request = remote(
      "let data=''; process.stdin.on('data',chunk=>data+=chunk); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({data,auth:process.env.SELECTED_AUTH,secret:process.env.APP_SECRET}))); ",
    );
    request.environment = { ...request.environment, APP_SECRET: 'private application secret' };
    const result = await new ProcessRunner().execute(request);
    expect(JSON.parse(result.stdout)).toEqual({ data: 'private prompt', auth: 'configured credential' });
  });
  it('enforces the remote deadline even if the caller leaves the connection open', async () => {
    await expect(new ProcessRunner().execute(remote('setInterval(()=>{},1000)', 100))).rejects.toMatchObject({
      code: 'exit_failed',
      exitCode: 124,
    });
  });
  it('terminates the remote invocation when the transport closes its input', async () => {
    const request = { ...remote('setInterval(()=>{},1000)'), keepInputOpen: false };
    await expect(new ProcessRunner().execute(request)).rejects.toMatchObject({
      code: 'exit_failed',
      exitCode: 125,
    });
  });
});
