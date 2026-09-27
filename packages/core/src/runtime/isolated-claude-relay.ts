/** Public bootstrap for the reviewed Claude 2.1.283 text-only API protocol.
 * The application supplies { token, args, prompt, maxOutputTokens } on stdin.
 * A reviewed image must provide Node and the pinned claude executable.
 */
export const isolatedClaudeRelay = String.raw`
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
(async () => {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error('Bootstrap input limit');
  }
  const config = JSON.parse(input);
  const version = execFileSync('claude', ['--version'], {
    cwd: '/work', timeout: 10000, maxBuffer: 1024,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work', CLAUDE_CONFIG_DIR: '/work/.claude' },
  }).toString().trim();
  if (version !== '2.1.283 (Claude Code)') throw new Error('Unsupported Claude protocol version');
  const server = http.createServer((incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/api/hello') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end('{}');
      return;
    }
    if (incoming.method !== 'POST' || !['/v1/messages', '/v1/messages?beta=true'].includes(incoming.url)) {
      outgoing.writeHead(403); outgoing.end(); return;
    }
    const upstream = http.request({ socketPath: '/broker/broker.sock', path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token } }, (response) => {
        outgoing.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'application/json' });
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on('error', () => upstream.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const child = spawn('claude', ['--bare', ...config.args], {
    cwd: '/work',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work', CLAUDE_CONFIG_DIR: '/work/.claude',
      ANTHROPIC_API_KEY: 'isolated-execution-placeholder', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.maxOutputTokens),
      MAX_THINKING_TOKENS: '0' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.on('error', () => {});
  child.stdin.end(config.prompt);
  child.once('error', () => { server.closeAllConnections(); server.close(); process.exitCode = 1; });
  child.once('close', (code) => { server.closeAllConnections(); server.close(); process.exitCode = code === 0 ? 0 : 1; });
})().catch(() => { process.stderr.write('Isolated CLI bootstrap failed\n'); process.exitCode = 1; });
`;
