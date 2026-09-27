import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { DockerIsolatedRunner } from '/test/isolated.cjs';
import { startCredentialBroker, isolatedClaudeRelay } from '/test/credential-broker.cjs';

const model = 'claude-sonnet-4-6';
const events = [
  {
    type: 'message_start',
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Linux broker fixture complete.' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
];
let admitted = false;
let cleaned = false;
const broker = await startCredentialBroker({
  executionId: 'linux-broker-probe',
  protocol: 'anthropic-messages',
  endpoint: 'https://api.example.test/v1/messages',
  model,
  credential: 'parent-only-synthetic-credential',
  expiresAt: Date.now() + 60_000,
  maxOutputTokens: 128,
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 4096,
  maxConcurrentRequests: 1,
  requestTimeoutMs: 30_000,
  admit: async () => {
    admitted = true;
  },
  fetch: async (_url, init) => {
    assert.equal(init.headers['x-api-key'], 'parent-only-synthetic-credential');
    return new globalThis.Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
try {
  let output = '';
  for await (const chunk of new DockerIsolatedRunner().stream({
    executionId: 'linux-broker-probe',
    image: process.env.AGENT_IMAGE,
    command: ['node', '-e', isolatedClaudeRelay],
    brokerDirectory: broker.directory,
    input: JSON.stringify({
      token: broker.token,
      prompt: 'Say hello.',
      maxOutputTokens: 128,
      args: [
        '-p',
        '--safe-mode',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--tools',
        '',
        '--permission-mode',
        'dontAsk',
        '--model',
        model,
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--system-prompt',
        'Respond briefly.',
      ],
    }),
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    memoryMb: 1024,
    cpus: 1,
    pids: 64,
    scratchMb: 64,
    recordIdentity: async (identity) => {
      assert.match(identity.containerName, /^sidedoor-/);
    },
    recordCleanup: async () => {
      cleaned = true;
    },
  }))
    output += chunk.text;
  assert.match(output, /Linux broker fixture complete/);
  assert.match(output, /"subtype":"success"/);
  assert.ok(!output.includes('parent-only-synthetic-credential'));
  assert.ok(admitted);
  assert.ok(cleaned);
  console.log(
    'PASS: pinned Linux Claude CLI, isolated relay, Unix broker, provider admission and verified cleanup',
  );
} finally {
  await broker.close();
}
