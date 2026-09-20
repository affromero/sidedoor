import { expect, it } from 'vitest';
import { CodexOutputDecoder, CliProtocolError, type CliOutputEvent } from '../src/runtime/cli';

const answer = { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Hello 🌎' } };
const completed = {
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 },
};
const line = (value: unknown) => JSON.stringify(value) + '\n';

it('preserves answers and terminal usage across every transport split', () => {
  const wire =
    line({
      type: 'item.completed',
      item: { id: 'tool', type: 'command_execution', aggregated_output: 'private command output' },
    }) +
    line(answer) +
    JSON.stringify(completed);
  for (let split = 0; split <= wire.length; split++) {
    const decoder = new CodexOutputDecoder();
    const events = [
      ...decoder.push(wire.slice(0, split)),
      ...decoder.push(wire.slice(split)),
      ...decoder.finish(),
    ];
    expect(events).toEqual([
      { type: 'text', text: 'Hello 🌎' },
      {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 30,
          cachedInputTokens: 20,
          cacheWriteTokens: null,
          reasoningTokens: null,
        },
      },
    ]);
  }
});

it('accepts a completed answer larger than one megabyte while enforcing the configured record limit', () => {
  const text = 'x'.repeat(2 * 1024 * 1024);
  const wire = line({ ...answer, item: { ...answer.item, text } }) + line(completed);
  const decoder = new CodexOutputDecoder();
  expect([...decoder.push(wire), ...decoder.finish()][0]).toEqual({ type: 'text', text });
  expect(() => [...new CodexOutputDecoder(128).push(wire)]).toThrow(CliProtocolError);
});

it('preserves actionable JSON failures without emitting tool payloads', () => {
  const decoder = new CodexOutputDecoder();
  expect([
    ...decoder.push(
      line({ type: 'error', message: 'usage limit reached' }) +
        line({ type: 'turn.failed', error: { message: 'quota exceeded' } }),
    ),
    ...decoder.finish(),
  ]).toEqual([
    { type: 'failure', message: 'usage limit reached' },
    { type: 'failure', message: 'quota exceeded' },
  ]);
});

it('delivers measured usage before rejecting malformed trailing output', () => {
  const decoder = new CodexOutputDecoder();
  const events: CliOutputEvent[] = [];
  expect(() => {
    for (const event of decoder.push(line(completed) + 'invalid\n')) events.push(event);
  }).toThrow(CliProtocolError);
  expect(events).toMatchObject([{ type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } }]);
});

it('requires completion on success but allows draining a failed transport', () => {
  const missing = new CodexOutputDecoder();
  expect([...missing.push(line(answer))]).toEqual([{ type: 'text', text: answer.item.text }]);
  expect(() => [...missing.finish()]).toThrow('completion');
  const failed = new CodexOutputDecoder();
  expect([...failed.push(JSON.stringify(completed))]).toEqual([]);
  expect([...failed.finish(false)]).toMatchObject([{ type: 'usage', usage: { inputTokens: 100 } }]);
});

it('rejects malformed known events, duplicate answers and conflicting completion', () => {
  for (const wire of [
    line({ type: 'item.completed' }),
    line({ type: 'item.completed', item: [] }),
    line(null),
    line({ type: 'turn.completed' }),
    line({ type: 'turn.failed' }),
    line({ ...answer, item: { type: 'agent_message', text: 'missing identity' } }),
    line(answer) + line(answer),
    line(completed) + line(completed),
  ]) {
    expect(() => [...new CodexOutputDecoder().push(wire)]).toThrow(CliProtocolError);
  }
});
