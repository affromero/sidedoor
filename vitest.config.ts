import { defineConfig } from 'vitest/config';

// Node by default; the React component tests opt into jsdom with a
// `// @vitest-environment jsdom` pragma at the top of the file.
export default defineConfig({
  test: {
    // globals lets @testing-library/react register its automatic DOM cleanup
    // after each test, so renders never leak between cases.
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
