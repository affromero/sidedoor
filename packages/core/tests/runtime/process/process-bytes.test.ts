import { createHash } from 'node:crypto';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { ProcessRunner } from '../../../src/runtime/process/process';

const request = (script: string) => ({
  command: process.execPath,
  args: ['-e', script],
  environment: {},
  timeoutMs: 5000,
});

describe('owned binary process streaming', () => {
  it('preserves every byte above the text API output ceiling with explicit unlimited streaming', async () => {
    const chunk = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 256));
    const expected = createHash('sha256');
    for (let index = 0; index < 257; index++) expected.update(chunk);
    const actual = createHash('sha256');
    let bytes = 0;
    for await (const item of new ProcessRunner().streamBytes({
      ...request(
        "const b=Buffer.from(Array.from({length:65536},(_,i)=>i%256));(async()=>{for(let i=0;i<257;i++)if(!process.stdout.write(b))await new Promise(r=>process.stdout.once('drain',r));})();",
      ),
      maxOutputBytes: null,
      maxBufferedBytes: 65536,
    })) {
      expect(item.channel).toBe('stdout');
      bytes += item.bytes.length;
      actual.update(item.bytes);
    }
    expect(bytes).toBe(257 * 65536);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
  });

  it('backpressures a slow consumer and drains trailing stderr before normal exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidedoor-bytes-'));
    const marker = join(directory, 'finished');
    const stream = new ProcessRunner().streamBytes({
      ...request(
        `const fs=require('node:fs');(async()=>{for(let i=0;i<512;i++)if(!process.stderr.write(Buffer.alloc(65536,42)))await new Promise(r=>process.stderr.once('drain',r));fs.writeFileSync(${JSON.stringify(marker)},'done');})();`,
      ),
      maxOutputBytes: null,
      maxBufferedBytes: 1024,
    });
    try {
      const first = await stream.next();
      expect(first.done).toBe(false);
      await delay(100);
      await expect(access(marker)).rejects.toThrow();
      let bytes = first.value!.bytes.length;
      for await (const item of stream) {
        expect(item.channel).toBe('stderr');
        bytes += item.bytes.length;
      }
      expect(bytes).toBe(512 * 65536);
      await access(marker);
    } finally {
      await stream.return(undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('kills a paused resistant child on cancellation without waiting for another pull', async () => {
    const controller = new AbortController();
    const reason = new Error('Stop binary work');
    const stream = new ProcessRunner().streamBytes({
      ...request(
        "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setTimeout(()=>{setInterval(()=>process.stderr.write(Buffer.alloc(65536)),1)},20);",
      ),
      signal: controller.signal,
      maxOutputBytes: null,
      maxBufferedBytes: 1024,
    });
    try {
      const first = await stream.next();
      const pid = Number(Buffer.from(first.value!.bytes).toString());
      await delay(100);
      controller.abort(reason);
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      await expect(stream.next()).rejects.toBe(reason);
    } finally {
      controller.abort(reason);
      await stream.return(undefined);
    }
  });

  it('flushes incomplete UTF-8 diagnostics before reporting a failed exit', async () => {
    const runner = new ProcessRunner();
    await expect(
      runner.execute(request('process.stdout.write(Buffer.from([0xe2,0x82]),()=>{process.exitCode=7})')),
    ).rejects.toMatchObject({
      code: 'exit_failed',
      exitCode: 7,
      diagnostics: { stdout: '\uFFFD', stderr: '' },
    });
  });

  it.each([0, -1, 0.5, Infinity, NaN])(
    'rejects invalid buffer threshold %s before spawning',
    async (maximum) => {
      const stream = new ProcessRunner().streamBytes({
        ...request('process.exit(0)'),
        maxBufferedBytes: maximum,
      });
      await expect(stream.next()).rejects.toThrow('Invalid process request');
    },
  );
});
