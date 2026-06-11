// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { clientReachUrl, useInstallPrompt } from './useInstallPrompt';

function fireBeforeInstallPrompt(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome });
  act(() => {
    window.dispatchEvent(event);
  });
}

describe('useInstallPrompt', () => {
  it('starts with nothing installable and not installed', () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);
    expect(result.current.isInstalled).toBe(false);
  });

  it('becomes installable after beforeinstallprompt and returns the user choice', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    fireBeforeInstallPrompt('accepted');
    expect(result.current.canInstall).toBe(true);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.promptInstall();
    });
    expect(outcome).toBe('accepted');
    // The deferred prompt is consumed, so it is no longer installable.
    expect(result.current.canInstall).toBe(false);
  });

  it('returns "unavailable" when there is nothing to prompt', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.promptInstall();
    });
    expect(outcome).toBe('unavailable');
  });

  it('marks installed and not installable after appinstalled', () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current.isInstalled).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });
});

describe('clientReachUrl', () => {
  it('returns the current window origin', () => {
    expect(clientReachUrl()).toBe(window.location.origin);
  });
});
