import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { interruptibleStream } from './stream';

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  input?: string | Uint8Array;
  /** A fresh, owned byte stream. The runner destroys it when execution ends. */
  inputStream?: () => Readable;
  /** Keep the transport open for supervised SSH disconnect detection. */
  keepInputOpen?: boolean;
  signal?: AbortSignal;
  /** Null explicitly preserves workloads without a wall-clock deadline. Cleanup stays bounded. */
  timeoutMs?: number | null;
  maxOutputBytes?: number;
  /** Optional per-stream bound, in addition to the combined output bound. */
  maxOutputBytesPerChannel?: number;
}
export interface ProcessChunk {
  channel: 'stdout' | 'stderr';
  text: string;
}
export interface ProcessByteRequest extends Omit<ProcessRequest, 'maxOutputBytes'> {
  /** Null permits unlimited cumulative output without retaining it in memory. */
  maxOutputBytes?: number | null;
  /** Queue high-water mark. Incoming pipe chunks and stream buffers are additional. */
  maxBufferedBytes?: number;
}
export interface ProcessByteChunk {
  channel: 'stdout' | 'stderr';
  bytes: Uint8Array;
}
export class ProcessExecutionError extends Error {
  /** Caller-visible diagnostics. Excluded from message and routine telemetry. */
  diagnostics?: { stdout: string; stderr: string };
  /** Validated supervisor reason codes, without provider content or transport diagnostics. */
  remoteFailureCodes?: readonly string[];
  constructor(
    public readonly code: 'start_failed' | 'exit_failed' | 'output_limit' | 'busy' | 'cleanup_failed',
    public readonly exitCode: number | null = null,
    options?: ErrorOptions,
  ) {
    super(`Agent process ${code}`, options);
  }
}

function stop(child: ChildProcess): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
    return;
  }
  child.kill('SIGKILL');
}

