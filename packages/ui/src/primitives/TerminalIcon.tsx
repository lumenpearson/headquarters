'use client';

import { createElement, type CSSProperties } from 'react';

import { iconAdapters, resolveIconSetId } from '../icons/registry.js';
import {
  iconNames,
  iconSetIds,
  type IconAdapter,
  type IconName,
  type IconSetId,
} from '../icons/types.js';
import { classNames } from './classNames.js';

// Re-exported so a call site needs only `@gremuchaya/ui/primitives`: the
// icon vocabulary and the switchable-library registry are as much this
// primitive's public surface as its own props are.
export { iconAdapters, iconNames, iconSetIds, resolveIconSetId };
export type { IconAdapter, IconName, IconSetId };

export interface TerminalIconProps {
  readonly name: IconName;
  /**
   * Which library draws `name`, taken from `styles.iconSet` at the call
   * site. A bare `string` rather than `IconSetId`: every caller reads it
   * straight off `useStringSetting('styles.iconSet')`, and narrowing a
   * value a persisted blob from an older build might not recognise is this
   * component's job, not every call site's. Left `undefined` it draws from
   * `'terminal'`, the setting's own default.
   */
  readonly iconSet?: string;
  /**
   * A pixel hint, carried as the `--terminal-icon-size` custom property
   * rather than as a `width`/`height` attribute, so a call site's own CSS
   * (`.settings-card__icon svg`, and every sibling rule like it) still
   * outranks it -- the same contract those rules already held over the
   * hand-drawn glyphs this component replaces.
   */
  readonly size?: number;
  readonly className?: string;
}

/**
 * One icon, drawn by whichever library `iconSet` names.
 *
 * The rendered `<svg>` never carries a `width`, `height`, `stroke` or
 * `color` attribute -- only `viewBox`, `aria-hidden` and a class -- because
 * CSS at the call site has to keep deciding those. `fill-none stroke-current`
 * on that class is the one default all four libraries draw against; a path
 * that wants something else (`appearance`'s pie slice, `media`'s play mark)
 * sets its own `fill`/`stroke`, which -- being specified on that exact
 * element -- wins over whatever the ancestor supplies regardless of any class
 * here.
 *
 * No `stroke-linecap`/`stroke-linejoin` default: `.settings-card__icon svg`
 * never set either, so the sixteen settings-card marks have always drawn with
 * the SVG initial values (butt caps, miter joins) under `'terminal'`, and a
 * default added here would move that appearance out from under a setting
 * whose whole point is to leave it alone until an operator opts out.
 */
export function TerminalIcon({ name, iconSet, size, className }: TerminalIconProps) {
  const adapter = iconAdapters[resolveIconSetId(iconSet ?? 'terminal')];
  const node = adapter[name];
  const style =
    size === undefined
      ? undefined
      : ({ '--terminal-icon-size': `${size.toString()}px` } as CSSProperties);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className={classNames(
        'terminal-icon',
        'inline-block shrink-0 fill-none stroke-current [stroke-width:1.5]',
        'w-[var(--terminal-icon-size,1em)] h-[var(--terminal-icon-size,1em)]',
        className,
      )}
      {...(style === undefined ? {} : { style })}
    >
      {node.map(([tag, attrs], index) =>
        createElement(tag, { ...attrs, key: attrs['key'] ?? index }),
      )}
    </svg>
  );
}
