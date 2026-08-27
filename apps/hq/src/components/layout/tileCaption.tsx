'use client';

import { createContext, use, type ReactNode } from 'react';

import { elementCaption } from '@/application/localization/elementTranslations';
import type { AppLocale } from '@/application/localization/messages';

/**
 * The address a panel needs to know what the operator renamed it to.
 *
 * R28's second half is a caption stored per element, per screen and per locale
 * (`application/localization/elementTranslations.ts`). A panel knows none of
 * the three: it is handed a title and draws it, and it is written into a screen
 * dozens of times over. `TileGrid` knows all three -- it is the component that
 * places a tile under an id, on a named screen -- so it is the one that says
 * which element a subtree is drawing, and the panel inside asks.
 *
 * The entries and the locale ride along rather than being read again below,
 * because the grid already subscribes to both for the tile settings beside
 * this one. One subscription per screen, not one per panel.
 */
export interface TileCaptionScope {
  readonly entries: readonly string[];
  readonly locale: AppLocale;
  readonly screen: string;
  readonly element: string;
}

const TileCaptionContext = createContext<TileCaptionScope | null>(null);

export function TileCaptionProvider({
  scope,
  children,
}: {
  readonly scope: TileCaptionScope | null;
  readonly children: ReactNode;
}) {
  return <TileCaptionContext value={scope}>{children}</TileCaptionContext>;
}

/**
 * The caption to draw for a heading: the operator's, or the one shipped.
 *
 * Outside a tile -- the settings screen, a drawer, the developer gallery --
 * there is no scope and the source title is returned untouched, so a panel
 * that is not a tile cannot be renamed by an entry addressed to one.
 *
 * A panel nested inside a tile is the case worth naming: it is drawing its own
 * heading, not the tile's, and inheriting the tile's caption would rename it as
 * a side effect. `Panel` closes the scope around its body for exactly that
 * reason, so only the outermost heading of a cell answers to the entry.
 */
export function useElementCaption(source: string): string {
  const scope = use(TileCaptionContext);
  if (scope === null) return source;
  return elementCaption(
    scope.entries,
    { locale: scope.locale, screen: scope.screen, element: scope.element },
    source,
  );
}
