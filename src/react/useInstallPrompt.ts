import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallPrompt {
  /** The browser fired `beforeinstallprompt` (Chromium-family). iOS never does. */
  canInstall: boolean;
  /** Already running as an installed PWA (standalone display mode). */
  isInstalled: boolean;
  /** Roughly "this looks like iOS Safari", where install is a manual Share menu step. */
  isIosManual: boolean;
  /** Show the native install prompt. Resolves to the user's choice, or 'unavailable'. */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

/**
 * Thin, zero-dependency wrapper over the Add-to-Home-Screen signals. For richer
 * iOS-specific prompts you can layer a dedicated library (e.g. react-ios-pwa-prompt)
 * on top; this just exposes the state the ConnectPanel needs.
 */
export function useInstallPrompt(): InstallPrompt {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    const onBIP = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setIsInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) setIsInstalled(true);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferred) return 'unavailable';
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    return outcome;
  }, [deferred]);

  const isIosManual =
    typeof navigator !== 'undefined' &&
    /iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !(navigator as unknown as { standalone?: boolean }).standalone;

  return { canInstall: !!deferred, isInstalled, isIosManual, promptInstall };
}

/** The URL the current browser reached this app on (client-side). */
export function clientReachUrl(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}
