// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessForm } from './AccessForm';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared access form', () => {
  it('enters an explicitly open household without requesting a password', async () => {
    const sessions: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
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
    fireEvent.click(
      within(view.container.querySelector('form')!).getByRole('button', { name: 'Enter household' }),
    );
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
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'old endpoint password' } });
    fireEvent.click(
      within(view.container.querySelector('form')!).getByRole('button', { name: 'Enter household' }),
    );
    view.rerender(<AccessForm endpoint="/new/access" initialMode="household" onSignedIn={onSignedIn} />);
    await waitFor(() => expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('preserves household-only admission and clears its password after success', async () => {
    const sessions: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
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
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'existing household password' } });
    fireEvent.click(
      within(view.container.querySelector('form')!).getByRole('button', { name: 'Enter household' }),
    );
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
