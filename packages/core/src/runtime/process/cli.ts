import type { TokenUsage } from '../../ai/index';
import { cliTokenUsage } from '../../ai/usage';

export type CliOutputEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'failure'; message: string };

export class CliProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliProtocolError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class CliLines {
  private buffer = '';
  private finished = false;
  constructor(private readonly maximumLineChars: number) {
    if (!Number.isSafeInteger(maximumLineChars) || maximumLineChars < 1)
      throw new Error('Invalid CLI line limit');
  }

  *push(text: string): Generator<string> {
    if (this.finished) throw new CliProtocolError('CLI output already finished');
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      if (this.buffer.length + end - start > this.maximumLineChars)
        throw new CliProtocolError('CLI output record exceeds limit');
      this.buffer += text.slice(start, end);
      if (newline < 0) break;
      const line = this.buffer;
      this.buffer = '';
      yield line;
      start = newline + 1;
    }
  }

  finish(): string {
    if (this.finished) throw new CliProtocolError('CLI output already finished');
    this.finished = true;
    const output = this.buffer;
    this.buffer = '';
    return output;
  }
}

/** Decodes Codex exec --json without exposing tool output or reasoning as answer text. */
export class CodexOutputDecoder {
  private readonly lines: CliLines;
  private terminal = false;
  private readonly messages = new Set<string>();
  constructor(maximumLineChars = 16 * 1024 * 1024) {
    this.lines = new CliLines(maximumLineChars);
  }

  *push(text: string): Generator<CliOutputEvent> {
    for (const line of this.lines.push(text)) yield* this.decode(line);
  }

  /** On transport failure drain measurements with requireTerminal=false, then preserve that failure. */
  *finish(requireTerminal = true): Generator<CliOutputEvent> {
    yield* this.decode(this.lines.finish());
    if (requireTerminal && !this.terminal) throw new CliProtocolError('CLI completion record is missing');
  }

  private decode(line: string): CliOutputEvent[] {
    if (!line.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new CliProtocolError(
        error instanceof SyntaxError ? 'Malformed CLI JSON record' : 'Invalid CLI record',
      );
    }
    const event = object(value);
    if (!event || typeof event.type !== 'string') throw new CliProtocolError('Invalid CLI event');
    if (this.terminal) throw new CliProtocolError('CLI output follows completion');
    if (event.type === 'turn.completed') {
      const usage = cliTokenUsage('codex', event);
      if (!usage) throw new CliProtocolError('Invalid CLI completion usage');
      this.terminal = true;
      return [{ type: 'usage', usage }];
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      this.terminal = event.type === 'turn.failed';
      const message = event.type === 'error' ? event.message : object(event.error)?.message;
      if (typeof message !== 'string') throw new CliProtocolError('Invalid CLI error event');
      return [{ type: 'failure', message: message.slice(-4096) }];
    }
    const item = object(event.item);
    if (
      event.type === 'item.completed' &&
      (!item || typeof item.type !== 'string' || typeof item.id !== 'string' || !item.id)
    )
      throw new CliProtocolError('Invalid CLI completed item');
    if (event.type !== 'item.completed' || item?.type !== 'agent_message') return [];
    if (typeof item.id !== 'string' || !item.id || typeof item.text !== 'string')
      throw new CliProtocolError('Invalid CLI assistant message');
    if (this.messages.has(item.id)) throw new CliProtocolError('Duplicate CLI assistant message');
    if (this.messages.size >= 10000) throw new CliProtocolError('Too many CLI assistant messages');
    this.messages.add(item.id);
    return item.text ? [{ type: 'text', text: item.text }] : [];
  }
}

interface ClaudeMessage {
  id?: string;
  blocks: Map<number, string>;
  excludedBlocks: Set<number>;
  summarized: boolean;
}

export interface ClaudeOutputOptions {
  maximumLineChars?: number;
}

/** Claude stream-json answers, deduplicated per message and text block. */
export class ClaudeOutputDecoder {
  private readonly lines: CliLines;
  private readonly messages = new Map<string, ClaudeMessage>();
  private active: ClaudeMessage | undefined;
  private terminal = false;
  private produced = false;
  constructor(private readonly options: ClaudeOutputOptions = {}) {
    this.lines = new CliLines(options.maximumLineChars ?? 16 * 1024 * 1024);
  }

  *push(text: string): Generator<CliOutputEvent> {
    for (const line of this.lines.push(text)) yield* this.decode(line);
  }

  *finish(requireTerminal = true): Generator<CliOutputEvent> {
    yield* this.decode(this.lines.finish());
    if (requireTerminal && !this.terminal) throw new CliProtocolError('CLI completion record is missing');
  }

