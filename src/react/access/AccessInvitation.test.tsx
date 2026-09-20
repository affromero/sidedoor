// @vitest-environment jsdom
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccessInvitation } from './AccessInvitation';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('accepts a manually pasted individual invitation with explicit account enrollment', async () => {
  const bodies: unknown[] = [];
  const sessions: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return Response.json({
      principal: { id: 'member', name: 'Member', role: 'member' },
      expiresAt: Date.now() + 60_000,
    });
  });
  render(<AccessInvitation onSignedIn={(session) => sessions.push(session)} />);
  fireEvent.change(screen.getByLabelText('Invitation code'), { target: { value: 'pasted-code' } });
  fireEvent.click(screen.getByLabelText('Create an individual account'));
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Member' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'member password phrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
  await waitFor(() => expect(sessions).toHaveLength(1));
  expect(bodies).toEqual([
    { code: 'pasted-code', enrollment: { name: 'Member', password: 'member password phrase' } },
  ]);
});

it('explains uncertain completion without automatically redeeming the invitation again', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    throw new TypeError('Connection lost');
  });
  render(
    <AccessInvitation
      onSignedIn={() => {
        throw new Error('Unknown result');
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Invitation code'), { target: { value: 'uncertain-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Check whether you are signed in'),
  );
  expect(bodies).toEqual([{ code: 'uncertain-code' }]);
});

it('removes the invitation fragment and redeems it only after confirmation even under strict effects', async () => {
  window.history.replaceState(null, '', '/gate#invite=private-code');
  const requests: unknown[] = [],
    sessions: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    expect(url).not.toContain('private-code');
    requests.push(JSON.parse(String(options.body)));
    return Response.json({ principal: null, expiresAt: Date.now() + 60_000 });
  });
  render(
    <StrictMode>
      <AccessInvitation onSignedIn={(session) => sessions.push(session)} />
    </StrictMode>,
  );
  expect(window.location.hash).toBe('');
  expect((screen.getByLabelText('Invitation code') as HTMLInputElement).value).toBe('private-code');
  expect(requests).toEqual([]);
  expect(screen.queryByLabelText('New password')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
  await waitFor(() => expect(sessions).toEqual([expect.objectContaining({ principal: null })]));
  expect(requests).toEqual([{ code: 'private-code' }]);
});

it('collects account credentials only for an individual invitation and surfaces a rejected redemption', async () => {
  window.history.replaceState(null, '', '/gate#invite=individual-code&mode=individual');
  let body: unknown;
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    body = JSON.parse(String(options.body));
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  });
  render(
    <AccessInvitation
      onSignedIn={() => {
        throw new Error('Rejected invitation must not sign in');
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'New member' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new member password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(body).toEqual({
    code: 'individual-code',
    enrollment: { name: 'New member', password: 'new member password' },
  });
});
