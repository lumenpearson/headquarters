'use client';

import { tileCategories } from '@gremuchaya/settings-schema';
import { TerminalSwitch } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import { tileCategoryLabel } from '@/application/localization/tileLabels';
import { useScreenTiles } from '@/components/layout/tileRegistry';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * Switching tiles and whole groups off, on the screen the operator is looking
 * at.
 *
 * R3 asks for hiding tiles and categories. Both were reachable before this
 * only by typing identifiers into a string list in the settings catalogue,
 * which is a way of saying the capability exists rather than a way of using
 * it: the operator had to know that the case registry is called `registry` and
 * that it now answers to `cases:registry`.
 *
 * The list comes from what the mounted screen declared, so a tile that no
 * screen draws cannot appear here offering to hide something that is not
 * there.
 */
export function TileVisibility() {
  const t = useTranslate();
  const tiles = useScreenTiles();
  const hiddenIds = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.hiddenIds']),
  );
  const hiddenCategories = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.hiddenCategories']),
  );

  if (tiles.length === 0) return null;

  // Only the groups this screen actually has: offering to switch off a group
  // with nothing on screen in it is a control that does nothing here.
  const present = tileCategories.filter((category) =>
    tiles.some((tile) => tile.category === category),
  );

  return (
    <section className="edit-tiles">
      <header>
        <strong>{t('edit.tiles.heading')}</strong>
        <span>{tiles.length}</span>
      </header>
      {tiles.map((tile) => {
        const hiddenByCategory = hiddenCategories.includes(tile.category);
        return (
          <TerminalSwitch
            key={tile.key}
            label={tile.title}
            checked={!hiddenIds.includes(tile.key) && !hiddenByCategory}
            disabled={hiddenByCategory}
            onCheckedChange={(shown) => {
              operationsStore.getState().applySettingsPatch([
                {
                  id: 'tiles.hiddenIds',
                  value: shown
                    ? hiddenIds.filter((id) => id !== tile.key)
                    : [...hiddenIds, tile.key],
                },
              ]);
            }}
          />
        );
      })}
      <header>
        <strong>{t('edit.tiles.groups')}</strong>
        <span>{present.length}</span>
      </header>
      {present.map((category) => (
        <TerminalSwitch
          key={category}
          label={tileCategoryLabel(category)}
          checked={!hiddenCategories.includes(category)}
          onCheckedChange={(shown) => {
            operationsStore.getState().applySettingsPatch([
              {
                id: 'tiles.hiddenCategories',
                value: shown
                  ? hiddenCategories.filter((item) => item !== category)
                  : [...hiddenCategories, category],
              },
            ]);
          }}
        />
      ))}
    </section>
  );
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
