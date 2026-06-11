import { useEffect, useState } from 'react';

export type OS = 'macos' | 'linux' | 'windows';

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux';
}

interface Step {
  text: string;
  code?: string;
}

interface Ctx {
  os: OS;
  port: string;
  host: string;
  onLocalhost: boolean;
}

interface Method {
  id: string;
  label: string;
  /** 'private' keeps it on your own devices; 'public' puts it on the internet. */
  exposure: 'private' | 'public';
  badge: string;
  blurb: string;
  recommended?: boolean;
  steps: (ctx: Ctx) => Step[];
}

const METHODS: Method[] = [
  {
    id: 'lan',
    label: 'Same Wi-Fi',
    exposure: 'private',
    badge: 'http · your network',
    blurb:
      "Fastest. Reachable by devices on your own network, nothing leaves it. Not encrypted, so a phone can open it but can't install it as an app.",
    steps: ({ os, port, host, onLocalhost }) =>
      onLocalhost
        ? [
            {
              text: "You're on localhost, which other devices can't reach. Find this machine's network IP:",
              code:
                os === 'macos'
                  ? 'ipconfig getifaddr en0'
                  : os === 'windows'
                    ? 'ipconfig   (use the IPv4 Address)'
                    : "hostname -I | awk '{print $1}'",
            },
            { text: 'On your phone (same Wi-Fi), open that address with the port:', code: `http://<that-ip>:${port}` },
          ]
        : [{ text: 'Open this exact address on your phone (it must be on the same Wi-Fi):', code: `http://${host}` }],
  },
  {
    id: 'tailscale',
    label: 'Tailscale',
    exposure: 'private',
    badge: 'https · private mesh',
    recommended: true,
    blurb:
      'Reach it from anywhere, but only from your own devices. A private, encrypted URL on your tailnet that never touches the public internet, and installs as an app (it is https).',
    steps: ({ port }) => [
      { text: 'Install Tailscale on this machine and your phone, signed into the same account:', code: 'https://tailscale.com/download' },
      { text: 'Bring this machine onto your tailnet:', code: 'sudo tailscale up' },
      { text: 'Serve the app over private https on your tailnet:', code: `sudo tailscale serve ${port}` },
      { text: 'Tailscale prints an https URL ending in .ts.net, that is your private address. Open it on your phone.' },
    ],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Tunnel',
    exposure: 'public',
    badge: 'https · public',
    blurb:
      'Only if you want to share with people who are NOT on your devices. This puts the app on the public internet.',
    steps: ({ os, port }) => [
      {
        text: 'Install cloudflared:',
        code:
          os === 'macos'
            ? 'brew install cloudflared'
            : os === 'windows'
              ? 'winget install --id Cloudflare.cloudflared'
              : 'sudo apt install cloudflared',
      },
      { text: 'Quick, temporary public URL (no account):', code: `cloudflared tunnel --url http://localhost:${port}` },
      {
        text: 'Permanent URL on your own domain (needs a free Cloudflare account with the domain added):',
        code: [
          'cloudflared tunnel login',
          'cloudflared tunnel create myapp',
          'cloudflared tunnel route dns myapp app.yourdomain.com',
          `cloudflared tunnel run --url http://localhost:${port} myapp`,
        ].join('\n'),
      },
    ],
  },
  {
    id: 'domain',
    label: 'Your own domain',
    exposure: 'public',
    badge: 'https · public',
    blurb: 'A permanent public https URL on a domain you own, via Caddy. Use only if you want it reachable by anyone.',
    steps: ({ port }) => [
      { text: "Point an A record for your (sub)domain at this server's public IP." },
      { text: 'Install Caddy:', code: 'https://caddyserver.com/docs/install' },
      { text: 'Create a Caddyfile:', code: `app.example.com {\n  reverse_proxy localhost:${port}\n}` },
      { text: "Start Caddy, it fetches a Let's Encrypt certificate automatically:", code: 'caddy run' },
    ],
  },
];

const OS_LABELS: Record<OS, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };

export interface ReachGuideProps {
  /** The local port the app listens on. Defaults to "3000". */
  port?: string;
  /** Hide the public (internet exposing) options entirely. Default false. */
  privateOnly?: boolean;
  className?: string;
}

/**
 * A private first, guided way to reach a self hosted app from your devices.
 * Private methods (same Wi-Fi, Tailscale) come first; the internet exposing
 * options are fenced off behind a clear warning. Pick a method and it walks the
 * OS specific commands.
 */
export function ReachGuide({ port: portProp, privateOnly = false, className }: ReachGuideProps) {
  const [os, setOs] = useState<OS>('linux');
  const [port, setPort] = useState(portProp ?? '3000');
  const [host, setHost] = useState('localhost:3000');
  const [onLocalhost, setOnLocalhost] = useState(true);
  const [selected, setSelected] = useState('tailscale');

  useEffect(() => {
    setOs(detectOS());
    if (typeof window !== 'undefined') {
      if (!portProp) setPort(window.location.port || '3000');
      setHost(window.location.host);
      setOnLocalhost(/^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(window.location.hostname));
    }
  }, [portProp]);

  const visible = privateOnly ? METHODS.filter((m) => m.exposure === 'private') : METHODS;
  const method = visible.find((m) => m.id === selected) ?? visible[0]!;
  const steps = method.steps({ os, port, host, onLocalhost });
  const osMatters = (method.id === 'lan' && onLocalhost) || method.id === 'cloudflare';

  const privateMethods = visible.filter((m) => m.exposure === 'private');
  const publicMethods = visible.filter((m) => m.exposure === 'public');

  const card = (m: Method) => (
    <button
      key={m.id}
      type="button"
      role="tab"
      aria-selected={selected === m.id}
      className={['sd-method', selected === m.id ? 'sd-method-active' : ''].filter(Boolean).join(' ')}
      onClick={() => setSelected(m.id)}
    >
      <span className="sd-method-head">
        <span className="sd-method-label">{m.label}</span>
        {m.recommended ? <span className="sd-tag sd-tag-rec">recommended</span> : null}
      </span>
      <span className="sd-method-badge">{m.badge}</span>
    </button>
  );

  return (
    <div className={['sd-guide', className].filter(Boolean).join(' ')}>
      <p className="sd-group-label">Private, only your own devices</p>
      <div className="sd-methods" role="tablist" aria-label="Private reach methods">
        {privateMethods.map(card)}
      </div>

      {publicMethods.length > 0 && (
        <>
          <p className="sd-group-label sd-group-public">Share with others, this exposes it to the internet</p>
          <div className="sd-methods" role="tablist" aria-label="Public reach methods">
            {publicMethods.map(card)}
          </div>
        </>
      )}

      <div className={['sd-detail', method.exposure === 'public' ? 'sd-detail-public' : ''].filter(Boolean).join(' ')}>
        <p className="sd-blurb">{method.blurb}</p>

        {osMatters && (
          <div className="sd-os" role="group" aria-label="Operating system">
            {(Object.keys(OS_LABELS) as OS[]).map((o) => (
              <button
                key={o}
                type="button"
                className={['sd-os-btn', os === o ? 'sd-os-btn-active' : ''].filter(Boolean).join(' ')}
                onClick={() => setOs(o)}
              >
                {OS_LABELS[o]}
              </button>
            ))}
          </div>
        )}

        <ol className="sd-steps">
          {steps.map((s, i) => (
            <li key={i} className="sd-step">
              <span className="sd-step-text">{s.text}</span>
              {s.code ? <pre className="sd-code">{s.code}</pre> : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
