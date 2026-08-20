import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app tsconfig sets `jsx: "preserve"` for Next.js, which the Vite/Rolldown
  // transform otherwise inherits and then refuses to parse (it expects a
  // downstream JSX consumer, which Vitest never provides). Overriding the oxc
  // transform's jsx runtime here decouples component tests from that setting.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    // Mirrors tsconfig.json's `paths: { "@/*": ["./src/*"] }`. Vite does not
    // read tsconfig `paths` on its own, and this is the first component test
    // to import through the alias rather than a relative path.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    // Default stays 'node'; component tests opt into jsdom individually via a
    // `// @vitest-environment jsdom` docblock, so plain-logic tests keep the
    // cheaper node environment.
    environment: 'node',
  },
});
