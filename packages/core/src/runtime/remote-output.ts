import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { ProcessChunk } from './process';

const cleanupSchema = z
  .object({
    type: z.literal('cleaned'),
    operationId: z.string().regex(/^[a-f0-9]{32}$/),
    remoteUser: z.string().min(1).max(128),
    operationRoot: z.string().min(1).max(4096),
    exitCode: z.number().int().min(0).max(255),
    containment: z.enum(['descendants', 'process-group']),
  })
  .strict();
const frameSchema = z.discriminatedUnion('type', [
  cleanupSchema,
  z
    .object({ type: z.literal('data'), channel: z.enum(['stdout', 'stderr']), data: z.string().max(32768) })
    .strict(),
  z
    .object({
      type: z.literal('failure'),
      code: z.enum([
        'interrupted',
        'timeout',
        'cancelled',
        'incomplete_input',
        'invalid_manifest',
        'output_disconnected',
        'unsafe_operation_directory',
        'cleanup_failed',
        'unexpected_input',
        'supervision_unavailable',
        'disconnected',
        'remote_failed',
        'cleanup_unconfirmed',
        'remote_identity_mismatch',
        'attachment_changed',
      ]),
    })
    .strict(),
]);
export type RemoteCleanupFrame = z.infer<typeof cleanupSchema>;
export interface RemoteSessionOutput {
  channel: 'stdout' | 'stderr' | 'transport-stderr';
  text: string;
}

export class RemoteProtocolError extends Error {
  constructor(public readonly code: 'protocol_failed' | 'output_limit') {
    super(`Remote session ${code}`);
  }
}

/** The supervisor emits ASCII JSON. Child bytes are base64 and decode independently per channel. */
export class RemoteOutputDecoder {
  private pending = '';
  private bytes = 0;
  private diagnosticBytes = 0;
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private cleanup?: RemoteCleanupFrame;
  private failures: string[] = [];
  private finished = false;
  private invalid = false;
  private readonly maximum: number;
  private readonly diagnosticsMaximum: number;
  constructor(
    private readonly expected: {
      operationId: string;
      remoteUser: string;
      operationRoot: string;
      maxOutputBytes?: number;
      maxDiagnosticBytes?: number;
    },
  ) {
    this.maximum = expected.maxOutputBytes ?? 16 * 1024 * 1024;
    this.diagnosticsMaximum = expected.maxDiagnosticBytes ?? 16 * 1024 * 1024;
    if (![this.maximum, this.diagnosticsMaximum].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new Error('Invalid remote output limits');
  }

  push(chunk: ProcessChunk): RemoteSessionOutput[] {
    if (this.finished || this.invalid) throw new RemoteProtocolError('protocol_failed');
    try {
      if (chunk.channel === 'stderr') {
        this.diagnosticBytes += Buffer.byteLength(chunk.text);
        if (this.diagnosticBytes > this.diagnosticsMaximum) throw new RemoteProtocolError('output_limit');
        return chunk.text ? [{ channel: 'transport-stderr', text: chunk.text }] : [];
      }
      // ProcessRunner may already have decoded transport bytes. ASCII-only wire encoding also
      // rejects replacement characters from malformed UTF-8 before parsing any protocol fields.
      for (const character of chunk.text)
        if (character.charCodeAt(0) > 127) throw new RemoteProtocolError('protocol_failed');
      const result: ProcessChunk[] = [];
      let offset = 0;
      while (offset < chunk.text.length) {
        const newline = chunk.text.indexOf('\n', offset);
        const end = newline < 0 ? chunk.text.length : newline;
        if (this.pending.length + end - offset > 65536) throw new RemoteProtocolError('protocol_failed');
        this.pending += chunk.text.slice(offset, end);
        offset = end + 1;
        if (newline < 0) break;
        result.push(...this.frame(this.pending));
        this.pending = '';
      }
      return result;
    } catch (error) {
      this.invalid = true;
      if (error instanceof RemoteProtocolError) throw error;
      throw new RemoteProtocolError('protocol_failed');
    }
  }

  /** Call only after stdout EOF and transport settlement. Cleanup never converts execution failure to success. */
  finish(transport: { error?: unknown }): {
    cleanup?: RemoteCleanupFrame;
    failures: readonly string[];
    transportError?: unknown;
  } {
    if (this.finished || this.invalid || this.pending) {
      this.invalid = true;
      throw new RemoteProtocolError('protocol_failed');
    }
    this.finished = true;
    return {
      cleanup: this.cleanup ? { ...this.cleanup } : undefined,
      failures: [...this.failures],
      transportError: transport.error,
    };
  }

  private frame(line: string): ProcessChunk[] {
    if (this.cleanup) throw new RemoteProtocolError('protocol_failed');
    const frame = frameSchema.parse(JSON.parse(line));
    if (frame.type === 'failure') {
      if (this.failures.length >= 32) throw new RemoteProtocolError('protocol_failed');
      this.failures.push(frame.code);
      return [];
    }
    if (frame.type === 'cleaned') {
      if (
        frame.operationId !== this.expected.operationId ||
        frame.remoteUser !== this.expected.remoteUser ||
        frame.operationRoot !== this.expected.operationRoot
      )
        throw new RemoteProtocolError('protocol_failed');
      this.cleanup = frame;
      // Match ordinary process output: incomplete child UTF-8 ends with a replacement character.
      return (['stdout', 'stderr'] as const).flatMap((channel) => {
        const text = this.decoders[channel].end();
        return text ? [{ channel, text }] : [];
      });
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))
      throw new RemoteProtocolError('protocol_failed');
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.toString('base64') !== frame.data) throw new RemoteProtocolError('protocol_failed');
    this.bytes += bytes.length;
    if (this.bytes > this.maximum) throw new RemoteProtocolError('output_limit');
    const text = this.decoders[frame.channel].write(bytes);
    return text ? [{ channel: frame.channel, text }] : [];
  }
}
