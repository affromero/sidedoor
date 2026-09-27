import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerIsolatedRunner, type IsolatedRequest } from '../../src/runtime/isolated';

const image = 'alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40';
function execution(overrides: Partial<IsolatedRequest> = {}): IsolatedRequest {
  return {
    executionId: 'test-execution',
    image,
    command: ['/bin/sh', '-c', 'echo ready'],
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    memoryMb: 64,
    cpus: 0.5,
    pids: 16,
    scratchMb: 4,
    recordIdentity: async () => {},
    recordCleanup: async () => {},
    ...overrides,
  };
}
async function collect(request: IsolatedRequest) {
  let text = '';
  for await (const chunk of new DockerIsolatedRunner().stream(request)) text += chunk.text;
  return text;
}
describe('optional isolated execution', () => {
  it('rejects mutable images and invalid resource budgets before execution', async () => {
    await expect(collect(execution({ image: 'alpine:latest' }))).rejects.toThrow('immutable');
    await expect(collect(execution({ pids: 0 }))).rejects.toThrow('resource');
  });

  it('retains durable identity when Docker cleanup cannot be confirmed and reconciles it later', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidedoor-docker-fixture-'));
    const state = join(directory, 'container');
    const blocked = join(directory, 'blocked');
    const command = join(directory, 'docker');
    await writeFile(blocked, 'unavailable');
    await writeFile(
      command,
      `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const state=${JSON.stringify(state)};const blocked=${JSON.stringify(blocked)};if(a[0]==='info') console.log('linux');else if(a[0]==='image') console.log('null');else if(a[0]==='create'){fs.writeFileSync(state,'test-execution');console.log('created');}else if(a[0]==='start') console.log('ready');else if(a[0]==='inspect') console.log(a[2].includes('ExitCode')?'0':'test-execution');else if(a[0]==='ps'){if(fs.existsSync(state))console.log('container-id');}else if(a[0]==='rm'){if(fs.existsSync(blocked))process.exit(1);fs.unlinkSync(state);}\n`,
      { mode: 0o700 },
    );
    const runner = new DockerIsolatedRunner(command);
    let identity: import('../../src/runtime/isolated').IsolatedIdentity | undefined;
    let cleaned = false;
    try {
      const request = execution({
        recordIdentity: async (value) => {
          identity = value;
        },
        recordCleanup: async () => {
          cleaned = true;
        },
      });
      await expect(
        (async () => {
          for await (const chunk of runner.stream(request)) expect(chunk.text).toBe('ready\n');
        })(),
      ).rejects.toThrow('cleanup could not be verified');
      expect(cleaned).toBe(false);
      await access(state);
      await rm(blocked);
      if (!identity) throw new Error('Identity was not persisted');
      await expect(runner.reconcile({ ...identity, daemonId: 'different-daemon' })).rejects.toThrow(
        'cleanup could not be verified',
      );
      await access(state);
      await runner.reconcile(identity);
      await expect(access(state)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.env.SIDEDOOR_DOCKER_TEST !== '1')('real Docker containment', () => {
  it('enforces process count and CPU budgets inside the container', async () => {
    const nodeImage = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';
    const processes = await collect(
      execution({
        image: nodeImage,
        memoryMb: 128,
        command: [
          'node',
          '-e',
          "const {spawn}=require('node:child_process');const children=[];let denied=false;for(let i=0;i<40;i++){const c=spawn('sleep',['30']);c.on('error',e=>{if(e.code==='EAGAIN')denied=true});children.push(c)}setTimeout(()=>{for(const c of children)c.kill('SIGKILL');console.log(denied?'process limit enforced':'unbounded');process.exit(denied?0:1)},300)",
        ],
      }),
    );
    expect(processes).toContain('process limit enforced');
    const cpu = await collect(
      execution({
        image: nodeImage,
        memoryMb: 128,
        command: [
          'node',
          '-e',
          'const start=process.cpuUsage();const time=Date.now();while(Date.now()-time<1500){};const used=process.cpuUsage(start);console.log(JSON.stringify({used:used.user+used.system,wall:(Date.now()-time)*1000}))',
        ],
      }),
    );
    const measured = JSON.parse(cpu) as { used: number; wall: number };
    expect(measured.used / measured.wall).toBeLessThan(0.8);
  }, 30_000);
  it('terminates memory exhaustion and a cancelled pending read with confirmed cleanup', async () => {
    let cleaned = false;
    await expect(
      collect(
        execution({
          image: 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
          command: ['node', '-e', 'Buffer.alloc(256*1024*1024,1);setTimeout(()=>{},60000)'],
          recordCleanup: async () => {
            cleaned = true;
          },
        }),
      ),
    ).rejects.toThrow();
    expect(cleaned).toBe(true);
    const controller = new AbortController();
    cleaned = false;
    const stream = new DockerIsolatedRunner().stream(
      execution({
        command: ['/bin/sh', '-c', 'echo ready; sleep 60'],
        signal: controller.signal,
        recordCleanup: async () => {
          cleaned = true;
        },
      }),
    );
    expect((await stream.next()).value).toMatchObject({ text: 'ready\n' });
    const pending = stream.next();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cleaned).toBe(true);
  }, 30_000);
  it('denies host files, root writes, external networking and elevated identity', async () => {
    const output = await collect(
      execution({
        command: [
          '/bin/sh',
          '-c',
          'id -u; test ! -e /var/run/docker.sock; test ! -e /Users; test ! -e /root/.ssh; if touch /forbidden 2>/dev/null; then exit 1; fi; if wget -T 1 -q http://1.1.1.1 2>/dev/null; then exit 1; fi; grep NoNewPrivs /proc/self/status; grep CapEff /proc/self/status; echo contained',
        ],
      }),
    );
    expect(output).toContain('65532');
    expect(output).toContain('NoNewPrivs:\t1');
    expect(output).toContain('CapEff:\t0000000000000000');
    expect(output).toContain('contained');
  }, 30_000);

  it('limits writable scratch space and cleans up after output overflow', async () => {
    expect(
      await collect(
        execution({
          command: [
            '/bin/sh',
            '-c',
            'if dd if=/dev/zero of=/work/full bs=1M count=8 2>/dev/null; then exit 1; fi; echo bounded',
          ],
        }),
      ),
    ).toContain('bounded');
    let cleaned = false;
    await expect(
      collect(
        execution({
          maxOutputBytes: 128,
          command: ['/bin/sh', '-c', 'yes'],
          recordCleanup: async () => {
            cleaned = true;
          },
        }),
      ),
    ).rejects.toThrow();
    expect(cleaned).toBe(true);
  }, 30_000);

  it('removes the container when a consumer returns early', async () => {
    let cleaned = false;
    const runner = new DockerIsolatedRunner();
    const stream = runner.stream(
      execution({
        command: ['/bin/sh', '-c', 'echo ready; sleep 60'],
        recordCleanup: async () => {
          cleaned = true;
        },
      }),
    );
    expect((await stream.next()).value).toMatchObject({ channel: 'stdout', text: 'ready\n' });
    await stream.return(undefined);
    expect(cleaned).toBe(true);
  }, 30_000);
});
