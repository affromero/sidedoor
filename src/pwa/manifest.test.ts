import { describe, expect, it } from 'vitest';
import { buildManifest, registerServiceWorker } from './manifest';

describe('buildManifest', () => {
  it('fills sensible defaults from just a name', () => {
    const m = buildManifest({ name: 'My App' });
    expect(m).toMatchObject({
      name: 'My App',
      short_name: 'My App',
      start_url: '/',
      display: 'standalone',
      theme_color: '#0b0b0c',
      background_color: '#0b0b0c',
      icons: [],
    });
  });

  it('omits description when none is given', () => {
    expect(buildManifest({ name: 'My App' })).not.toHaveProperty('description');
  });

  it('honours every override', () => {
    const icons = [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }];
    const m = buildManifest({
      name: 'My App',
      shortName: 'App',
      description: 'A self hosted thing',
      startUrl: '/home',
      display: 'fullscreen',
      themeColor: '#16a34a',
      backgroundColor: '#000000',
      icons,
    });
    expect(m).toEqual({
      name: 'My App',
      short_name: 'App',
      description: 'A self hosted thing',
      start_url: '/home',
      display: 'fullscreen',
      theme_color: '#16a34a',
      background_color: '#000000',
      icons,
    });
  });
});

describe('registerServiceWorker', () => {
  it('does nothing in a non browser environment instead of throwing', () => {
    // navigator is undefined under the node test environment.
    expect(() => registerServiceWorker()).not.toThrow();
  });
});
