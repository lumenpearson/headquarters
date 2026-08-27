// @vitest-environment jsdom
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { elementTranslationsSetting } from '@/application/localization/elementTranslations';
import { publishScreenTiles } from '@/components/layout/tileRegistry';
import { operationsStore } from '@/state/operationsStore';

import { ElementTranslation } from './ElementTranslation';

/**
 * What a mounted `TileGrid` declares on `/archive`.
 *
 * The screen is `files` while `ui.route` is `archive`, which is the divergence
 * this surface used to write into: the panel qualified the bare tile id with
 * the route and the grid reads the key published here. `/objects/:id` and
 * `/cases/:id` diverge the same way.
 */
function publishArchiveGrid(): void {
  publishScreenTiles([
    {
      key: 'files:registry',
      id: 'registry',
      screen: 'files',
      title: 'РЕЕСТР ФАЙЛОВ',
      category: 'records',
    },
  ]);
}

describe('the element-translation surface', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().enterEditMode();
    publishScreenTiles([]);
  });

  it('offers a field that stores, because the definition it stores into exists', () => {
    /*
     * This assertion is the one that flipped. It used to hold the honest state
     * of a panel with nowhere to write: `packages/settings-schema` declared no
     * `localization.elementOverrides`, `applyDraftPatch` answers an unknown id
     * with `UnknownSettingError`, and the panel said so rather than taking a
     * caption and throwing on the keystroke that committed it. The definition
     * has landed, so the notice is gone and the field is here.
     */
    expect(getSettingDefinition(elementTranslationsSetting)).toBeDefined();

    publishArchiveGrid();
    operationsStore.getState().selectEditElement('registry');
    render(<ElementTranslation />);

    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('offers no field for a tile no mounted screen draws', () => {
    /*
     * The selection outlives a navigation, so a tile id can name something
     * that is on no screen. There is no address for it -- the grid that would
     * read the caption is not mounted -- and answering with the current route
     * is what put captions under `archive:registry` where nothing reads them.
     */
    operationsStore.getState().selectEditElement('registry');
    render(<ElementTranslation />);

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Нажмите на плитку/)).toBeTruthy();
  });

  it('commits a caption into the draft rather than throwing on it', () => {
    // The whole point of the definition landing: the keystroke that used to be
    // refused now reaches the same draft as every other setting, which is what
    // carries it into undo, the history and the group scope.
    publishArchiveGrid();
    operationsStore.getState().selectEditElement('registry');
    render(<ElementTranslation />);

    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'СВОДКА СМЕНЫ' } });
    fireEvent.blur(field);

    expect(
      operationsStore.getState().personalization.draft.values[elementTranslationsSetting],
    ).toEqual([`ru:files:registry=${encodeURIComponent('СВОДКА СМЕНЫ')}`]);
  });

  it('stores the caption under the screen the grid published, not under the route', () => {
    /*
     * `/archive` is one of the three routes where the two differ: the route is
     * `archive` and the grid it draws is `files`. The address below is the one
     * `TileGrid` looks up, so a caption written here is a caption the operator
     * sees; `ru:archive:registry` saved, appeared in the catalogue and renamed
     * nothing.
     */
    expect(operationsStore.getState().ui.route).toBe('overview');
    publishArchiveGrid();
    operationsStore.getState().selectEditElement('registry');
    render(<ElementTranslation />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'СМЕНА' } });
    fireEvent.blur(screen.getByRole('textbox'));

    const stored = operationsStore.getState().personalization.draft.values[
      elementTranslationsSetting
    ] as readonly string[];
    expect(stored).toEqual([`ru:files:registry=${encodeURIComponent('СМЕНА')}`]);
    expect(stored.some((entry) => entry.startsWith('ru:overview:'))).toBe(false);
  });

  it('offers no proposal while there is nothing to propose', () => {
    render(<ElementTranslation />);

    // A link built from an empty list throws by contract; the button is drawn
    // and disabled rather than hidden, for the same reason an unclaimed menu
    // command is: a control that disappears is one the operator concludes the
    // build does not have.
    const propose = screen.getByRole('button', { name: 'ЧЕРНОВИК ПЕРЕВОДА' });
    expect((propose as HTMLButtonElement).disabled).toBe(true);
  });

  it('says that the pull request is the operator’s to create', () => {
    render(<ElementTranslation />);

    // Nothing in this path holds a token, so nothing in it can learn the
    // address GitHub gives the pull request. An application that promised a
    // link and produced none would read as a failed request.
    expect(screen.getByText(/не узнает его адрес/)).toBeTruthy();
  });

  it('follows the locale', () => {
    render(<ElementTranslation />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('ПЕРЕВОД ЭЛЕМЕНТА');

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('ELEMENT TRANSLATION');
  });
});
