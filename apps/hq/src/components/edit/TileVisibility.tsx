'use client';

import { tileCategories } from '@gremuchaya/settings-schema';
import { TerminalSwitch } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import { tileCategoryLabel } from '@/application/localization/tileLabels';
import { useScreenTiles } from '@/components/layout/tileRegistry';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * Switching tiles and whole groups off, on the screen the operator is looking
 * at -- or, mounted where no screen is (the settings screen, and a route
 * outside the resolver such as `/video` or `/dev/ui`), the groups alone.
 *
 * R3 asks for hiding tiles and categories. Both were reachable before this
 * only by typing identifiers into a string list in the settings catalogue,
 * which is a way of saying the capability exists rather than a way of using
 * it: the operator had to know that the case registry is called `registry` and
 * that it now answers to `cases:registry`. That raw editor is still the
 * settings screen's own field for the same two settings -- this sits above it
 * as the friendlier surface, the way it already sits above the edit panel's.
 *
 * The per-tile list comes from what the mounted screen declared, so a tile no
 * screen draws cannot appear here offering to hide something that is not
 * there. The group list does not have that dependency -- `tileCategories` is
 * the whole roster -- so it stays offered even where nothing is registered,
 * rather than the surface disappearing along with the tiles it cannot name.
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

  // Only the groups this screen actually has, when a screen is registered at
  // all; offering to switch off a group with nothing on screen in it is a
  // control that does nothing there. With nothing registered there is no
  // "this screen" to narrow by, so every group is offered instead of none.
  const present =
    tiles.length === 0
      ? tileCategories
      : tileCategories.filter((category) => tiles.some((tile) => tile.category === category));

  return (
    <section className="edit-tiles grid gap-hq-1 pb-hq-2">
      <header className="flex gap-hq-2 items-baseline justify-between pt-hq-2 border-b border-b-hq-line-2 text-hq-accent text-hq-xs tracking-[0.12em]">
        <strong>{t('edit.tiles.heading')}</strong>
        <span>{tiles.length}</span>
      </header>
      {tiles.length === 0 ? (
        <p className="edit-tiles__empty text-hq-text-2 text-hq-xs tracking-[0.08em]">
          {t('edit.tiles.noneOnScreen')}
        </p>
      ) : null}
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
      <header className="flex gap-hq-2 items-baseline justify-between pt-hq-2 border-b border-b-hq-line-2 text-hq-accent text-hq-xs tracking-[0.12em]">
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
