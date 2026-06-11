// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QrCode } from './QrCode';

describe('QrCode', () => {
  it('renders an svg for the value', async () => {
    const { container } = render(<QrCode value="https://app.ts.net" />);
    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });
  });

  it('renders a centre logo alongside the code when one is provided', async () => {
    const { container, getByText } = render(<QrCode value="https://app.ts.net" logo={<span>LOGO</span>} />);
    expect(getByText('LOGO')).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });
  });
});
