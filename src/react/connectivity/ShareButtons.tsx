export type ShareChannel = 'native' | 'whatsapp' | 'telegram' | 'email' | 'copy';

export interface ShareButtonsProps {
  /** The reach URL to share. */
  url: string;
  /** App name, used in the share title/subject. */
  title?: string;
  /** Message body; defaults to "Open <title>: <url>". */
  text?: string;
  /** Which channels to render, in order. */
  channels?: ShareChannel[];
  className?: string;
}

export function ShareButtons({
  url,
  title = 'this app',
  text,
  channels = ['native', 'whatsapp', 'telegram', 'email', 'copy'],
  className,
}: ShareButtonsProps) {
  const message = text ?? `Open ${title}: ${url}`;
  const canNative = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const onNative = () => {
    void navigator.share?.({ title, text: message, url }).catch(() => {});
  };
  const onCopy = () => {
    void navigator.clipboard?.writeText(url).catch(() => {});
  };

  return (
    <div className={['sd-share', className].filter(Boolean).join(' ')}>
      {channels.includes('native') && canNative && (
        <button type="button" className="sd-share-btn sd-share-primary" onClick={onNative}>
          Share…
        </button>
      )}
      {channels.includes('whatsapp') && (
        <a
          className="sd-share-btn"
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
        >
          WhatsApp
        </a>
      )}
      {channels.includes('telegram') && (
        <a
          className="sd-share-btn"
          href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`}
          target="_blank"
          rel="noreferrer"
        >
          Telegram
        </a>
      )}
      {channels.includes('email') && (
        <a
          className="sd-share-btn"
          href={`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(message)}`}
        >
          Email
        </a>
      )}
      {channels.includes('copy') && (
        <button type="button" className="sd-share-btn" onClick={onCopy}>
          Copy link
        </button>
      )}
    </div>
  );
}
