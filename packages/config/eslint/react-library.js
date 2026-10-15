import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import base from './base.js';

/** Shared React component library (@repo/ui). Browser globals, no Node. */
export default tseslint.config(...base, {
  files: ['**/*.{ts,tsx}'],
  plugins: { 'react-hooks': reactHooks },
  languageOptions: {
    globals: { ...globals.browser },
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  rules: {
    ...reactHooks.configs.recommended.rules,
    // The component library is presentation only (CLAUDE.md section 2).
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@repo/database',
            message: '@repo/ui is presentation only: no data fetching, no database access.',
          },
          {
            name: 'next',
            message: 'Keep @repo/ui framework-agnostic so all three apps can consume it.',
          },
        ],
      },
    ],
  },
});
