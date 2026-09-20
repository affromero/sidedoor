import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRunner } from '../../../src/runtime/process/process';
import { agentEnvironment, agentInvocation } from '../../../src/runtime/process/environment';
import { Readable } from 'node:stream';

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
});
const request = (script: string) => ({
  command: process.execPath,
  args: ['-e', script],
  environment: agentEnvironment(process.env),
  timeoutMs: 2000,
});

describe('agent process execution', () => {
  it('supports explicit unbounded execution while cancellation confirms a resistant child has exited', async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const reason = new Error('Stop media processing');
    const stream = new ProcessRunner(1).stream({
      ...request(
        "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)",
      ),
      timeoutMs: null,
      signal: controller.signal,
    });
    const first = await stream.next();
    const pid = Number(first.value!.text);
    controller.abort(reason);
    await expect(stream.next()).rejects.toBe(reason);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('enforces per-channel limits independently of the combined output budget', async () => {
    const runner = new ProcessRunner();
    const limits = { maxOutputBytes: 2048, maxOutputBytesPerChannel: 1024 };
    const output = await runner.execute({
      ...request("process.stdout.write('x'.repeat(1024));process.stderr.write('y'.repeat(1024))"),
      ...limits,
    });
    expect(output.stdout).toHaveLength(1024);
    expect(output.stderr).toHaveLength(1024);
    await expect(
      runner.execute({ ...request("process.stdout.write('x'.repeat(1025))"), ...limits }),
    ).rejects.toMatchObject({ code: 'output_limit' });
  });
  it('returns during a pending read and releases the child and process slot', async () => {
    const runner = new ProcessRunner(1);
    const stream = runner.stream(
      request('process.stdout.write(String(process.pid));setInterval(()=>{},1000)'),
    );
    const first = await stream.next();
    const pid = Number(first.value!.text);
    const pending = stream.next();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const closed = stream.return(undefined);
    const repeated = stream.return(undefined);
    await rejected;
    expect(await closed).toMatchObject({ done: true });
    expect(await repeated).toMatchObject({ done: true });
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await runner.execute(request("process.stdout.write('available')"))).stdout).toBe('available');
  });

  it('preserves explicit interruption identity during a pending read', async () => {
    const stream = new ProcessRunner().stream(
      request("process.stdout.write('ready');setInterval(()=>{},1000)"),
    );
    await stream.next();
    const reason = new Error('consumer failed');
    const pending = expect(stream.next()).rejects.toBe(reason);
    const interrupted = expect(stream.throw(reason)).rejects.toBe(reason);
    await Promise.all([pending, interrupted]);
  });

  it('never creates owned input when a stream is closed before starting', async () => {
    const stream = new ProcessRunner().stream({
      ...request('process.exit(99)'),
      inputStream() {
        throw new Error('must not open');
      },
    });
    expect(await stream.return(undefined)).toMatchObject({ done: true });
    expect(await stream.next()).toMatchObject({ done: true });
  });

  it('reports cleanup failure to both a pending read and its closing consumer', async () => {
    const runner = new ProcessRunner(1);
    const stream = runner.stream({
      ...request("process.stdout.write('ready');process.stdin.resume()"),
      inputStream: () => new Readable({ read() {}, destroy() {} }),
    });
    await stream.next();
    const pending = expect(stream.next()).rejects.toMatchObject({ code: 'cleanup_failed' });
    const closed = expect(stream.return(undefined)).rejects.toMatchObject({ code: 'cleanup_failed' });
    await Promise.all([pending, closed]);
    expect((await runner.execute(request("process.stdout.write('available')"))).stdout).toBe('available');
  });

  it('retains explicit interruption alongside failed input cleanup', async () => {
    const stream = new ProcessRunner().stream({
      ...request("process.stdout.write('ready');process.stdin.resume()"),
      inputStream: () => new Readable({ read() {}, destroy() {} }),
    });
    await stream.next();
    const reason = new Error('consumer failed');
    const pending = expect(stream.next()).rejects.toMatchObject({ code: 'cleanup_failed' });
    const failure = stream.throw(reason).catch((error: unknown) => error);
    await pending;
    expect(await failure).toMatchObject({
      errors: [reason, expect.objectContaining({ code: 'cleanup_failed' })],
    });
  });
  it('rejects a successful child exit that truncates streamed input', async () => {
    await expect(
      new ProcessRunner().execute({
        ...request('process.exit(0)'),
        inputStream: () =>
          new Readable({
            read() {
              this.push(Buffer.alloc(64 * 1024));
            },
          }),
      }),
    ).rejects.toThrow();
  });
  it('bounds a broken input destroy callback and releases the concurrency slot', async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const runner = new ProcessRunner(1);
    const source = new Readable({ read() {}, destroy() {} });
    const run = async () => {
      for await (const chunk of runner.stream({
        ...request("process.stdout.write('ready'); process.stdin.resume()"),
        inputStream: () => source,
        signal: controller.signal,
      })) {
        if (chunk.text.includes('ready')) controller.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ code: 'cleanup_failed' });
    expect((await runner.execute(request("process.stdout.write('next')"))).stdout).toBe('next');
  });
  it('streams large input through a slow reader without buffering the whole transfer', async () => {
    let produced = 0;
    const total = 40 * 1024 * 1024;
    const result = await new ProcessRunner().execute({
      ...request(
        "let bytes=0; process.stdin.on('data', chunk=>{bytes+=chunk.length; process.stdin.pause(); setTimeout(()=>process.stdin.resume(),1)}); process.stdin.on('end',()=>process.stdout.write(String(bytes)))",
      ),
      timeoutMs: 10_000,
      inputStream: () =>
        new Readable({
          highWaterMark: 64 * 1024,
          read() {
            if (produced === total) {
              this.push(null);
              return;
            }
            produced += 64 * 1024;
            this.push(Buffer.alloc(64 * 1024));
          },
        }),
    });
    expect(Number(result.stdout)).toBe(total);
  });
  it('destroys a blocked input source on cancellation and releases the process slot', async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const source = new Readable({ read() {} });
    const runner = new ProcessRunner(1);
    const run = async () => {
      for await (const chunk of runner.stream({
        ...request("process.stdout.write('ready'); process.stdin.resume()"),
        inputStream: () => source,
        signal: controller.signal,
      })) {
        if (chunk.text.includes('ready')) controller.abort(new Error('cancel upload'));
      }
    };
    await expect(run()).rejects.toThrow('cancel upload');
    expect(source.destroyed).toBe(true);
    expect((await runner.execute(request("process.stdout.write('next')"))).stdout).toBe('next');
  });
  it('surfaces input read failure and terminates the waiting process', async () => {
    await expect(
      new ProcessRunner().execute({
        ...request('process.stdin.resume()'),
        inputStream: () =>
          new Readable({
            read() {
              this.destroy(new Error('attachment read failed'));
            },
          }),
      }),
    ).rejects.toThrow('attachment read failed');
  });
  it('keeps supervised transport input open after the streamed payload ends', async () => {
    const result = await new ProcessRunner().execute({
      ...request(
        "process.stdin.once('data',()=>setTimeout(()=>{process.stdout.write('open');process.exit(0)},30)); process.stdin.on('end',()=>process.exit(9))",
      ),
      inputStream: () => Readable.from([Buffer.from('payload')]),
      keepInputOpen: true,
    });
    expect(result.stdout).toBe('open');
  });
  it('passes hostile arguments literally and keeps application secrets out of the process', async () => {
    const literal = '$(touch /tmp/never-execute-this) ; `echo unsafe`';
    const result = await new ProcessRunner().execute({
      ...request(
        'process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.APP_SECRET,auth:process.env.AGENT_AUTH}))',
      ),
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.APP_SECRET,auth:process.env.AGENT_AUTH}))',
        literal,
      ],
      environment: agentEnvironment(
        { ...process.env, APP_SECRET: 'private database key', AGENT_AUTH: 'selected credential' },
        ['AGENT_AUTH'],
      ),
    });
    expect(JSON.parse(result.stdout)).toEqual({ arg: literal, auth: 'selected credential' });
  });
  it('preserves UTF-8 characters split across process writes', async () => {
    const result = await new ProcessRunner().execute(
      request(
        "const bytes=Buffer.from('hello 🌍'); process.stdout.write(bytes.subarray(0,8)); setTimeout(()=>process.stdout.write(bytes.subarray(8)),30);",
      ),
    );
    expect(result.stdout).toBe('hello 🌍');
  });
  it('terminates excessive output and makes the concurrency slot available afterward', async () => {
    const runner = new ProcessRunner(1);
    await expect(
      runner.execute({
        ...request("process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000)"),
        maxOutputBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'output_limit' });
    expect((await runner.execute(request("process.stdout.write('ready')"))).stdout).toBe('ready');
  });
  it('reports nonzero exit status without leaking stderr through the error message', async () => {
    await expect(
      new ProcessRunner().execute(request("process.stderr.write('private diagnostic'); process.exit(7)")),
    ).rejects.toMatchObject({ code: 'exit_failed', exitCode: 7, message: 'Agent process exit_failed' });
  });
  it('cleans up the process when a streaming consumer stops reading', async () => {
    const runner = new ProcessRunner(1);
    for await (const chunk of runner.stream(
      request("process.stdout.write('ready'); setInterval(()=>{},1000)"),
    )) {
      expect(chunk.text).toBe('ready');
      break;
    }
    expect((await runner.execute(request("process.stdout.write('next')"))).stdout).toBe('next');
  });
  it.skipIf(process.platform === 'win32')(
    'cancels descendants that keep pipes open after the leader exits',
    async () => {
      const controller = new AbortController();
      controllers.push(controller);
      const runner = new ProcessRunner(1);
      const invocation = {
        ...request(
          "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',`process.stdout.write('child-ready'); setInterval(()=>{},1000)`],{stdio:'inherit'}); child.unref();",
        ),
        signal: controller.signal,
      };
      const result = async () => {
        for await (const chunk of runner.stream(invocation)) {
          if (chunk.text.includes('child-ready')) controller.abort(new Error('cancelled by consumer'));
        }
      };
      await expect(result()).rejects.toThrow('cancelled by consumer');
      expect((await runner.execute(request("process.stdout.write('next')"))).stdout).toBe('next');
    },
  );
  it('rejects SSH option injection and quotes every remote argument', async () => {
    expect(() => agentInvocation('agent', [], { host: '-oProxyCommand=bad' })).toThrow();
    expect(() => agentInvocation('agent', [], { host: '-V@example.com' })).toThrow();
    const invocation = agentInvocation('agent', ["a'b", '$(printf dangerous)'], { host: 'user@host' });
    const remote = invocation.args.at(-1)!;
    const parsed = await new ProcessRunner().execute({
      command: '/bin/sh',
      args: ['-c', `set -- ${remote}; printf '%s\\n' "$@"`],
      environment: agentEnvironment(process.env),
    });
    expect(parsed.stdout.split('\n').filter(Boolean)).toEqual(['agent', "a'b", '$(printf dangerous)']);
  });
});
