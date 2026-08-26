'use client';

import { tileCategories } from '@gremuchaya/settings-schema';
import { TerminalSelect } from '@gremuchaya/ui/primitives';

import { parseContentElementId } from '@/application/edit/contentFields';
import { useTranslate } from '@/application/localization/locale';
import { tileCategoryLabel, tileMotionLabel } from '@/application/localization/tileLabels';
import {
  readCategoryMotions,
  readTileMotions,
  tileMotions,
  withCategoryMotion,
  withTileMotion,
  type TileMotion,
} from '@/application/personalization/tileMotion';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * The animation of one tile, and of a whole group of them.
 *
 * This is what `edit.selectedElementId` has been for since F5 gave it its first
 * caller. Until now selecting a tile drew an outline and nothing else, which is
 * the shape R19's per-element half was missing: the gesture existed, the
 * storage idiom existed (`tiles.spans`), and there was nothing between them.
 *
 * Both controls write ordinary settings, so a per-tile animation lands in undo,
 * in the history and in the issue draft with everything else. That is the whole
 * argument for storing it as a setting rather than as a field of edit state.
 */
export function TileMotionPicker() {
  // The subscription behind every label here, including the ones
  // `tileCategoryLabel` and `tileMotionLabel` resolve.
  const t = useTranslate();
  const motionOptions = tileMotions.map((motion) => ({
    value: motion,
    label: tileMotionLabel(motion),
  }));
  const selectedElement = useOperationsStore((state) => state.edit.selectedElementId);
  // The selection is shared with content fields (R4); one of those is not a
  // tile and gets no motion.
  const selected = parseContentElementId(selectedElement) === undefined ? selectedElement : '';
  const screen = useOperationsStore((state) => state.ui.route);
  const tileEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.animations']),
  );
  const categoryEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.categoryAnimations']),
  );

  const perTile = readTileMotions(tileEntries);
  const perCategory = readCategoryMotions(categoryEntries);

  return (
    <div className="edit-tile-motion">
      <h3>{t('edit.tileMotion.heading')}</h3>
      {selected === '' ? (
        // Said rather than hidden: a control that appears only once the operator
        // has already done the thing it needs cannot teach them to do it.
        <p className="edit-tile-motion__hint">{t('edit.tileMotion.hint')}</p>
      ) : (
        <TerminalSelect
          label={t('edit.tileMotion.tile', { tile: selected.toUpperCase() })}
          value={perTile.get(`${screen}:${selected}`) ?? 'inherit'}
          options={motionOptions}
          onValueChange={(value) =>
            operationsStore.getState().applySettingsPatch([
              {
                id: 'tiles.animations',
                value: withTileMotion(tileEntries, screen, selected, value as TileMotion),
              },
            ])
          }
        />
      )}
      {tileCategories.map((category) => (
        <TerminalSelect
          key={category}
          label={t('edit.tileMotion.category', { category: tileCategoryLabel(category) })}
          value={perCategory.get(category) ?? 'inherit'}
          options={motionOptions}
          onValueChange={(value) =>
            operationsStore.getState().applySettingsPatch([
              {
                id: 'tiles.categoryAnimations',
                value: withCategoryMotion(categoryEntries, category, value as TileMotion),
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
