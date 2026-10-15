import js from '@eslint/js';
import turbo from 'eslint-plugin-turbo';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Build artefacts and generated code are never linted. */
export const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/generated/**',
  '**/*.d.ts',
];

/**
 * Shared base for every package in the monorepo.
 *
 * Deliberately NOT type-checked (`recommendedTypeChecked`): type-aware linting
 * needs a TS program per file and roughly triples lint time, and `tsc
 * --noEmit` already runs as its own Turborepo task so the type errors are
 * caught either way. To opt a package in, swap `tseslint.configs.recommended`
 * for `recommendedTypeChecked` and add
 * `languageOptions.parserOptions.projectService: true`.
 */
export default tseslint.config(
  { ignores: IGNORES },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { turbo },
    rules: {
      // Catches an env var read in code but not declared in turbo.json, which
      // would otherwise produce a cache hit that silently ignores the change.
      'turbo/no-undeclared-env-vars': 'warn',
    },
  },

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      /* --- General ------------------------------------------------------ */
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['warn', 'always'],
      // No empty catch blocks: either handle it, enrich and rethrow, or let
      // it propagate.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
    },
  },

  {
    // TypeScript-only rules. Scoped so that flat-config files and plain JS
    // scripts are not linted with a TS ruleset.
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      /* --- Typing discipline (CLAUDE.md section 5) ---------------------- */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      /* --- Tenancy (CLAUDE.md section 3.2) ------------------------------ */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Import from @repo/database instead. It owns the singleton and the ' +
                'tenant-scoping client extension; a direct import bypasses both.',
            },
          ],
        },
      ],
    },
  },

  // Config files and scripts legitimately log and read raw env.
  {
    files: ['**/*.config.{js,mjs,ts}', '**/scripts/**', '**/prisma/seed.ts'],
    rules: {
      'no-console': 'off',
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
);
