import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@base-ui/react', '@base-ui/react/*'],
              message:
                'Импортируйте проектные Terminal* wrappers из @gremuchaya/ui/primitives; Base UI является внутренней реализацией design-system.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/protocol/src/gen/**/*.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
]);
