import { hugeiconsIconAdapter } from './hugeicons.js';
import { lucideIconAdapter } from './lucide.js';
import { tablerIconAdapter } from './tabler.js';
import { terminalIconAdapter } from './terminal.js';
import { iconSetIds, type IconAdapter, type IconSetId } from './types.js';

/** Every switchable library's answer, keyed by `styles.iconSet`'s own values. */
export const iconAdapters: Readonly<Record<IconSetId, IconAdapter>> = {
  terminal: terminalIconAdapter,
  lucide: lucideIconAdapter,
  hugeicons: hugeiconsIconAdapter,
  tabler: tablerIconAdapter,
};

/**
 * Narrows whatever `styles.iconSet` currently holds to a library this
 * registry actually has.
 *
 * `useStringSetting` returns a bare `string`: the definition's own validator
 * already refuses an unknown value on the way into the draft, but a blob
 * persisted by an older build can still hold one, the same reason
 * `TitleBar.tsx`'s `orderedElements` filters rather than trusts its input.
 * Falling back to the definition's own default (`'terminal'`) rather than to
 * a literal repeated here keeps the two in one place.
 */
export function resolveIconSetId(value: string): IconSetId {
  return (iconSetIds as readonly string[]).includes(value) ? (value as IconSetId) : 'terminal';
}
