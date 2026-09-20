// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccessVerification } from './AccessVerification';

afterEach(() => vi.unstubAllGlobals());
it('verifies in place and clears the password without replacing an unfinished settings form', async () => {
  const sessions: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    if (url.endsWith('/capabilities')) return Response.json({ password: true, passkeys: false });
    expect(url).toContain('/reauthenticate');
    expect(JSON.parse(String(options.body))).toEqual({ password: 'owner password' });
    return Response.json({
      principal: { id: 'owner', name: 'Owner', role: 'owner' },
      expiresAt: Date.now() + 60_000,
    });
  });
  render(
    <div>
      <input aria-label="Unfinished setting" defaultValue="draft value" />
      <AccessVerification onVerified={(session) => sessions.push(session)} />
    </div>,
  );
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'owner password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify with password' }));
  await waitFor(() => expect(sessions).toHaveLength(1));
  expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Unfinished setting') as HTMLInputElement).value).toBe('draft value');
});
