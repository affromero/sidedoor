// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessForm } from './AccessForm';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function enterPassword(view: ReturnType<typeof render>, password = 'household password') {
  const button = within(view.container.querySelector('form')!).getByRole('button', { name: 'Continue' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(button);
}

describe('shared access form', () => {
  it('gives the shared password a stable account name for browser credential saving', () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    const view = render(
      <AccessForm
        initialMode="household"
        modes={['household']}
        copy={{ householdAccount: 'Papernook' }}
        onSignedIn={() => {}}
      />,
    );
    const account = view.container.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Shared account')).toBeNull();
    expect(account.value).toBe('Papernook');
    expect(account.hidden).toBe(true);
    expect(account.readOnly).toBe(true);
    expect(account.getAttribute('autocomplete')).toBe('username');
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('explains when each access path applies', () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    const view = render(<AccessForm initialMode="household" onSignedIn={() => {}} />);
    const navigation = within(view.container.querySelector('nav')!);
    expect(navigation.getByRole('button', { name: 'Continue' }).title).toContain('shared password');
    expect(navigation.getByRole('button', { name: 'Recover account' }).title).toContain('recovery code');
    expect(navigation.getByRole('button', { name: 'Claim instance' }).title).toContain('owner-claim code');
  });

  it('keeps claim setup to the host permitted household mode', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    render(
      <AccessForm initialMode="claim" modes={['claim']} claimModes={['household']} onSignedIn={() => {}} />,
    );
    expect(screen.queryByRole('combobox', { name: 'Access mode' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Claim instance' })).toHaveLength(1);
  });

  it('offers passkey enrollment after household password entry before opening the profile picker', async () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), {
        credentials: {
          create: async () => ({
            id: 'mac-passkey',
            rawId: new Uint8Array([1]).buffer,
            type: 'public-key',
            response: {
              attestationObject: new Uint8Array([1]).buffer,
              clientDataJSON: new Uint8Array([1]).buffer,
            },
            getClientExtensionResults: () => ({}),
          }),
        },
      }),
    );
    const sessions: unknown[] = [];
    const actions: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/session')) return Response.json({ error: 'unauthorized' }, { status: 401 });
      actions.push(url.split('/').pop()!);
      if (url.endsWith('/capabilities'))
        return Response.json({
          password: true,
          passkeys: true,
          householdPasskeys: false,
          openHousehold: false,
        });
      if (url.endsWith('/household'))
        return Response.json({ principal: null, expiresAt: Date.now() + 60_000 });
      if (url.endsWith('/household-register-options'))
        return Response.json({
          ceremony: 'challenge',
          options: {
            challenge: 'YWJj',
            rp: { id: 'private.example', name: 'Test' },
            user: { id: 'aA', name: 'Household', displayName: 'Household' },
            pubKeyCredParams: [],
          },
        });
      if (url.endsWith('/register-household-passkey')) return Response.json({ ok: true });
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    const view = render(
      <AccessForm initialMode="household" onSignedIn={(session) => sessions.push(session)} />,
    );
    await enterPassword(view);
    expect(await screen.findByRole('button', { name: 'Use a passkey next time' })).toBeTruthy();
    expect(sessions).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Use a passkey next time' }));
    await waitFor(() => expect(sessions).toEqual([expect.objectContaining({ principal: null })]));
    expect(actions).toContain('register-household-passkey');
  });

  it('lets a household visitor continue without saving a passkey', async () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    const sessions: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/session')) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.endsWith('/capabilities'))
        return Response.json({
          password: true,
          passkeys: true,
          householdPasskeys: false,
          openHousehold: false,
        });
      if (url.endsWith('/household'))
        return Response.json({ principal: null, expiresAt: Date.now() + 60_000 });
      throw new Error('Passkey registration should not start');
    });
    const view = render(
      <AccessForm initialMode="household" onSignedIn={(session) => sessions.push(session)} />,
    );
    await enterPassword(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without a passkey' }));
    expect(sessions).toEqual([expect.objectContaining({ principal: null })]);
  });

  it('keeps household access available when passkey creation is cancelled', async () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), {
        credentials: {
          create: async () => {
            throw new DOMException('Cancelled', 'NotAllowedError');
          },
        },
      }),
    );
    const sessions: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/session')) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.endsWith('/capabilities'))
        return Response.json({
          password: true,
          passkeys: true,
          householdPasskeys: false,
          openHousehold: false,
        });
      if (url.endsWith('/household'))
        return Response.json({ principal: null, expiresAt: Date.now() + 60_000 });
      if (url.endsWith('/household-register-options'))
        return Response.json({
          ceremony: 'challenge',
          options: {
            challenge: 'YWJj',
            rp: { id: 'private.example', name: 'Test' },
            user: { id: 'aA', name: 'Household', displayName: 'Household' },
            pubKeyCredParams: [],
          },
        });
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    const view = render(
      <AccessForm initialMode="household" onSignedIn={(session) => sessions.push(session)} />,
    );
    await enterPassword(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Use a passkey next time' }));
    expect((await screen.findByRole('alert')).textContent).toContain('cancelled');
    expect(sessions).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without a passkey' }));
    expect(sessions).toEqual([expect.objectContaining({ principal: null })]);
  });

  it('enters an explicitly open household without requesting a password', async () => {
    const sessions: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url.endsWith('/session')) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.endsWith('/capabilities'))
        return Response.json({ password: true, passkeys: false, openHousehold: true });
      if (!url.endsWith('/open-household')) throw new Error('Unexpected endpoint');
      expect(JSON.parse(String(options.body))).toEqual({});
      return Response.json({ principal: null, expiresAt: Date.now() + 60_000 });
    });
    const view = render(
      <AccessForm initialMode="household" onSignedIn={(session) => sessions.push(session)} />,
    );
    await waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull());
    await waitFor(() =>
      expect(
        (
          within(view.container.querySelector('form')!).getByRole('button', {
            name: 'Continue',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(view.container.querySelector('form')!).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(sessions).toEqual([expect.objectContaining({ principal: null })]));
  });

  it('uses a permitted household mode when login is excluded', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ password: true, passkeys: false }));
    render(
      <AccessForm
        modes={['household']}
        onSignedIn={() => {
          throw new Error('No submission expected');
        }}
      />,
    );
    expect(screen.queryByLabelText('Account name')).toBeNull();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('aborts an old endpoint request and restores the form after its endpoint changes', async () => {
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url.endsWith('/session')) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
      return new Promise<Response>((resolve, reject) => {
        if (!options.signal) {
          resolve(Response.error());
          return;
        }
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    });
    const onSignedIn = () => {
      throw new Error('Aborted request must not sign in');
    };
    const view = render(
      <AccessForm endpoint="/old/access" initialMode="household" onSignedIn={onSignedIn} />,
    );
    await enterPassword(view, 'old endpoint password');
    view.rerender(<AccessForm endpoint="/new/access" initialMode="household" onSignedIn={onSignedIn} />);
    await waitFor(() => expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('preserves household-only admission and clears its password after success', async () => {
    const sessions: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url.endsWith('/session')) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
      const body = JSON.parse(String(options.body));
      if (!url.endsWith('/household') || body.password !== 'existing household password')
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ principal: null, expiresAt: Date.now() + 60_000 });
    });
    const view = render(
      <AccessForm
        initialMode="household"
        onSignedIn={(session) => {
          sessions.push(session);
        }}
      />,
    );
    await enterPassword(view, 'existing household password');
    await waitFor(() => expect(sessions).toEqual([expect.objectContaining({ principal: null })]));
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('focuses an actionable error when recovery completion is uncertain and never retries automatically', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
      throw new TypeError('Connection lost');
    });
    const view = render(
      <AccessForm
        initialMode="recover"
        onSignedIn={() => {
          throw new Error('Unconfirmed recovery must not sign in');
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'replacement password' } });
    fireEvent.change(screen.getByLabelText('Recovery or owner-claim code'), {
      target: { value: 'private-code' },
    });
    fireEvent.click(
      within(view.container.querySelector('form')!).getByRole('button', { name: 'Recover account' }),
    );
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('may have completed');
    await waitFor(() => expect(document.activeElement).toBe(error));
    expect(error.textContent).not.toContain('private-code');
    expect(error.textContent).not.toContain('replacement password');
  });

  it('clears private form values when switching between recovery and login', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ password: true, passkeys: false }));
    render(
      <AccessForm
        initialMode="recover"
        onSignedIn={() => {
          throw new Error('No submission expected');
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'replacement password' } });
    fireEvent.change(screen.getByLabelText('Recovery or owner-claim code'), {
      target: { value: 'private-code' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText('Recovery or owner-claim code')).toBeNull();
    expect(await screen.findByText(/Passkeys require/)).toBeTruthy();
  });
});
