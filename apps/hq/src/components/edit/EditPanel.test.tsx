// @vitest-environment jsdom
import { settingsDefinitions } from '@gremuchaya/settings-schema';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { contentElementId } from '../../application/edit/contentFields';
import { settingGroups } from '../../application/personalization/catalog';
import { operationsStore } from '../../state/operationsStore';
import { settingLabel } from '../settings/SchemaSetting';
import { EditPanel } from './EditPanel';

function button(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

describe('EditPanel', () => {
  beforeEach(() => {
    // resetWorld rebuilds from createBaseState, so the personalization slice
    // comes back with empty undo/redo stacks. resetAllSettings would not do:
    // it is itself a reversible operation and pushes onto the undo stack,
    // which is exactly what the first test below asserts is empty.
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
  });

  it('renders nothing while edit mode is off', () => {
    const { container } = render(<EditPanel />);
    expect(container.querySelector('.edit-panel')).toBeNull();
  });

  it('reflects the store dock edge, so the resolver result is what positions it', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().dockEditPanel('left');
    const { container } = render(<EditPanel />);
    expect(container.querySelector('.edit-panel')?.getAttribute('data-edge')).toBe('left');
  });

  it('disables undo and the issue draft until something is actually changed', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);

    expect(button(/отменить/i).disabled).toBe(true);
    expect(button(/issue/i).disabled).toBe(true);
  });

  it('enables undo and the issue draft once a patch lands', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);

    // Wrapped in act: the store is mutated from outside React here, and
    // without it the assertion runs before the subscription has re-rendered.
    act(() => {
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    });

    expect(button(/отменить/i).disabled).toBe(false);
    expect(button(/issue/i).disabled).toBe(false);
  });

  it('undo goes through the existing settings action rather than a second stack', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    render(<EditPanel />);

    fireEvent.click(button(/отменить/i));

    expect(operationsStore.getState().personalization.draft.values['layout.density']).toBe('dense');
  });

  it('shows a whole section at once, with its categories as headings', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);

    // The panel opens on `appearance`, which spans six categories. The flat
    // select this replaced showed one category at a time out of thirty-two, so
    // more than one heading being present is the difference itself.
    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(headings.length).toBeGreaterThan(1);
    expect(headings).toContain('ТЕМЫ');
    expect(headings).toContain('ТИПОГРАФИКА');

    // Settings from more than one of those categories are on screen together.
    expect(screen.getByText(settingLabel('themes.id'))).toBeTruthy();
    expect(screen.getByText(settingLabel('typography.weight'))).toBeTruthy();
  });

  it('offers seven sections rather than thirty-two categories', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);

    // The count is the point: a flat list of thirty-two was the thing that had
    // stopped being navigable in a panel this narrow.
    expect(settingGroups).toHaveLength(7);
    expect(screen.getByRole('combobox', { name: /раздел/i })).toBeTruthy();
  });

  it('searches across every section, not only the open one', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);

    // `advanced.liveEdit` lives in `system`; the panel is open on `appearance`.
    expect(screen.queryByText(settingLabel('advanced.liveEdit'))).toBeNull();

    fireEvent.change(screen.getByLabelText('Поиск по настройкам'), {
      target: { value: 'liveedit' },
    });

    // A search scoped to the open section would answer "no such setting" for a
    // setting that exists, which is the failure a section grouping creates and
    // has to answer for.
    expect(screen.getByText(settingLabel('advanced.liveEdit'))).toBeTruthy();
    expect(screen.queryByText(settingLabel('themes.id'))).toBeNull();
  });

  it('says so when a search matches nothing, instead of showing an empty panel', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);

    fireEvent.change(screen.getByLabelText('Поиск по настройкам'), {
      target: { value: 'нетакойнастройки' },
    });

    // An empty list and a list that has not loaded look the same; only one of
    // them is worth telling the operator about.
    expect(screen.getByText(/ничего не найдено/i)).toBeTruthy();
  });

  it('reaches a setting in every section through search alone', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);
    const box = screen.getByLabelText('Поиск по настройкам');

    // Searching by full identifier is the narrowest possible query, so this
    // walks the whole catalogue one definition at a time. Browsing covers the
    // catalogue too, and Playwright proves that half where the section select
    // actually opens; this proves the search half over all of it.
    for (const definition of settingsDefinitions) {
      fireEvent.change(box, { target: { value: definition.id } });
      expect(screen.queryByText(settingLabel(definition.id))).not.toBeNull();
    }
  });

  it('closing from the panel leaves the draft intact, so edits survive reopening', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    render(<EditPanel />);

    fireEvent.click(button(/закрыть/i));

    expect(operationsStore.getState().edit.active).toBe(false);
    // Exiting edit mode is not a discard: the operator may reopen and publish.
    expect(operationsStore.getState().personalization.draft.values['layout.density']).toBe(
      'comfortable',
    );
  });
});

