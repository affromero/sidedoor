// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessSecurity } from './AccessSecurity';
import { AccessForm } from './AccessForm';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

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
  it.each([false, true])(
    'saves a passkey without a name field and preserves admission on cancellation (%s)',
    async (cancelled) => {
      let admitted = false;
      let saved = false;
      let continued = false;
      let returning = false;
      vi.stubGlobal('PublicKeyCredential', class {});
      vi.stubGlobal(
        'navigator',
        Object.assign(Object.create(navigator), {
          credentials: {
            create: async () => {
              if (cancelled) throw new DOMException('Cancelled', 'NotAllowedError');
              return {
                id: 'mac-passkey',
                rawId: new Uint8Array([1]).buffer,
                type: 'public-key',
                response: {
                  attestationObject: new Uint8Array([1]).buffer,
                  clientDataJSON: new Uint8Array([1]).buffer,
                },
                getClientExtensionResults: () => ({}),
              };
            },
          },
        }),
      );
      vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
        if (url.endsWith('/session'))
          return returning
            ? Response.json({ error: 'unauthorized' }, { status: 401 })
            : Response.json({ ...session, principal: null });
        if (url.endsWith('/authorize-owner')) return Response.json({ ok: true });
        if (url.endsWith('/capabilities'))
          return Response.json({ password: true, passkeys: true, householdPasskeys: saved });
        if (url.endsWith('/household')) {
          expect(JSON.parse(String(options.body))).toEqual({ password: 'shared app password' });
          admitted = true;
          return Response.json({ ...session, principal: null });
        }
        if (url.endsWith('/household-register-options')) {
          expect(admitted).toBe(true);
          return Response.json({
            ceremony: 'challenge',
            options: {
              challenge: 'YWJj',
              rp: { id: 'private.example', name: 'Test' },
              user: { id: 'aA', name: 'Test', displayName: 'Test' },
              pubKeyCredParams: [],
            },
          });
        }
        if (url.endsWith('/register-household-passkey')) {
          expect(JSON.parse(String(options.body)).name).toBe('This device');
          saved = true;
          return Response.json({ ok: true });
        }
        return reads(url);
      });
      const view = render(
        <AccessSecurity
          showRecoveryCodes={false}
          onSignInRequired={() => {}}
          onHouseholdEntered={() => {
            continued = true;
          }}
        />,
      );
      const disclosure = await screen.findByText('Save a passkey', { selector: 'summary' });
      expect(disclosure.closest('details')?.open).toBe(false);
      expect(screen.queryByLabelText('Passkey name')).toBeNull();
      fireEvent.click(disclosure);
      fireEvent.change(screen.getByLabelText('Current password'), {
        target: { value: 'shared app password' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save a passkey' }));
      if (cancelled) {
        expect((await screen.findByRole('alert')).textContent).toContain('cancelled');
        expect(saved).toBe(false);
        expect(continued).toBe(false);
        expect(screen.queryByLabelText('Current password')).toBeNull();
        expect(screen.queryByText('Change shared password')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Continue to profiles' }));
      }
      await waitFor(() => expect(continued).toBe(true));
      expect(saved).toBe(!cancelled);
      view.unmount();
      returning = true;
      const onSignedIn = vi.fn();
      render(<AccessForm initialMode="household" modes={['household']} onSignedIn={onSignedIn} />);
      const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
      await waitFor(() => expect(button.disabled).toBe(false));
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'shared app password' } });
      fireEvent.click(button);
      if (cancelled) expect(await screen.findByText('Use a passkey next time')).toBeTruthy();
      else
        await waitFor(() =>
          expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({ principal: null })),
        );
    },
  );

  it('keeps other browsers collapsed and revokes only the chosen browser', async () => {
    let devices = [
      { id: 'current', name: 'Browser', principalId: null, expiresAt: session.expiresAt },
      { id: 'other', name: 'Office browser', principalId: null, expiresAt: session.expiresAt },
    ];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url.endsWith('/session')) return Response.json({ ...session, principal: null });
      if (url.endsWith('/authorize-owner')) return Response.json({ ok: true });
      if (url.endsWith('/sessions')) return Response.json({ sessions: devices });
      if (url.endsWith('/revoke-session')) {
        const { id } = JSON.parse(String(options.body));
        devices = devices.filter((device) => device.id !== id);
        return Response.json({ ok: true });
      }
      return reads(url);
    });
    render(<AccessSecurity showRecoveryCodes={false} onSignInRequired={() => {}} />);
    const disclosure = await screen.findByText(/Other signed-in browsers/);
    expect(disclosure.closest('details')?.open).toBe(false);
    fireEvent.click(disclosure);
    const office = screen.getByText('Office browser').closest('li')!;
    fireEvent.click(within(office).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Office browser')).toBeNull());
    expect(screen.getByText('This browser')).toBeTruthy();
    expect(devices.map((device) => device.id)).toEqual(['current']);
    expect(screen.queryByText('Save a passkey', { selector: 'summary' })).toBeNull();
  });

  it('keeps recovery codes out of shared-password security screens', async () => {
    vi.stubGlobal('fetch', async (url: string) => reads(url));
    render(<AccessSecurity showRecoveryCodes={false} onSignInRequired={() => {}} />);
    await screen.findByText('This browser');
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
    const disclosure = await screen.findByText('Change shared password', { exact: true });
    expect(disclosure.closest('details')?.open).toBe(false);
    fireEvent.click(disclosure);
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'one new shared password' },
    });
    expect(screen.getByRole('heading', { name: 'App access' })).toBeTruthy();
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
    await screen.findByText('This browser');
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
    await screen.findByText('This browser');
    expect(screen.queryByText('private-recovery-code')).toBeNull();
  });
});
