import tseslint from 'typescript-eslint';

import base from './base.js';

/**
 * NestJS applications.
 *
 * The decorator-heavy style trips a few rules that are correct everywhere
 * else, and the layering rules in CLAUDE.md section 5 are enforced here as
 * import restrictions rather than left to review.
 */
export default tseslint.config(
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      // Decorators on a class with only decorated members are the idiom.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Parameter properties ARE the constructor-injection idiom.
      '@typescript-eslint/parameter-properties': 'off',
      // Nest resolves these; interfaces for DTOs defeat class-validator.
      '@typescript-eslint/no-empty-object-type': 'off',

      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Import from @repo/database instead — it owns the singleton and the ' +
                'tenant-scoping extension.',
            },
          ],
          patterns: [
            {
              group: ['**/modules/*/!(index)'],
              message:
                'Reach another module through its public barrel, not its internals. ' +
                'If you need something unexported, the boundary is drawn wrong.',
            },
          ],
        },
      ],
    },
  },
  {
    // Controllers are a transport layer: no data access, ever.
    files: ['**/*.controller.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@repo/database',
              message:
                'A controller never touches Prisma. Go controller -> application ' +
                'service -> domain -> repository (CLAUDE.md section 5).',
            },
            { name: '@prisma/client', message: 'See above: controllers do not query.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/main.ts'],
    rules: {
      // Bootstrap failures happen before any logger exists.
      'no-console': 'off',
    },
  },
);
