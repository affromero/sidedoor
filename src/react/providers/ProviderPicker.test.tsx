// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import type { ProviderDescriptor } from '../../../packages/core/src/ai/browser';
import { ProviderPicker, type ProviderSelectionDraft } from './ProviderPicker';

const api: ProviderDescriptor = {
  id: 'api',
  label: 'API',
  transport: 'api',
  capabilities: ['vision'],
  fields: [{ id: 'apiKey', label: 'API key', secret: true, required: true, kind: 'string' }],
  models: [
    { id: 'camera', label: 'Vision model', capabilities: ['vision'] },
    { id: 'text', label: 'Text model', capabilities: ['text'] },
  ],
};
const cli: ProviderDescriptor = {
  ...api,
  id: 'cli',
  label: 'CLI',
  transport: 'cli',
  fields: [],
};

it('offers compatible models and clears a draft key and model when switching transport', () => {
  function Form() {
    const [value, setValue] = useState<ProviderSelectionDraft>({
      provider: 'api',
      model: 'camera',
      credentials: { apiKey: 'draft-key' },
    });
    return (
      <ProviderPicker
        providers={[api, cli, { ...api, id: 'text', label: 'Text only', capabilities: ['text'] }]}
        value={value}
        onChange={setValue}
        requiredCapabilities={['vision']}
        readiness={{ code: 'not_authenticated', checkedAt: 0 }}
      />
    );
  }
  render(<Form />);
  const provider = screen.getByLabelText('Provider');
  const model = screen.getByLabelText('Model');
  expect(within(provider).queryByRole('option', { name: 'Text only' })).toBeNull();
  expect(within(model).queryByRole('option', { name: 'Text model' })).toBeNull();
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('draft-key');
  fireEvent.change(provider, { target: { value: 'cli' } });
  expect(screen.queryByLabelText('API key')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Sign in');
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
  fireEvent.change(provider, { target: { value: 'api' } });
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
});
