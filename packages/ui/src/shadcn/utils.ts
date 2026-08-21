import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class-name merger used by every shadcn/ui component. It lives here rather
 * than in `apps/hq` because the components themselves must stay inside
 * `packages/ui`: they render raw interactive elements and import Base UI
 * directly, both of which `scripts/check-ui-boundary.mjs` rejects anywhere
 * else.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
