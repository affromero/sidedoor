// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccessInviteLink } from './AccessInviteLink';

afterEach(() => vi.unstubAllGlobals());

it('creates a reusable invitation only on owner request and puts its secret in the fragment', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return Response.json({
      code: 'private-invitation',
      mode: 'household',
      origin: 'https://library.example',
    });
  });
  render(<AccessInviteLink />);
  expect(bodies).toEqual([]);
  fireEvent.click(screen.getByLabelText('Allow multiple people to use this invitation'));
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
  const field = await screen.findByLabelText('Invitation link');
  const url = new URL((field as HTMLInputElement).value);
  expect(url.origin).toBe('https://library.example');
  expect(url.pathname).toBe('/invite');
  expect(url.search).toBe('');
  expect(new URLSearchParams(url.hash.slice(1)).get('invite')).toBe('private-invitation');
  expect(bodies).toEqual([{ ttlMs: 604800000, uses: null }]);
});

it('does not display an invitation link targeting another origin', async () => {
  vi.stubGlobal('fetch', async () =>
    Response.json({ code: 'secret', mode: 'individual', origin: 'https://library.example' }),
  );
  render(<AccessInviteLink invitationPath="https://elsewhere.example/invite" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be created'));
  expect(screen.queryByLabelText('Invitation link')).toBeNull();
});
