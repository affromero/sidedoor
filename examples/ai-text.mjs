import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ProviderRegistry } from 'thesidedoor-core/ai';
import { apiProviders } from 'thesidedoor-core/ai/providers';

/** The caller supplies one authorized provider selection and owns cancellation. */
export async function* generateText({ provider, model, credentials, prompt, signal }) {
  if (!provider || !model || !prompt?.trim()) throw new Error('Provider, model and prompt are required');
  const captured = { ...credentials };
  const registry = new ProviderRegistry({
    providers: apiProviders(),
    credentials: {
      async resolve(selected) {
        if (selected !== provider) throw new Error('Provider is not configured');
        return { ...captured };
      },
    },
  });
  for await (const event of registry.generate({
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal,
    timeoutMs: 60_000,
    maxOutputTokens: 512,
  })) {
    if (event.type === 'text') yield event.text;
  }
}

async function main() {
  const provider = process.env.SIDEDOOR_AI_PROVIDER;
  const model = process.env.SIDEDOOR_AI_MODEL;
  const apiKey = process.env.SIDEDOOR_AI_API_KEY;
  if (!provider || !model || !apiKey) {
    throw new Error('Supply SIDEDOOR_AI_PROVIDER, SIDEDOOR_AI_MODEL and SIDEDOOR_AI_API_KEY');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Cancelled by operator'));
  process.once('SIGINT', cancel);
  try {
    for await (const text of generateText({
      provider,
      model,
      credentials: { apiKey },
      prompt: process.argv.slice(2).join(' '),
      signal: controller.signal,
    }))
      process.stdout.write(text);
    process.stdout.write('\n');
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
