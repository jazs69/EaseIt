import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // @repo/ui ships TypeScript source rather than compiled output so that
  // "use client" directives survive; Next has to transpile it.
  transpilePackages: ['@repo/ui'],

  typescript: {
    // Type errors fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },

  // Next 16 removed the `eslint` config key along with `next lint`; linting is
  // its own Turborepo task (`pnpm lint`) running ESLint directly.

  // The API is the only backend; no rewrites or proxies are needed because
  // CORS is configured there for these three origins.
  poweredByHeader: false,
};

export default nextConfig;
