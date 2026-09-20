import { expect, it } from 'vitest';
import { RemoteOutputDecoder } from '../../../src/runtime/remote/remote-output';

const expected = { operationId: 'a'.repeat(32), remoteUser: 'owner', operationRoot: '/private/operations' };
const cleaned = { type: 'cleaned', ...expected, exitCode: 0, containment: 'descendants' };
const line = (frame: unknown) => JSON.stringify(frame) + '\n';
const data = (bytes: Uint8Array, channel = 'stdout') =>
  line({ type: 'data', channel, data: Buffer.from(bytes).toString('base64') });

it('keeps transport diagnostics separate from child stderr', () => {
  const decoder = new RemoteOutputDecoder(expected);
  expect(decoder.push({ channel: 'stderr', text: 'SSH warning' })).toEqual([
    { channel: 'transport-stderr', text: 'SSH warning' },
  ]);
  expect(decoder.push({ channel: 'stdout', text: data(Buffer.from('agent warning'), 'stderr') })).toEqual([
    { channel: 'stderr', text: 'agent warning' },
  ]);
});

it('preserves child multibyte output across every transport boundary and separately decodes channels', () => {
  const bytes = Buffer.from('hello 🌍');
  const wire =
    data(bytes.subarray(0, 8)) +
    data(Buffer.from('diagnostic'), 'stderr') +
    data(bytes.subarray(8)) +
    line(cleaned);
  for (let split = 0; split <= wire.length; split++) {
    const decoder = new RemoteOutputDecoder(expected);
    const chunks = [
      ...decoder.push({ channel: 'stdout', text: wire.slice(0, split) }),
      ...decoder.push({ channel: 'stdout', text: wire.slice(split) }),
    ];
    expect(
      chunks
        .filter((chunk) => chunk.channel === 'stdout')
        .map((chunk) => chunk.text)
        .join(''),
    ).toBe('hello 🌍');
    expect(
      chunks
        .filter((chunk) => chunk.channel === 'stderr')
        .map((chunk) => chunk.text)
        .join(''),
    ).toBe('diagnostic');
    expect(decoder.finish({})).toMatchObject({ cleanup: cleaned, failures: [] });
  }
});

it('preserves execution and transport failures alongside confirmed cleanup', () => {
  const decoder = new RemoteOutputDecoder(expected);
  decoder.push({
    channel: 'stdout',
    text: line({ type: 'failure', code: 'timeout' }) + line({ ...cleaned, exitCode: 1 }),
  });
  const failure = new Error('transport exit failed');
  const outcome = decoder.finish({ error: failure });
  expect(outcome).toMatchObject({ cleanup: { exitCode: 1 }, failures: ['timeout'] });
  expect(outcome.transportError).toBe(failure);
});

it.each(['%%%', 'YQ', 'YR==', 'YQ===', 'YQ==\n'])('rejects noncanonical base64 %s', (encoded) => {
  const decoder = new RemoteOutputDecoder(expected);
  expect(() =>
    decoder.push({ channel: 'stdout', text: line({ type: 'data', channel: 'stdout', data: encoded }) }),
  ).toThrow();
  expect(() => decoder.finish({})).toThrow();
});

it.each([line(cleaned), 'garbage\n', line({ type: 'data', channel: 'stdout', data: 'YQ==' })])(
  'invalidates a receipt when more stdout follows it',
  (trailing) => {
    const decoder = new RemoteOutputDecoder(expected);
    decoder.push({ channel: 'stdout', text: line(cleaned) });
    expect(() => decoder.push({ channel: 'stdout', text: trailing })).toThrow();
    expect(() => decoder.finish({})).toThrow();
  },
);

it('rejects truncated frames and non-ASCII protocol encoding', () => {
  const truncated = new RemoteOutputDecoder(expected);
  truncated.push({ channel: 'stdout', text: line(cleaned).slice(0, -1) });
  expect(() => truncated.finish({})).toThrow();
  const invalid = new RemoteOutputDecoder(expected);
  expect(() => invalid.push({ channel: 'stdout', text: '\ufffd' })).toThrow();
});

it('bounds protocol lines, decoded output, and raw transport diagnostics independently', () => {
  const oversized = new RemoteOutputDecoder(expected);
  expect(() => oversized.push({ channel: 'stdout', text: ' '.repeat(65537) })).toThrow();
  const output = new RemoteOutputDecoder({ ...expected, maxOutputBytes: 2 });
  expect(() => output.push({ channel: 'stdout', text: data(Buffer.from('abc')) })).toThrow('output_limit');
  const diagnostics = new RemoteOutputDecoder({ ...expected, maxDiagnosticBytes: 2 });
  expect(() => diagnostics.push({ channel: 'stderr', text: 'abc' })).toThrow('output_limit');
});

it('does not manufacture confirmation when stdout ends without a cleanup frame', () => {
  const decoder = new RemoteOutputDecoder(expected);
  decoder.push({ channel: 'stdout', text: data(Buffer.from('answer')) });
  expect(decoder.finish({}).cleanup).toBeUndefined();
});

it.each([{ remoteUser: 'other' }, { operationRoot: '/other/root' }, { operationId: 'b'.repeat(32) }])(
  'rejects cleanup for another location or operation',
  (changed) => {
    const decoder = new RemoteOutputDecoder(expected);
    expect(() => decoder.push({ channel: 'stdout', text: line({ ...cleaned, ...changed }) })).toThrow();
  },
);
