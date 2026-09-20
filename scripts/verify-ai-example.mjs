import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { generateText } from './ai-text.mjs';

const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ path: request.url, authorization: request.headers.authorization, body });
  if (body.model === 'rejected-model') {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Invalid credentials', type: 'authentication_error' } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({ id: 'example', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Example response' }, finish_reason: null }] })}\n\n`,
  );
  if (body.model === 'held-model') return;
  response.end(
    `data: ${JSON.stringify({ id: 'example', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const selection = {
    provider: 'openai',
    model: 'example-model',
    credentials: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, compatibleApiKey: 'example-key' },
    prompt: 'Explain a leaf.',
    signal: globalThis.AbortSignal.timeout(10_000),
  };
  let text = '';
  for await (const chunk of generateText(selection)) text += chunk;
  assert.equal(text, 'Example response');
  assert.deepEqual(requests[0].body.messages, [{ role: 'user', content: 'Explain a leaf.' }]);
  assert.equal(requests[0].body.model, 'example-model');
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer example-key');
  await assert.rejects(async () => {
    for await (const chunk of generateText({ ...selection, model: 'rejected-model' }))
      assert.fail(`Rejected credentials produced output: ${chunk}`);
  });
  const controller = new globalThis.AbortController();
  const stream = generateText({ ...selection, model: 'held-model', signal: controller.signal });
  assert.equal((await stream.next()).value, 'Example response');
  controller.abort(new Error('Caller cancelled'));
  await assert.rejects(stream.next(), /cancel/i);
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
