import { expect, it } from 'vitest';
import { modelPresets, modelSuggestions } from '../../src/ai/configuration/catalog';

it('offers Standard Muse without silently enrolling callers in Contributor training', () => {
  expect(modelPresets('meta')).toEqual([
    expect.objectContaining({
      id: 'muse-spark-1.3',
      contextWindow: 1048576,
      maxOutputTokens: null,
      pricing: { inputPerMTok: 1.25, outputPerMTok: 4.25 },
    }),
  ]);
  expect(modelSuggestions('meta')).toEqual(['muse-spark-1.3']);
});

it('isolates consumer pricing enrichment and model ordering', () => {
  const original = modelPresets('groq');
  const consumer = modelPresets('groq');
  consumer[0]!.pricing!.inputPerMTok = 999;
  consumer.reverse();
  consumer.pop();
  expect(modelPresets('groq')).toEqual(original);
});

it('distinguishes discovery-only presets from an unknown provider', () => {
  expect(modelPresets('codex')).toEqual([]);
  expect(() => modelPresets('unconfigured-provider')).toThrow('Unknown model preset provider');
});

it('offers current OpenAI models to document assistants and Codex', () => {
  const current = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
  for (const provider of ['openai', 'codex'])
    expect(modelSuggestions(provider, 'document')).toEqual(expect.arrayContaining(current));
  expect(modelPresets('openai')).toEqual(
    expect.arrayContaining(
      current.map((id) =>
        expect.objectContaining({
          id,
          contextWindow: 1050000,
          maxOutputTokens: 128000,
          isReasoning: true,
        }),
      ),
    ),
  );
});

it('offers current Claude API models while keeping CLI moving aliases', () => {
  const current = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  expect(modelSuggestions('anthropic', 'document')).toEqual(expect.arrayContaining(current));
  expect(modelSuggestions('claude-code', 'document')).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  expect(modelPresets('anthropic')).toEqual(
    expect.arrayContaining(
      current.map((id) => expect.objectContaining({ id, contextWindow: 1000000, maxOutputTokens: 128000 })),
    ),
  );
});

it('keeps document suggestions independent of extraction defaults and caller mutation', () => {
  const extraction = modelSuggestions('openai');
  const document = modelSuggestions('openai', 'document');
  expect(extraction).toEqual(['gpt-4.1-mini']);
  expect(modelSuggestions('anthropic')).toContain('claude-sonnet-4-6');
  expect(document).toEqual(expect.arrayContaining(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']));
  document.length = 0;
  expect(modelSuggestions('openai', 'document')).toContain('gpt-6.1-sol');
  expect(modelSuggestions('openai')).toEqual(extraction);
});
