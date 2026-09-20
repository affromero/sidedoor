import { expect, it } from 'vitest';
import { ClaudeOutputDecoder, CliProtocolError, type CliOutputEvent } from '../src/runtime/cli';

const line = (value: unknown) => JSON.stringify(value) + '\n';
const partial = (event: unknown) => ({ type: 'stream_event', event });
const summary = (id: string, ...texts: string[]) => ({
  type: 'assistant',
  message: { id, content: texts.map((text) => ({ type: 'text', text })) },
});
const completed = {
  type: 'result',
  result: 'repeated final answer',
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
    output_tokens: 7,
  },
};
const content = (events: CliOutputEvent[]) =>
  events
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('');

it('binds anonymous partial output to its identified assistant summary', () => {
  const decoder = new ClaudeOutputDecoder();
  expect(
    content([
      ...decoder.push(
        [
          partial({ type: 'content_block_delta', delta: { text: 'first' } }),
          summary('identified', 'first'),
          summary('later', 'second'),
          completed,
        ]
          .map(line)
          .join(''),
      ),
      ...decoder.finish(),
    ]),
  ).toBe('firstsecond');
});

it('rejects tool blocks relabeled as answer text by a summary or repeated start', () => {
  const start = partial({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } });
  for (const conflict of [
    summary('identified', 'secret'),
    partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'secret' } }),
  ]) {
    expect(() => [...new ClaudeOutputDecoder().push(line(start) + line(conflict))]).toThrow(CliProtocolError);
  }
});

it('preserves mixed streamed and assistant-only messages across every transport split', () => {
  const wire = [
    partial({ type: 'message_start', message: { id: 'first' } }),
    partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello 🌎' } }),
    partial({ type: 'message_stop' }),
    summary('first', 'Hello 🌎', ' second block'),
    summary('first', 'Hello 🌎', ' second block'),
    summary('second', ' later answer'),
    completed,
  ]
    .map(line)
    .join('')
    .trimEnd();
  for (let split = 0; split <= wire.length; split++) {
    const decoder = new ClaudeOutputDecoder();
    const events = [
      ...decoder.push(wire.slice(0, split)),
      ...decoder.push(wire.slice(split)),
      ...decoder.finish(),
    ];
    expect(content(events)).toBe('Hello 🌎 second block later answer');
    expect(events.filter((event) => event.type === 'usage')).toMatchObject([
      { usage: { inputTokens: 35, outputTokens: 7, cachedInputTokens: 20, cacheWriteTokens: 5 } },
    ]);
  }
});

it('excludes tool and thinking blocks even when they carry text-shaped deltas', () => {
  const decoder = new ClaudeOutputDecoder();
  const events = [
    ...decoder.push(
      [
        partial({ type: 'message_start', message: { id: 'first' } }),
        partial({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', text: 'secret' },
        }),
        partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'secret' } }),
        partial({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', text: 'secret' } }),
        {
          type: 'assistant',
          message: {
            id: 'first',
            content: [
              { type: 'tool_use', text: 'secret' },
              { type: 'text', text: 'answer' },
            ],
          },
        },
        completed,
      ]
        .map(line)
        .join(''),
    ),
    ...decoder.finish(),
  ];
  expect(content(events)).toBe('answer');
});

it('keeps result-only and assistant-only compatibility without invented measurements', () => {
  const result = new ClaudeOutputDecoder();
  expect([...result.push(line({ type: 'result', result: '  answer  ' })), ...result.finish()]).toEqual([
    { type: 'text', text: '  answer  ' },
  ]);
  const assistant = new ClaudeOutputDecoder();
  expect(content([...assistant.push(line(summary('first', 'answer'))), ...assistant.finish(false)])).toBe(
    'answer',
  );
  const missing = new ClaudeOutputDecoder();
  expect(() => [...missing.finish()]).toThrow('completion');
});

it('delivers failed terminal measurements before failure and drains an unterminated record', () => {
  const decoder = new ClaudeOutputDecoder();
  expect([
    ...decoder.push(JSON.stringify({ ...completed, is_error: true, errors: ['quota exceeded'] })),
  ]).toEqual([]);
  const events = [...decoder.finish(false)];
  expect(events).toMatchObject([
    { type: 'usage', usage: { inputTokens: 35 } },
    { type: 'failure', message: 'quota exceeded' },
  ]);
  expect(content(events)).toBe('');
});

it('rejects conflicting terminal and assistant records while retaining earlier usage', () => {
  const decoder = new ClaudeOutputDecoder();
  const observed: CliOutputEvent[] = [];
  expect(() => {
    for (const event of decoder.push(line(completed) + line(completed))) observed.push(event);
  }).toThrow(CliProtocolError);
  expect(observed[0]).toMatchObject({ type: 'usage', usage: { outputTokens: 7 } });
  expect(() => [
    ...new ClaudeOutputDecoder().push(line(summary('same', 'first')) + line(summary('same', 'different'))),
  ]).toThrow('Conflicting');
});

it('bounds records and never converts truncated structured data into an answer', () => {
  expect(() => [...new ClaudeOutputDecoder({ maximumLineChars: 4 }).push('12345')]).toThrow('limit');
  const decoder = new ClaudeOutputDecoder();
  expect([...decoder.push('{"type":"assistant"')]).toEqual([]);
  expect(() => [...decoder.finish(false)]).toThrow(CliProtocolError);
  expect(() => [...new ClaudeOutputDecoder().push('old answer\n')]).toThrow(CliProtocolError);
});