async function finishProcess(
  child: ChildProcess | undefined,
  closed: Promise<void> | undefined,
  isClosed: () => boolean,
  terminate: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (child && !isClosed()) terminate();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
    if (child && !isClosed()) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      throw new ProcessExecutionError('cleanup_failed');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function finishInput(feeding: Promise<void> | undefined): Promise<void> {
  if (!feeding) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      feeding,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProcessExecutionError('cleanup_failed')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Limits apply across simultaneous invocations sharing this runner. No implicit shell or inherited secrets. */
export class ProcessRunner {
  private active = 0;
  constructor(private readonly maxConcurrent = 4) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
      throw new Error('Process concurrency must be positive');
  }

  stream(request: ProcessRequest): AsyncGenerator<ProcessChunk> {
    return interruptibleStream((signal) => this.decode({ ...request, signal }), {
      signal: request.signal,
      isCleanupError: (error) => error instanceof ProcessExecutionError && error.code === 'cleanup_failed',
    });
  }
  streamBytes(request: ProcessByteRequest): AsyncGenerator<ProcessByteChunk> {
    return interruptibleStream((signal) => this.run({ ...request, signal }, true), {
      signal: request.signal,
      isCleanupError: (error) => error instanceof ProcessExecutionError && error.code === 'cleanup_failed',
    });
  }

  private async *decode(request: ProcessRequest): AsyncGenerator<ProcessChunk> {
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let failure: unknown;
    try {
      for await (const chunk of this.run(request, false)) {
        const text = decoders[chunk.channel].write(Buffer.from(chunk.bytes));
        if (text) yield { channel: chunk.channel, text };
      }
    } catch (error) {
      if (!(error instanceof ProcessExecutionError && error.code === 'exit_failed')) throw error;
      failure = error;
    }
    for (const channel of ['stdout', 'stderr'] as const) {
      const text = decoders[channel].end();
      if (text) yield { channel, text };
    }
    if (failure) throw failure;
  }

  private async *run(request: ProcessByteRequest, binary: boolean): AsyncGenerator<ProcessByteChunk> {
    const timeout = request.timeoutMs === undefined ? 600_000 : request.timeoutMs;
    const maximum = request.maxOutputBytes === undefined ? 16 * 1024 * 1024 : request.maxOutputBytes;
    const channelMaximum = request.maxOutputBytesPerChannel ?? maximum;
    const highWater = request.maxBufferedBytes ?? 1024 * 1024;
    if (
      (!binary && maximum === null) ||
      ![
        ...(timeout === null ? [] : [timeout]),
        ...(maximum === null ? [] : [maximum]),
        ...(channelMaximum === null ? [] : [channelMaximum]),
        highWater,
      ].every((value) => Number.isSafeInteger(value) && value > 0) ||
      !request.command
    )
      throw new Error('Invalid process request');
    if (request.input !== undefined && request.inputStream)
      throw new Error('Choose buffered or streamed process input');
    request.signal?.throwIfAborted();
    if (this.active >= this.maxConcurrent) throw new ProcessExecutionError('busy');
    this.active++;
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const queue: ProcessByteChunk[] = [];
    let queuedBytes = 0;
    let wake: (() => void) | undefined;
    let child: ChildProcess | undefined;
    let closed: Promise<void> | undefined;
    let done = false;
    let terminated = false;
    let failure: unknown;
    let bytes = 0;
    const channelBytes = { stdout: 0, stderr: 0 };
    const inputController = new AbortController();
    let feeding: Promise<void> | undefined;
    let inputSource: Readable | undefined;
    let inputFailure: unknown;
    const timer =
      timeout === null
        ? undefined
        : setTimeout(() => controller.abort(new Error('Agent process timed out')), timeout);
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const terminate = () => {
      if (!child || terminated) return;
      terminated = true;
      child.stdout?.resume();
      child.stderr?.resume();
      try {
        stop(child);
      } catch (error) {
        failure = new ProcessExecutionError('cleanup_failed', null, { cause: error });
      }
    };
    const abort = () => {
      failure = signal.reason;
      terminate();
      notify();
    };
    try {
      child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...request.environment },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output = child;
      closed = new Promise<void>((resolve) => {
        output.once('error', (error) => {
          failure = new ProcessExecutionError('start_failed', null, { cause: error });
          notify();
        });
        output.once('close', (code) => {
          clearTimeout(timer);
          if (code !== 0 && !failure) failure = new ProcessExecutionError('exit_failed', code);
          done = true;
          notify();
          resolve();
        });
      });
      for (const channel of ['stdout', 'stderr'] as const) {
        output[channel]?.on('data', (chunk: Buffer) => {
          if (signal.aborted || terminated) return;
          if (maximum !== null) bytes += chunk.length;
          if (channelMaximum !== null) channelBytes[channel] += chunk.length;
          if (
            (maximum !== null && bytes > maximum) ||
            (channelMaximum !== null && channelBytes[channel] > channelMaximum)
          ) {
            controller.abort(new ProcessExecutionError('output_limit'));
            return;
          }
          queue.push({ channel, bytes: Uint8Array.from(chunk) });
          queuedBytes += chunk.length;
          if (binary && queuedBytes >= highWater) {
            output.stdout?.pause();
            output.stderr?.pause();
          }
          notify();
        });
      }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      output.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          failure = error;
          controller.abort(error);
        }
      });
      if (request.inputStream && output.stdin) {
        inputSource = request.inputStream();
        feeding = pipeline(inputSource, output.stdin, {
          signal: inputController.signal,
          end: !request.keepInputOpen,
        }).catch((error: unknown) => {
          if (inputController.signal.aborted) return;
          inputFailure = error;
          controller.abort(error);
        });
      } else if (request.keepInputOpen) {
        if (request.input !== undefined) output.stdin?.write(request.input);
      } else output.stdin?.end(request.input);
      while (true) {
        if (failure && !(failure instanceof ProcessExecutionError && failure.code === 'exit_failed'))
          throw failure;
        const chunk = queue.shift();
        if (chunk) {
          queuedBytes -= chunk.bytes.byteLength;
          if (binary && queuedBytes < highWater / 2) {
            output.stdout?.resume();
            output.stderr?.resume();
          }
          yield chunk;
          continue;
        }
        if (done) {
          if (failure) throw failure;
          await finishInput(feeding);
          if (inputFailure) throw inputFailure;
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      inputController.abort();
      inputSource?.destroy();
      try {
        await finishProcess(child, closed, () => done, terminate);
      } finally {
        try {
          await finishInput(feeding);
        } finally {
          this.active--;
        }
      }
    }
  }

  async execute(request: ProcessRequest): Promise<{ stdout: string; stderr: string }> {
    const result = { stdout: '', stderr: '' };
    try {
      for await (const chunk of this.stream(request)) result[chunk.channel] += chunk.text;
    } catch (error) {
      if (error instanceof ProcessExecutionError) error.diagnostics = result;
      throw error;
    }
    return result;
  }
}