  private *decode(line: string): Generator<CliOutputEvent> {
    if (!line.trim()) return;
    if (this.terminal) throw new CliProtocolError('CLI output follows completion');
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CliProtocolError('Malformed CLI JSON record');
    }
    const envelope = object(value);
    // Older CLI wrappers emitted unrelated JSON values between protocol events.
    if (!envelope) return;
    const event = envelope.type === 'stream_event' ? object(envelope.event) : envelope;
    if (!event || typeof event.type !== 'string') throw new CliProtocolError('Invalid CLI event');
    if (event.type === 'result') {
      this.terminal = true;
      const usage = cliTokenUsage('claude-code', event);
      if (usage) yield { type: 'usage', usage };
      if (
        event.is_error === true ||
        (typeof event.subtype === 'string' && event.subtype.startsWith('error_'))
      ) {
        const errors = Array.isArray(event.errors)
          ? event.errors.filter((error): error is string => typeof error === 'string').join('\n')
          : '';
        yield {
          type: 'failure',
          message: (
            errors ||
            (typeof event.result === 'string' ? event.result : '') ||
            'Claude execution failed'
          ).slice(-4096),
        };
        return;
      }
      if (!this.produced && typeof event.result === 'string') yield* this.text(event.result);
      return;
    }
    if (event.type === 'message_start') {
      this.active = this.message(object(event.message)?.id);
      return;
    }
    if (event.type === 'content_block_start') {
      const block = object(event.content_block);
      const message = (this.active ??= this.message(undefined));
      const index = this.index(event.index);
      if (message.blocks.has(index) || message.excludedBlocks.has(index))
        throw new CliProtocolError('Duplicate CLI content block');
      if (block?.type !== 'text') {
        message.excludedBlocks.add(index);
        return;
      }
      if (block?.type === 'text' && typeof block.text === 'string') {
        message.blocks.set(index, block.text);
        yield* this.text(block.text);
      }
      return;
    }
    if (event.type === 'content_block_delta') {
      const delta = object(event.delta);
      if (!delta || (delta.type !== undefined && delta.type !== 'text_delta')) return;
      if (typeof delta.text !== 'string') return;
      const message = (this.active ??= this.message(undefined));
      const index = this.index(event.index ?? 0);
      if (message.excludedBlocks.has(index)) return;
      message.blocks.set(index, (message.blocks.get(index) ?? '') + delta.text);
      yield* this.text(delta.text);
      return;
    }
    if (event.type !== 'assistant') return;
    const body = object(event.message);
    const blocks = body?.content ?? event.content;
    if (!Array.isArray(blocks)) return;
    const id = body?.id;
    if (
      typeof id === 'string' &&
      id &&
      !this.messages.has(id) &&
      this.active &&
      !this.active.id &&
      !this.active.summarized
    )
      this.identify(id, this.active);
    const message =
      typeof id === 'string'
        ? (this.messages.get(id) ?? this.message(id))
        : this.active && !this.active.summarized
          ? this.active
          : this.message(undefined);
    for (const [index, value] of blocks.entries()) {
      const block = object(value);
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      if (message.excludedBlocks.has(index)) throw new CliProtocolError('Conflicting CLI block type');
      const previous = message.blocks.get(index) ?? '';
      if (!block.text.startsWith(previous)) throw new CliProtocolError('Conflicting CLI assistant text');
      if (message.summarized && block.text !== previous)
        throw new CliProtocolError('Conflicting CLI assistant summary');
      message.blocks.set(index, block.text);
      yield* this.text(block.text.slice(previous.length));
    }
    message.summarized = true;
    if (this.active === message) this.active = undefined;
  }

  private message(id: unknown): ClaudeMessage {
    const message = {
      blocks: new Map<number, string>(),
      excludedBlocks: new Set<number>(),
      summarized: false,
    };
    if (typeof id === 'string' && id) {
      this.identify(id, message);
    }
    return message;
  }

  private identify(id: string, message: ClaudeMessage): void {
    if (this.messages.has(id)) throw new CliProtocolError('Duplicate CLI message start');
    if (this.messages.size >= 10000) throw new CliProtocolError('Too many CLI messages');
    message.id = id;
    this.messages.set(id, message);
  }

  private index(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= 10000)
      throw new CliProtocolError('Invalid CLI block index');
    return value;
  }

  private *text(text: string): Generator<CliOutputEvent> {
    if (!text) return;
    this.produced = true;
    yield { type: 'text', text };
  }
}
