import { expect, it } from 'vitest';
import { modelPresets, modelSuggestions } from '../src/ai/catalog';

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

it('keeps document suggestions independent of extraction defaults and caller mutation', () => {
  const extraction = modelSuggestions('openai');
  const document = modelSuggestions('openai', 'document');
  expect(extraction).toEqual(['gpt-4.1-mini']);
  expect(modelSuggestions('anthropic')).toContain('claude-sonnet-4-6');
  expect(document).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
  document.length = 0;
  expect(modelSuggestions('openai', 'document')).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
  expect(modelSuggestions('openai')).toEqual(extraction);
});
