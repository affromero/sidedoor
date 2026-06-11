import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'react/index': 'src/react/index.ts',
    'server/index': 'src/server/index.ts',
    'pwa/index': 'src/pwa/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  // React is a peer dep; never bundle it. CSS and sw.js ship as static files
  // (see package.json "exports"), so they are not part of the JS build.
  external: ['react', 'react-dom'],
});
