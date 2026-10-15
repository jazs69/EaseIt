import base from '@repo/config/eslint/base';

export default [
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      // This package *is* the Prisma boundary; the ban on importing
      // @prisma/client applies to every package except this one.
      'no-restricted-imports': 'off',
    },
  },
];
