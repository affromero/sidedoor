import { describe, expect, it } from 'vitest';
import { isLocalHost, isPrivateReachUrl, resolveReachUrl } from './resolveReachUrl';

describe('resolveReachUrl', () => {
  it('prefers a configured URL over any header and strips trailing slashes', () => {
    const url = resolveReachUrl({
      configuredUrl: 'https://myapp.tail1234.ts.net:3000///',
      headers: new Headers({ host: 'localhost:3000' }),
    });
    expect(url).toBe('https://myapp.tail1234.ts.net:3000');
  });

  it('ignores a blank configured URL and falls back to headers', () => {
    const url = resolveReachUrl({
      configuredUrl: '   ',
      headers: new Headers({ host: 'box.example.com' }),
    });
    expect(url).toBe('https://box.example.com');
  });

  it('derives the origin from a web Headers object', () => {
    const url = resolveReachUrl({ headers: new Headers({ host: 'box.example.com' }) });
    expect(url).toBe('https://box.example.com');
  });

  it('honours x-forwarded-host and x-forwarded-proto from a reverse proxy', () => {
    const url = resolveReachUrl({
      headers: new Headers({
        host: 'internal:3000',
        'x-forwarded-host': 'app.example.com',
        'x-forwarded-proto': 'https',
      }),
    });
    expect(url).toBe('https://app.example.com');
  });

  it('takes the first value from a comma separated x-forwarded-proto', () => {
    const url = resolveReachUrl({
      headers: new Headers({ host: 'app.example.com', 'x-forwarded-proto': 'https, http' }),
    });
    expect(url).toBe('https://app.example.com');
  });

  it('reads a Node style headers record case insensitively', () => {
    const url = resolveReachUrl({
      headers: { Host: 'app.example.com', 'X-Forwarded-Proto': 'https' },
    });
    expect(url).toBe('https://app.example.com');
  });

  it('takes the first entry when a Node header is an array', () => {
    const url = resolveReachUrl({
      headers: { host: ['app.example.com', 'second.example.com'] },
    });
    expect(url).toBe('https://app.example.com');
  });

  it('accepts a getter function as the header source', () => {
    const headers = (name: string) => (name === 'host' ? 'app.example.com' : null);
    expect(resolveReachUrl({ headers })).toBe('https://app.example.com');
  });

  it('defaults a localhost origin to http, not https', () => {
    expect(resolveReachUrl({ headers: new Headers({ host: 'localhost:3000' }) })).toBe(
      'http://localhost:3000',
    );
  });

  it('uses defaultHost when no host header is present', () => {
    expect(resolveReachUrl({ defaultHost: 'box.local:3000' })).toBe('http://box.local:3000');
  });

  it('falls back to http://localhost with no input at all', () => {
    expect(resolveReachUrl()).toBe('http://localhost');
  });
});

describe('isLocalHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '[::1]:3000',
    'box.local',
    'localhost:3000',
    'box.LOCAL',
  ])('treats %s as local', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(['app.example.com', '10.0.0.4', 'myapp.tail1234.ts.net'])('treats %s as not local', (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});

describe('isPrivateReachUrl', () => {
  it.each([
    'http://localhost:3000',
    'https://myapp.tail1234.ts.net',
    'http://10.0.0.4:3000',
    'http://192.168.1.20:3000',
    'http://172.16.0.5:3000',
    'http://172.31.255.255:3000',
  ])('treats %s as private', (url) => {
    expect(isPrivateReachUrl(url)).toBe(true);
  });

  it.each([
    'https://app.example.com',
    'http://172.32.0.1:3000', // just outside the 172.16/12 private block
    'http://8.8.8.8',
  ])('treats %s as public', (url) => {
    expect(isPrivateReachUrl(url)).toBe(false);
  });

  it('returns false for a string that is not a URL', () => {
    expect(isPrivateReachUrl('not a url')).toBe(false);
  });
});
