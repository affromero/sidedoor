// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ProviderFields, type ProviderFieldsPatch } from './ProviderFields';

it('requires an explicit reset selection and explains an endpoint-bound key mismatch', () => {
  let selected = false;
  function Form() {
    const [reset, setReset] = useState(false);
    return (
      <ProviderFields
        descriptor={{
          id: 'custom',
          label: 'Custom',
          transport: 'api',
          capabilities: ['text'],
          models: [],
          fields: [
            { id: 'compatibleApiKey', label: 'Endpoint key', secret: true, required: false, kind: 'string' },
          ],
        }}
        fields={[
          { id: 'compatibleApiKey', source: 'stored', configured: false, error: 'endpoint_binding_mismatch' },
        ]}
        patch={{}}
        onChange={() => undefined}
        reset={reset}
        onResetChange={(value) => {
          selected = value;
          setReset(value);
        }}
      />
    );
  }
  render(<Form />);
  expect(screen.getByText(/belongs to a different endpoint/)).toBeTruthy();
  expect(selected).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /Remove all saved settings/ }));
  expect(selected).toBe(true);
  expect(screen.queryByText(/belongs to a different endpoint/)).toBeNull();
});

it('keeps saved secrets out of inputs and explicitly distinguishes removal from unchanged values', () => {
  let latest: ProviderFieldsPatch = {};
  function Form() {
    const [patch, setPatch] = useState<ProviderFieldsPatch>({});
    return (
      <ProviderFields
        descriptor={{
          id: 'new-provider',
          label: 'New provider',
          transport: 'api',
          capabilities: ['text'],
          models: [],
          fields: [{ id: 'apiKey', label: 'Provider key', secret: true, required: true, kind: 'string' }],
        }}
        fields={[{ id: 'apiKey', configured: true, source: 'stored' }]}
        patch={patch}
        onChange={(next) => {
          latest = next;
          setPatch(next);
        }}
      />
    );
  }
  render(<Form />);
  const input = screen.getByLabelText('Provider key') as HTMLInputElement;
  expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'replacement-key' } });
  expect(latest).toEqual({ apiKey: 'replacement-key' });
  fireEvent.change(input, { target: { value: '' } });
  expect(latest).toEqual({});
  fireEvent.click(screen.getByRole('button', { name: 'Remove saved value' }));
  expect(latest).toEqual({ apiKey: null });
});

it('renders newly described public settings and environment provenance without application-specific fields', () => {
  const patches: ProviderFieldsPatch[] = [];
  render(
    <ProviderFields
      descriptor={{
        id: 'audio-provider',
        label: 'Audio provider',
        transport: 'api',
        capabilities: ['speech'],
        models: [],
        fields: [
          { id: 'monthlyLimit', label: 'Monthly limit', secret: false, required: false, kind: 'number' },
          { id: 'enabled', label: 'Enabled', secret: false, required: false, kind: 'boolean' },
        ],
      }}
      fields={[{ id: 'monthlyLimit', configured: true, source: 'stored', value: 100 }]}
      patch={{}}
      onChange={(patch) => patches.push(patch)}
    />,
  );
  expect(screen.getByText('Saved on this instance')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Monthly limit'), { target: { value: '150' } });
  expect(patches[patches.length - 1]).toEqual({ monthlyLimit: 150 });
  fireEvent.click(screen.getByLabelText('Enabled'));
  expect(patches[patches.length - 1]).toEqual({ enabled: true });
});
