import { useEffect, useState, type ReactNode } from 'react';
import { QrCode } from './QrCode.js';
import { ShareButtons, type ShareChannel } from './ShareButtons.js';
import { ReachGuide } from './ReachGuide.js';
import { useInstallPrompt, clientReachUrl } from './useInstallPrompt.js';

export interface ConnectPanelProps {
  /** The reach URL to hand out. Defaults to the browser's current origin. */
  url?: string;
  appName?: string;
  /** Optional node placed in the QR centre (a logo/avatar). */
  logo?: ReactNode;
  /** Local port, used by the embedded reach guide. */
  port?: string;
  shareChannels?: ShareChannel[];
  /** Show the private first reach guide when the URL is not https. Default true. */
  guideWhenInsecure?: boolean;
  className?: string;
}

/**
 * Everything a device needs to open and install a self hosted app: the reach
 * URL, a QR, share buttons, add to home screen steps, and, when the URL is not
 * https, the private first reach guide so the operator can fix that first.
 */
export function ConnectPanel({
  url,
  appName = 'this app',
  logo,
  port,
  shareChannels,
  guideWhenInsecure = true,
  className,
}: ConnectPanelProps) {
  const [resolved, setResolved] = useState(url ?? '');
  useEffect(() => {
    if (!url) setResolved(clientReachUrl());
  }, [url]);

  const reachUrl = url ?? resolved;
  const isSecure = reachUrl.startsWith('https://');
  const { canInstall, isInstalled, promptInstall } = useInstallPrompt();

  if (!reachUrl) return null;

  return (
    <div className={['sd-panel', className].filter(Boolean).join(' ')}>
      <div className="sd-url-card">
        <span className="sd-url-label">Reach {appName} at</span>
        <div className="sd-url-row">
          <code className="sd-url">{reachUrl}</code>
          <button
            type="button"
            className="sd-copy"
            onClick={() => void navigator.clipboard?.writeText(reachUrl).catch(() => {})}
          >
            Copy
          </button>
        </div>
      </div>

      {!isSecure && (
        <div className="sd-warn">
          <p className="sd-warn-text">
            This URL is not <strong>https</strong>, so a phone can open it on your network but can&apos;t install it as
            an app, and the connection isn&apos;t encrypted. For a private https address you can reach from anywhere, use
            Tailscale below.
          </p>
        </div>
      )}

      {!isSecure && guideWhenInsecure ? <ReachGuide port={port} /> : null}

      <div className="sd-qr-card">
        <QrCode value={reachUrl} logo={logo} />
        <p className="sd-hint">Scan with your phone camera to open it.</p>
        <ShareButtons url={reachUrl} title={appName} channels={shareChannels} />
      </div>

      {isInstalled ? (
        <p className="sd-installed">Installed, running as an app.</p>
      ) : (
        <div className="sd-install">
          {canInstall ? (
            <button type="button" className="sd-install-btn" onClick={() => void promptInstall()}>
              Install as an app
            </button>
          ) : null}
          <div className="sd-install-steps">
            <div className="sd-install-os">
              <h4 className="sd-install-title">iPhone / iPad (Safari)</h4>
              <ol>
                <li>Open the URL above in Safari.</li>
                <li>Tap the Share button.</li>
                <li>
                  Tap <strong>Add to Home Screen</strong>.
                </li>
              </ol>
            </div>
            <div className="sd-install-os">
              <h4 className="sd-install-title">Android (Chrome)</h4>
              <ol>
                <li>Open the URL above in Chrome.</li>
                <li>Tap the menu (three dots).</li>
                <li>
                  Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
                </li>
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
