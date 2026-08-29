'use client';

import { tileCategories } from '@gremuchaya/settings-schema';
import { TerminalSelect } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import { tileCategoryLabel, tilePresentationLabel } from '@/application/localization/tileLabels';
import {
  readCategoryPresentations,
  readTilePresentations,
  tilePresentationLevels,
  withCategoryPresentation,
  withTilePresentation,
  type TilePresentationLevel,
} from '@/application/personalization/tilePresentation';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { useSelectedTile } from './selectedTile';

/**
 * The view of one tile, and of a whole group of them.
 *
 * `tiles.presentation` was the only lever before this: one ceiling for the
 * application, which the plan recorded as a leftover once F5 closed without a
 * per-tile setting -- "a global ceiling, not a setting of one tile's own view."
 * This is that setting, built the way `TileMotionPicker` built R19's per-tile
 * animation: a select for the tile the operator selected and a row of selects
 * for the seven groups, both writing ordinary settings so a chosen view lands
 * in undo, in the history and in the issue draft with everything else.
 *
 * The screen a per-tile entry is addressed under comes from the tile registry,
 * not from `ui.route`, for the same reason `TileMotionPicker` reads it there --
 * see `./selectedTile`.
 */
export function TilePresentationPicker() {
  // The subscription behind every label here, including the ones
  // `tileCategoryLabel` and `tilePresentationLabel` resolve.
  const t = useTranslate();
  const levelOptions = [
    { value: 'auto', label: tilePresentationLabel('auto') },
    ...tilePresentationLevels.map((level) => ({
      value: level,
      label: tilePresentationLabel(level),
    })),
  ];
  const selected = useSelectedTile();
  const tileEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.presentationOverrides']),
  );
  const categoryEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.categoryPresentation']),
  );

  const perTile = readTilePresentations(tileEntries);
  const perCategory = readCategoryPresentations(categoryEntries);

  return (
    <div className="edit-tile-presentation">
      <h3>{t('edit.tilePresentation.heading')}</h3>
      {selected === null ? (
        // Said rather than hidden: a control that appears only once the operator
        // has already done the thing it needs cannot teach them to do it.
        <p className="edit-tile-presentation__hint">{t('edit.tilePresentation.hint')}</p>
      ) : (
        <TerminalSelect
          label={t('edit.tilePresentation.tile', { tile: selected.id.toUpperCase() })}
          value={perTile.get(`${selected.screen}:${selected.id}`) ?? 'auto'}
          options={levelOptions}
          onValueChange={(value) =>
            operationsStore.getState().applySettingsPatch([
              {
                id: 'tiles.presentationOverrides',
                value: withTilePresentation(
                  tileEntries,
                  selected.screen,
                  selected.id,
                  value as TilePresentationLevel | 'auto',
                ),
              },
            ])
          }
        />
      )}
      {tileCategories.map((category) => (
        <TerminalSelect
          key={category}
          label={t('edit.tilePresentation.category', { category: tileCategoryLabel(category) })}
          value={perCategory.get(category) ?? 'auto'}
          options={levelOptions}
          onValueChange={(value) =>
            operationsStore.getState().applySettingsPatch([
              {
                id: 'tiles.categoryPresentation',
                value: withCategoryPresentation(
                  categoryEntries,
                  category,
                  value as TilePresentationLevel | 'auto',
                ),
              },
            ])
          }
        />
      ))}
    </div>
  );
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