describe('EditPanel content editing (R4)', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
  });

  it('counts a content edit with the settings and enables undo and the issue draft for it', () => {
    operationsStore.getState().enterEditMode();
    render(<EditPanel />);

    act(() => {
      operationsStore
        .getState()
        .applyContentPatch([{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }]);
    });

    expect(screen.getByText('1 ИЗМЕНЕНИЙ')).toBeTruthy();
    expect(button(/отменить/i).disabled).toBe(false);
    expect(button(/issue/i).disabled).toBe(false);

    // The same undo button, the same stack: a content edit steps back through it.
    fireEvent.click(button(/отменить/i));
    expect(operationsStore.getState().content.overrides).toEqual({});
    expect(screen.getByText('0 ИЗМЕНЕНИЙ')).toBeTruthy();
  });

  it('shows the editor for the content field selected on screen and applies a date at once', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().selectEditElement(contentElementId('case.createdAt', 'CASE-01'));
    render(<EditPanel />);

    expect(screen.getByText('СОДЕРЖИМОЕ / CONTENT')).toBeTruthy();
    const input = screen.getByLabelText('ДАТА ДЕЛА') as HTMLInputElement;
    expect(input.type).toBe('date');

    fireEvent.change(input, { target: { value: '2026-09-01' } });

    expect(operationsStore.getState().content.overrides['case.createdAt@CASE-01']).toBe(
      '2026-09-01',
    );
    expect(
      new Date(operationsStore.getState().cases['CASE-01']?.createdAt ?? '').toLocaleDateString(
        'ru-RU',
      ),
    ).toBe('01.09.2026');
  });

  it('commits a text field on Enter and offers the way back to the seed value', () => {
    const seedTitle = operationsStore.getState().cases['CASE-01']?.title;
    operationsStore.getState().enterEditMode();
    operationsStore.getState().selectEditElement(contentElementId('case.title', 'CASE-01'));
    render(<EditPanel />);

    const input = screen.getByLabelText('НАЗВАНИЕ ДЕЛА');
    fireEvent.change(input, { target: { value: 'НОВОЕ НАЗВАНИЕ' } });
    // Typing alone commits nothing: undo would otherwise step back a letter.
    expect(operationsStore.getState().cases['CASE-01']?.title).toBe(seedTitle);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(operationsStore.getState().cases['CASE-01']?.title).toBe('НОВОЕ НАЗВАНИЕ');

    fireEvent.click(
      screen.getByRole('button', { name: 'Вернуть исходное значение: case.title@CASE-01' }),
    );
    expect(operationsStore.getState().cases['CASE-01']?.title).toBe(seedTitle);
    expect(operationsStore.getState().content.overrides).toEqual({});
  });

  it('says why a value was refused instead of failing silently', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().selectEditElement(contentElementId('case.title', 'CASE-01'));
    render(<EditPanel />);

    const input = screen.getByLabelText('НАЗВАНИЕ ДЕЛА');
    fireEvent.change(input, { target: { value: 'AB' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('ЗНАЧЕНИЕ ОТКЛОНЕНО')).toBeTruthy();
    expect(operationsStore.getState().content.overrides).toEqual({});
  });
});
