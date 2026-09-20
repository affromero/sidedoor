import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';

export interface QrCodeProps {
  /** The string the QR encodes (usually the reach URL). */
  value: string;
  size?: number;
  /** Foreground (dark) module colour. */
  dark?: string;
  /** Background (light) colour. */
  light?: string;
  /**
   * Optional node rendered in the centre (e.g. a logo/avatar). The QR is generated
   * with high error correction so a small centre badge stays scannable.
   */
  logo?: ReactNode;
  className?: string;
}

export function QrCode({
  value,
  size = 220,
  dark = '#0b0b0c',
  light = '#ffffff',
  logo,
  className,
}: QrCodeProps) {
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'H', color: { dark, light } })
      .then((s) => {
        if (!cancelled) setSvg(s);
      })
      .catch(() => {
        if (!cancelled) setSvg('');
      });
    return () => {
      cancelled = true;
    };
  }, [value, dark, light]);

  return (
    <div className={['sd-qr', className].filter(Boolean).join(' ')} style={{ width: size, height: size }}>
      {/* The SVG is generated from our own value, not untrusted input. */}
      <div className="sd-qr-img" style={{ background: light }} dangerouslySetInnerHTML={{ __html: svg }} />
      {logo ? <span className="sd-qr-logo">{logo}</span> : null}
    </div>
  );
}
