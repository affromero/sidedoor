import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessRunner } from '../../src/runtime/process/process';
import { startCredentialBroker } from '../../src/runtime/credential-broker';

describe.skipIf(process.env.SIDEDOOR_CLAUDE_PROTOCOL !== '1')('pinned Claude API protocol', () => {
  it('runs Claude 2.1.283 with synthetic API auth through the broker text stream', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidedoor-cli-fixture-'));
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
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello fixture.' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ];
    const broker = await startCredentialBroker({
      executionId: 'fixture',
      protocol: 'anthropic-messages',
      endpoint: 'https://api.example.test/v1/messages',
      model,
      credential: 'parent-only-synthetic-credential',
      expiresAt: Date.now() + 30_000,
      maxOutputTokens: 128,
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4096,
      maxConcurrentRequests: 1,
      requestTimeoutMs: 10_000,
      admit: async () => {},
      fetch: async () =>
        new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const server = createServer((incoming, outgoing) => {
      if (incoming.url === '/api/hello') {
        outgoing.end('{}');
        return;
      }
      if (incoming.url !== '/v1/messages?beta=true') {
        outgoing.writeHead(403);
        outgoing.end();
        return;
      }
      const forwarded = request(
        {
          socketPath: broker.socketPath,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}` },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 500, {
            'content-type': response.headers['content-type'] ?? 'application/json',
          });
          response.pipe(outgoing);
        },
      );
      forwarded.on('error', () => outgoing.destroy());
      incoming.pipe(forwarded);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      const environment = {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: 'child-synthetic-placeholder',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128',
        MAX_THINKING_TOKENS: '0',
      };
      let version = '';
      for await (const chunk of new ProcessRunner().stream({
        command: 'claude',
        args: ['--version'],
        environment,
        cwd: home,
      }))
        version += chunk.text;
      expect(version).toContain('2.1.283');
      let output = '';
      for await (const chunk of new ProcessRunner().stream({
        command: 'claude',
        args: [
          '--bare',
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
        environment,
        cwd: home,
        input: 'Say hello.',
        timeoutMs: 20_000,
        maxOutputBytes: 1024 * 1024,
      }))
        output += chunk.text;
      expect(output).toContain('Hello fixture.');
      expect(output).toContain('"subtype":"success"');
      expect(output).not.toContain('parent-only-synthetic-credential');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await broker.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
