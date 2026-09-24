// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccessForm } from '../AccessForm';

const session = { principal: null, expiresAt: 9999999999999 };
let saved = false;
let signedIn = false;
let cancel = false;

beforeEach(() => {
  saved = false;
  signedIn = false;
  cancel = false;
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), {
      credentials: {
        create: async () => {
          if (cancel) throw new DOMException('Cancelled', 'NotAllowedError');
          return {
            id: 'device-key',
            rawId: new Uint8Array([1]).buffer,
            type: 'public-key',
            response: {
              attestationObject: new Uint8Array([1]).buffer,
              clientDataJSON: new Uint8Array([1]).buffer,
            },
            getClientExtensionResults: () => ({}),
          };
        },
        get: async () => ({
          id: 'device-key',
          rawId: new Uint8Array([1]).buffer,
          type: 'public-key',
          response: {
            authenticatorData: new Uint8Array([1]).buffer,
            clientDataJSON: new Uint8Array([1]).buffer,
            signature: new Uint8Array([1]).buffer,
          },
          getClientExtensionResults: () => ({}),
        }),
      },
    }),
  );
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/session'))
      return signedIn ? Response.json(session) : Response.json({ error: 'unauthorized' }, { status: 401 });
    if (url.endsWith('/capabilities'))
      return Response.json({ password: true, passkeys: true, householdPasskeys: saved });
    if (url.endsWith('/household') || url.endsWith('/authenticate-household-passkey'))
      return Response.json(session);
    if (url.endsWith('/household-register-options'))
      return Response.json({
        ceremony: 'challenge',
        options: {
          challenge: 'YWJj',
          rp: { id: 'localhost', name: 'App' },
          user: { id: 'aA', name: 'App', displayName: 'App' },
          pubKeyCredParams: [],
        },
      });
    if (url.endsWith('/household-authentication-options'))
      return Response.json({ ceremony: 'challenge', options: { challenge: 'YWJj', rpId: 'localhost' } });
    if (url.endsWith('/register-household-passkey')) {
      saved = true;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected endpoint ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(endpoint?: string, onSignedIn = vi.fn()) {
  return {
    ...render(
      <AccessForm
        endpoint={endpoint}
        initialMode="household"
        modes={['household']}
        onSignedIn={onSignedIn}
      />,
    ),
    onSignedIn,
  };
}

async function password() {
  const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'shared password' } });
  fireEvent.click(button);
}

async function enroll() {
  const view = mount();
  await password();
  fireEvent.click(await screen.findByRole('button', { name: 'Use a passkey next time' }));
  await waitFor(() => expect(view.onSignedIn).toHaveBeenCalledWith(session));
  view.unmount();
}

it('does not offer enrollment again after saving a passkey and returning with the password', async () => {
  await enroll();
  const view = mount('/api/access/');
  await password();
  await waitFor(() => expect(view.onSignedIn).toHaveBeenCalledWith(session));
  expect(screen.queryByText('Use a passkey next time')).toBeNull();
});

it('remembers successful passkey sign-in for keys saved before this browser preference existed', async () => {
  saved = true;
  const first = mount();
  const button = await screen.findByRole('button', { name: 'Sign in with a passkey' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(first.onSignedIn).toHaveBeenCalledWith(session));
  first.unmount();
  const second = mount();
  await password();
  await waitFor(() => expect(second.onSignedIn).toHaveBeenCalledWith(session));
  expect(screen.queryByText('Use a passkey next time')).toBeNull();
});

it('offers enrollment to a new browser even when another device already saved a key', async () => {
  saved = true;
  mount();
  await password();
  expect(await screen.findByText('Use a passkey next time')).toBeTruthy();
});

it('offers enrollment again after the server removes all saved keys', async () => {
  await enroll();
  saved = false;
  mount();
  await password();
  expect(await screen.findByText('Use a passkey next time')).toBeTruthy();
});

it('keeps preferences separate for apps with different access endpoints', async () => {
  await enroll();
  mount('/other/access');
  await password();
  expect(await screen.findByText('Use a passkey next time')).toBeTruthy();
});

it('allows successful enrollment when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  await enroll();
});

