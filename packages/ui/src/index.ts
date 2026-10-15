/**
 * @repo/ui — shared Tailwind/shadcn component library for the three Next.js
 * apps.
 *
 * Published as TypeScript source rather than compiled output: the apps list
 * this package in `transpilePackages`, which keeps React Server Component
 * directives ("use client") intact. TypeScript's emit relocates those
 * directives and silently breaks the client/server boundary.
 *
 * Rules for anything added here: no data fetching, no app-specific state, no
 * imports from @repo/database. Presentation only.
 */

export { cn } from './lib/utils';
export { Button, buttonVariants, type ButtonProps } from './components/button';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './components/card';
export { Badge, badgeVariants, type BadgeProps } from './components/badge';
