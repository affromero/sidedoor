// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ReachGuide } from './ReachGuide';

describe('ReachGuide', () => {
  it('lists the private methods first, under a private group label', () => {
    render(<ReachGuide />);
    expect(screen.getByText(/Private, only your own devices/i)).toBeTruthy();
    const privateList = screen.getByRole('tablist', { name: /private reach methods/i });
    expect(within(privateList).getByRole('tab', { name: /Same Wi-Fi/i })).toBeTruthy();
    expect(within(privateList).getByRole('tab', { name: /Tailscale/i })).toBeTruthy();
  });

  it('defaults to Tailscale, the recommended private method, and shows its steps', () => {
    const { container } = render(<ReachGuide />);
    const tailscale = screen.getByRole('tab', { name: /Tailscale/i });
    expect(tailscale.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('sudo tailscale serve');
  });

  it('fences the public methods behind an exposure warning', () => {
    render(<ReachGuide />);
    expect(screen.getByText(/this exposes it to the internet/i)).toBeTruthy();
    const publicList = screen.getByRole('tablist', { name: /public reach methods/i });
    expect(within(publicList).getByRole('tab', { name: /Cloudflare Tunnel/i })).toBeTruthy();
    expect(within(publicList).getByRole('tab', { name: /Your own domain/i })).toBeTruthy();
  });

  it('hides the public methods entirely when privateOnly is set', () => {
    render(<ReachGuide privateOnly />);
    expect(screen.queryByText(/this exposes it to the internet/i)).toBeNull();
    expect(screen.queryByRole('tab', { name: /Cloudflare Tunnel/i })).toBeNull();
    expect(screen.queryByRole('tablist', { name: /public reach methods/i })).toBeNull();
  });

  it('switches the detail when another method is selected', () => {
    const { container } = render(<ReachGuide />);
    fireEvent.click(screen.getByRole('tab', { name: /Your own domain/i }));
    expect(container.textContent).toContain('reverse_proxy localhost:3000');
  });

  it('threads the port into the generated commands', () => {
    const { container } = render(<ReachGuide port="8080" />);
    expect(container.textContent).toContain('sudo tailscale serve 8080');
  });
});
