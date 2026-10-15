import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class lists, with later conflicting utilities winning.
 * The standard shadcn/ui helper — every component here takes a `className`
 * and funnels it through this so callers can always override.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
