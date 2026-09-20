import { describe, expect, it } from 'vitest';
import { AccessClient } from '../src/access/browser';

describe('browser access client', () => {
  it.each([{}, [], { principal: {}, expiresAt: 100 }, { principal: null, expiresAt: 'tomorrow' }])(
    'rejects malformed sessions without treating them as authenticated',
    async (value) => {
      const client = new AccessClient({ fetch: async () => Response.json(value) });
      await expect(client.login('Owner', 'password')).rejects.toMatchObject({ code: 'invalid_response' });
      await expect(client.recover('code', 'replacement password')).rejects.toMatchObject({
        code: 'outcome_unknown',
      });
    },
  );

  it('retains uncertainty when a successful credential response cannot be read', async () => {
    const client = new AccessClient({ fetch: async () => new Response('{', { status: 200 }) });
    await expect(client.recover('code', 'replacement password')).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses endpoints that could send credentials outside the current application origin', () => {
    for (const endpoint of [
      'https://attacker.example',
      '//attacker.example',
      '/\\attacker.example',
      '/api/access?redirect=https://attacker.example',
      '/api/../redirect',
    ])
      expect(() => new AccessClient({ endpoint })).toThrow(/same-origin/);
  });

  it('sends credentials only in a same-origin non-redirecting request body', async () => {
    const client = new AccessClient({
      fetch: async (url, options) => {
        expect(String(url)).toBe('/api/access/login');
        expect(options).toMatchObject({
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          method: 'POST',
        });
        expect(JSON.parse(String(options?.body))).toEqual({ name: 'Owner', password: 'private password' });
        return Response.json({ principal: { id: 'owner', name: 'Owner', role: 'owner' }, expiresAt: 123 });
      },
    });
    expect((await client.login('Owner', 'private password')).principal?.role).toBe('owner');
  });

  it('reports uncertain credential changes separately from a failed login transport', async () => {
    const client = new AccessClient({
      fetch: async () => {
        throw new TypeError('connection lost');
      },
    });
    await expect(client.recover('private-code', 'private replacement')).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    await expect(client.login('Owner', 'private password')).rejects.toMatchObject({ code: 'network_error' });
  });
});
