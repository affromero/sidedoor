import { expect, it } from 'vitest';
import { providerDescriptors } from '../../../src/ai/configuration/catalog';
import { providerCredentials, providerIdentity } from '../../../src/providers/catalog';
import {
  ClaudeOutputDecoder,
  CodexOutputDecoder,
  type CliOutputEvent,
} from '../../../src/runtime/process/cli';

const line = (value: unknown) => JSON.stringify(value) + '\n';
const text = (events: readonly CliOutputEvent[]) =>
  events
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('');

it.each([
  ['claude-code', 'Claude Code (CLI)'],
  ['codex', 'Codex (CLI)'],
])('declares %s as a keyless subscription CLI provider', (id, label) => {
  expect(providerIdentity(id)).toMatchObject({ label, modalities: ['text'] });
  expect(providerCredentials(id, 'text')).toMatchObject({ fields: [], configurationFields: [] });
  expect(providerDescriptors().find((provider) => provider.id === id)).toMatchObject({
    id,
    transport: 'cli',
    fields: [],
    capabilities: expect.arrayContaining(['text', 'vision', 'structured', 'web']),
  });
});

it('normalizes Codex subscription output and terminal usage', () => {
  const decoder = new CodexOutputDecoder();
  const events = [
    ...decoder.push(
      line({
        type: 'item.completed',
        item: { id: 'answer-1', type: 'agent_message', text: 'Codex answer' },
      }) +
        line({
          type: 'turn.completed',
          usage: {
            input_tokens: 90,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          },
        }),
    ),
    ...decoder.finish(),
  ];
  expect(text(events)).toBe('Codex answer');
  expect(events.at(-1)).toEqual({
    type: 'usage',
    usage: {
      inputTokens: 90,
      outputTokens: 20,
      cachedInputTokens: 40,
      cacheWriteTokens: null,
      reasoningTokens: 5,
    },
  });
});

it('normalizes Claude Code subscription output and terminal usage', () => {
  const decoder = new ClaudeOutputDecoder();
  const events = [
    ...decoder.push(
      line({
        type: 'assistant',
        message: { id: 'answer-1', content: [{ type: 'text', text: 'Claude answer' }] },
      }) +
        line({
          type: 'result',
          result: 'Claude answer',
          usage: {
            input_tokens: 60,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 10,
            output_tokens: 15,
          },
        }),
    ),
    ...decoder.finish(),
  ];
  expect(text(events)).toBe('Claude answer');
  expect(events.at(-1)).toEqual({
    type: 'usage',
    usage: {
      inputTokens: 95,
      outputTokens: 15,
      cachedInputTokens: 25,
      cacheWriteTokens: 10,
      reasoningTokens: null,
    },
  });
});
