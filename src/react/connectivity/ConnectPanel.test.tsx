// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectPanel } from './ConnectPanel';

afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('ConnectPanel', () => {
  it('shows the reach url and the app name', () => {
    render(<ConnectPanel url="https://app.ts.net" appName="My App" />);
    expect(screen.getByText('https://app.ts.net')).toBeTruthy();
    expect(screen.getByText(/Reach My App at/i)).toBeTruthy();
  });

  it('warns and shows the reach guide when the url is not https', () => {
    render(<ConnectPanel url="http://box.local:3000" appName="My App" />);
    expect(screen.getByText(/use Tailscale below/i)).toBeTruthy();
    expect(screen.getByRole('tablist', { name: /private reach methods/i })).toBeTruthy();
  });

  it('omits the warning and the guide for an https url', () => {
    render(<ConnectPanel url="https://app.ts.net" appName="My App" />);
    expect(screen.queryByText(/use Tailscale below/i)).toBeNull();
    expect(screen.queryByRole('tablist', { name: /private reach methods/i })).toBeNull();
  });

  it('can suppress the guide with guideWhenInsecure=false', () => {
    render(<ConnectPanel url="http://box.local:3000" guideWhenInsecure={false} />);
    expect(screen.queryByRole('tablist', { name: /private reach methods/i })).toBeNull();
  });

  it('renders the add to home screen steps for iOS and Android', () => {
    render(<ConnectPanel url="https://app.ts.net" />);
    expect(screen.getByText(/iPhone \/ iPad/i)).toBeTruthy();
    expect(screen.getByText(/Android/i)).toBeTruthy();
    expect(screen.getAllByText(/Add to Home Screen/i).length).toBeGreaterThan(0);
  });

  it('copies the reach url', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ConnectPanel url="https://app.ts.net" />);
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    expect(writeText).toHaveBeenCalledWith('https://app.ts.net');
  });

  it('falls back to the client origin when no url is given', () => {
    render(<ConnectPanel appName="My App" />);
    // Resolves window.location.origin in an effect rather than rendering nothing.
    expect(screen.getByText(/Reach My App at/i)).toBeTruthy();
  });
});