it('does not remember a cancelled enrollment', async () => {
  cancel = true;
  const first = mount();
  await password();
  fireEvent.click(await screen.findByText('Use a passkey next time'));
  expect((await screen.findByRole('alert')).textContent).toContain('cancelled');
  first.unmount();
  saved = true;
  mount();
  await password();
  expect(await screen.findByText('Use a passkey next time')).toBeTruthy();
});

it('resumes an existing session after refreshing without password entry or enrollment', async () => {
  signedIn = true;
  const view = mount();
  await waitFor(() => expect(view.onSignedIn).toHaveBeenCalledWith(session));
  expect(screen.queryByText('Use a passkey next time')).toBeNull();
});

it('waits for session detection and ignores its result after an endpoint change', async () => {
  const fetcher = fetch;
  let resolveSession!: (response: Response) => void;
  vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
    url === '/old/session'
      ? new Promise<Response>((resolve) => {
          resolveSession = resolve;
        })
      : fetcher(url, options),
  );
  const view = mount('/old');
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(
    <AccessForm endpoint="/new" initialMode="household" modes={['household']} onSignedIn={view.onSignedIn} />,
  );
  await act(async () => resolveSession(Response.json(session)));
  await password();
  expect(await screen.findByText('Use a passkey next time')).toBeTruthy();
  expect(view.onSignedIn).not.toHaveBeenCalled();
});

it('reports a failed session check without treating it as authenticated', async () => {
  const fetcher = fetch;
  vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
    url.endsWith('/session')
      ? Promise.resolve(Response.json({ error: 'network_error' }, { status: 503 }))
      : fetcher(url, options),
  );
  const view = mount();
  expect((await screen.findByRole('alert')).textContent).toContain('reach');
  expect(view.onSignedIn).not.toHaveBeenCalled();
});

it('does not resume a session after unmounting while capabilities are delayed', async () => {
  signedIn = true;
  const fetcher = fetch;
  let resolveCapabilities!: (response: Response) => void;
  vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
    url.endsWith('/capabilities')
      ? new Promise<Response>((resolve) => {
          resolveCapabilities = resolve;
        })
      : fetcher(url, options),
  );
  const view = mount();
  view.unmount();
  await act(async () =>
    resolveCapabilities(Response.json({ password: true, passkeys: true, householdPasskeys: false })),
  );
  expect(view.onSignedIn).not.toHaveBeenCalled();
});

it('uses the latest navigation callback without restarting pending session detection', async () => {
  const fetcher = fetch;
  let resolveSession!: (response: Response) => void;
  vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
    url.endsWith('/session')
      ? new Promise<Response>((resolve) => {
          resolveSession = resolve;
        })
      : fetcher(url, options),
  );
  const view = mount();
  const next = vi.fn();
  view.rerender(<AccessForm initialMode="household" modes={['household']} onSignedIn={next} />);
  await act(async () => resolveSession(Response.json(session)));
  await waitFor(() => expect(next).toHaveBeenCalledWith(session));
  expect(view.onSignedIn).not.toHaveBeenCalled();
});

it('does not remember or navigate after a registration completes on an unmounted form', async () => {
  const fetcher = fetch;
  let resolveRegistration: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
    url.endsWith('/register-household-passkey')
      ? new Promise<Response>((resolve) => {
          resolveRegistration = resolve;
        })
      : fetcher(url, options),
  );
  const view = mount();
  await password();
  fireEvent.click(await screen.findByText('Use a passkey next time'));
  await waitFor(() => expect(resolveRegistration).toBeDefined());
  view.unmount();
  await act(async () => resolveRegistration!(Response.json({ ok: true })));
  expect(view.onSignedIn).not.toHaveBeenCalled();
  saved = true;
  mount();
  await password();
  expect(await screen.findByText('Use a passkey next time')).toBeTruthy();
});
