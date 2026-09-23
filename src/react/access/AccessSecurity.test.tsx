// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessSecurity } from './AccessSecurity';

afterEach(() => vi.unstubAllGlobals());

const session = {
  principal: { id: 'owner', name: 'Owner', role: 'owner' },
  sessionId: 'current',
  expiresAt: Date.now() + 60_000,
};
function reads(url: string): Response {
  if (url.endsWith('/session')) return Response.json(session);
  if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
  if (url.endsWith('/passkeys')) return Response.json({ passkeys: [] });
  if (url.endsWith('/household-passkeys')) return Response.json({ passkeys: [] });
  if (url.endsWith('/sessions'))
    return Response.json({
      sessions: [
        { id: 'current', name: 'Browser', principalId: 'owner', expiresAt: session.expiresAt },
        { id: 'other', name: 'Another member device', principalId: 'member', expiresAt: session.expiresAt },
      ],
    });
  throw new Error(`Unexpected request: ${url}`);
}

describe('account security', () => {
  it('keeps recovery codes out of shared-password security screens', async () => {
    vi.stubGlobal('fetch', async (url: string) => reads(url));
    render(<AccessSecurity showRecoveryCodes={false} onSignInRequired={() => {}} />);
    await screen.findByText('This session');
    expect(screen.queryByText('Recovery codes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create recovery codes' })).toBeNull();
  });

  it('lets the selected household Admin rotate the one shared password', async () => {
    let signedOut = false;
    let rotated = false;
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url.endsWith('/session'))
        return Response.json({ principal: null, sessionId: 'current', expiresAt: session.expiresAt });
      if (url.endsWith('/authorize-owner')) return Response.json({ ok: true });
      if (url.endsWith('/configure-household')) {
        expect(JSON.parse(String(options.body))).toEqual({ password: 'one new shared password' });
        rotated = true;
        return Response.json({ ok: true });
      }
      return reads(url);
    });
    render(
      <AccessSecurity
        onSignInRequired={() => {
          signedOut = true;
        }}
      />,
    );
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'one new shared password' },
    });
    expect(screen.queryByText('Passkeys')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(rotated && signedOut).toBe(true));
  });

  it('shows only the current account sessions and signs in again after revoking this session', async () => {
    let signedOut = false;
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (!url.endsWith('/revoke-session')) return reads(url);
      const body = JSON.parse(String(options.body));
      if (body.id !== 'current') throw new Error('Wrong session revoked');
      return Response.json({ ok: true });
    });
    render(
      <AccessSecurity
        onSignInRequired={() => {
          signedOut = true;
        }}
      />,
    );
    await screen.findByText('This session');
    expect(screen.queryByText('Another member device')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signedOut).toBe(true));
  });

  it('preserves a confirmed password change when the session refresh fails', async () => {
    let changed = false;
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url.endsWith('/change-password')) {
        expect(JSON.parse(String(options.body))).toEqual({ password: 'new private password' });
        changed = true;
        return Response.json(session);
      }
      if (changed && url.endsWith('/session'))
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      return reads(url);
    });
    render(<AccessSecurity copy={{ signIn: 'Enter again' }} onSignInRequired={() => {}} />);
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'new private password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Your change was saved');
    expect(screen.getByRole('button', { name: 'Enter again' })).toBeTruthy();
    expect(screen.queryByDisplayValue('new private password')).toBeNull();
  });

  it('hides recovery codes on request and clears them when the instance endpoint changes', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/recovery-codes') ? Response.json({ codes: ['private-recovery-code'] }) : reads(url),
    );
    const view = render(<AccessSecurity onSignInRequired={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create recovery codes' }));
    await screen.findByText('private-recovery-code');
    fireEvent.click(screen.getByRole('button', { name: 'Hide codes' }));
    expect(screen.queryByText('private-recovery-code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create recovery codes' }));
    await screen.findByText('private-recovery-code');
    view.rerender(<AccessSecurity endpoint="/another/access" onSignInRequired={() => {}} />);
    await screen.findByText('This session');
    expect(screen.queryByText('private-recovery-code')).toBeNull();
  });
});
