import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const baseUiRestriction = {
  group: ['@base-ui/react', '@base-ui/react/*'],
  message:
    'Импортируйте проектные Terminal* wrappers из @gremuchaya/ui/primitives; Base UI является внутренней реализацией design-system.',
};

/**
 * `apps/hq` depends on `@gremuchaya/control-plane` for exactly one file: the
 * Fetch adapter mounted at `app/api/[[...rpc]]/route.web.ts` in the web build.
 * Anywhere else the import would put the server -- its database driver, its
 * credential hashing, its migrations -- into a client bundle, and into the
 * desktop static export, which has no server at runtime at all (ADR 0005).
 */
const controlPlaneRestriction = {
  group: ['@gremuchaya/control-plane', '@gremuchaya/control-plane/*'],
  message:
    'Только app/api/[[...rpc]]/route.web.ts монтирует control-plane; клиент ходит на него по gRPC-Web через @gremuchaya/protocol.',
};

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    '**/.next/**',
    '**/out/**',
    '**/dist/**',
    '**/coverage/**',
    '**/target/**',
    '**/playwright-report/**',
    '**/test-results/**',
    'apps/hq/src-tauri/gen/**',
  ]),
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['packages/**/*.{ts,tsx}', 'apps/file-bridge/**/*.ts', 'apps/control-plane/**/*.ts'],
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
    settings: {
      react: { version: '19.2' },
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: ['packages/ui/**/*'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [baseUiRestriction] }],
    },
  },
  {
    files: ['apps/hq/src/**/*.{ts,tsx}', 'apps/hq/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [baseUiRestriction, controlPlaneRestriction] },
      ],
    },
  },
  {
    // The single exception, and the last word for these files: `no-restricted-imports`
    // does not merge across blocks, so this one replaces the ban above rather
    // than adding to it. There is exactly one such leaf in the tree.
    files: ['apps/hq/app/api/**/route.web.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [baseUiRestriction] }],
    },
  },
  {
    files: ['packages/protocol/src/gen/**/*.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
]);
