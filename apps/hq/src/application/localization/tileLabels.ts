import { type TileCategory } from '@gremuchaya/settings-schema';

import { t } from './locale';
import type { MessageId } from './messages';

import type { TileMotion } from '@/application/personalization/tileMotion';
import type { TilePresentationLevel } from '@/application/personalization/tilePresentation';

/**
 * What a tile group and a tile motion are called, once.
 *
 * There were two `Record<TileCategory, string>` tables over the same union --
 * one in `components/edit/TileMotionPicker.tsx`, one in
 * `components/edit/TileVisibility.tsx` -- and they disagreed. An operator
 * switching the `records` group off in one control and giving it a motion in
 * the other was told they were acting on `ЗАПИСИ` and on `РЕЕСТРЫ`; `detail`
 * was `КАРТОЧКА` against `КАРТОЧКИ` and `geo` was `ГЕО` against `ГЕОГРАФИЯ`.
 * Neither panel owns the union, so neither could own the table: it lives here,
 * beside the catalogue, and the wording it settled on is argued in
 * `messages.ts`.
 *
 * Both readers resolve the locale at the moment of the call; the two panels
 * subscribe with `useAppLocale`.
 */
const categoryMessages: Readonly<Record<TileCategory, MessageId>> = {
  summary: 'tileCategory.summary',
  records: 'tileCategory.records',
  detail: 'tileCategory.detail',
  navigation: 'tileCategory.navigation',
  telemetry: 'tileCategory.telemetry',
  events: 'tileCategory.events',
  geo: 'tileCategory.geo',
};

export function tileCategoryLabel(category: TileCategory): string {
  return t(categoryMessages[category]);
}

const motionMessages: Readonly<Record<TileMotion, MessageId>> = {
  inherit: 'tileMotion.inherit',
  none: 'tileMotion.none',
  fade: 'tileMotion.fade',
  rise: 'tileMotion.rise',
  scan: 'tileMotion.scan',
};

export function tileMotionLabel(motion: TileMotion): string {
  return t(motionMessages[motion]);
}

const presentationMessages: Readonly<Record<TilePresentationLevel | 'auto', MessageId>> = {
  auto: 'tilePresentation.auto',
  full: 'tilePresentation.full',
  compact: 'tilePresentation.compact',
  minimal: 'tilePresentation.minimal',
};

export function tilePresentationLabel(level: TilePresentationLevel | 'auto'): string {
  return t(presentationMessages[level]);
}
