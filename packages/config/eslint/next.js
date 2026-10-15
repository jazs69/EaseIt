import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import base from './base.js';

/**
 * Next.js App Router applications.
 *
 * `eslint-config-next/core-web-vitals` exports a flat `Linter.Config[]`, so it
 * spreads in directly — no FlatCompat shim needed on Next 16.
 *
 * Note the pinned ESLint 9: eslint-config-next's transitive plugins
 * (eslint-plugin-import, -react, -jsx-a11y) still cap their peer range at
 * ESLint 9, so moving the monorepo to ESLint 10 breaks them at rule-execution
 * time rather than at install time.
 */
export default tseslint.config(...base, ...nextCoreWebVitals, {
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    globals: { ...globals.browser, ...globals.node },
  },
  rules: {
    // The web apps hold no business logic — they call apps/api.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@repo/database',
            message:
              'The web apps do not talk to Postgres. Call the API; it owns tenant ' +
              'scoping, transactions and the audit log (CLAUDE.md section 2).',
          },
          { name: '@prisma/client', message: 'See above: no direct database access.' },
        ],
      },
    ],
  },
});
