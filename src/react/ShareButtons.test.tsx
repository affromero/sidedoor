// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShareButtons } from './ShareButtons';

afterEach(() => {
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('ShareButtons', () => {
  it('renders whatsapp, telegram, email, and copy by default, and no native button without navigator.share', () => {
    render(<ShareButtons url="https://app.ts.net" title="My App" />);
    expect(screen.getByRole('link', { name: /whatsapp/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /telegram/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /email/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy link/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull();
  });

  it('encodes the url, title, and message into the share links', () => {
    render(<ShareButtons url="https://app.ts.net/x" title="My App" />);
    const wa = screen.getByRole('link', { name: /whatsapp/i }) as HTMLAnchorElement;
    expect(decodeURIComponent(wa.href)).toContain('Open My App: https://app.ts.net/x');
    const tg = screen.getByRole('link', { name: /telegram/i }) as HTMLAnchorElement;
    expect(decodeURIComponent(tg.href)).toContain('https://app.ts.net/x');
    const email = screen.getByRole('link', { name: /email/i }) as HTMLAnchorElement;
    expect(email.href.startsWith('mailto:')).toBe(true);
    expect(decodeURIComponent(email.href)).toContain('My App');
  });

  it('honours a custom message body', () => {
    render(<ShareButtons url="https://app.ts.net" title="My App" text="Custom hi" channels={['whatsapp']} />);
    const wa = screen.getByRole('link', { name: /whatsapp/i }) as HTMLAnchorElement;
    expect(decodeURIComponent(wa.href)).toContain('Custom hi');
  });

  it('renders only the requested channels', () => {
    render(<ShareButtons url="https://app.ts.net" channels={['copy']} />);
    expect(screen.getByRole('button', { name: /copy link/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /whatsapp/i })).toBeNull();
  });

  it('copies the url to the clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ShareButtons url="https://app.ts.net" channels={['copy']} />);
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));
    expect(writeText).toHaveBeenCalledWith('https://app.ts.net');
  });

  it('shows a native share button and shares the url when navigator.share exists', () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(<ShareButtons url="https://app.ts.net" title="My App" channels={['native']} />);
    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://app.ts.net', title: 'My App' }),
    );
  });
});
