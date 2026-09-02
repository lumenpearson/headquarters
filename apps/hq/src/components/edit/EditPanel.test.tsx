// @vitest-environment jsdom
import { settingsDefinitions } from '@gremuchaya/settings-schema';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contentElementId } from '../../application/edit/contentFields';
import { localizedSettingLabel } from '../../application/localization/settingLocalization';
import { settingGroups } from '../../application/personalization/catalog';
import { operationsStore } from '../../state/operationsStore';
import { fireKeybind } from '../keybinds/KeybindRuntime';
import { EditPanel } from './EditPanel';

function button(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

/**
 * The row label the panel actually draws, for the id given: `SchemaSetting`
 * reads it through `localizedSettingLabel`, not through the raw id-surgery
 * `settingLabel()` falls back to -- every definition has a translated label
 * as of this pass, so the two would no longer agree.
 */
function rowLabel(id: string): string {
  const definition = settingsDefinitions.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`${id} is not declared`);
  return localizedSettingLabel(definition, 'ru');
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

  it('opens as the collapsed pill, and its own control expands it', () => {
    operationsStore.getState().enterEditMode();
    const { container } = render(<EditPanel />);
    const panel = () => container.querySelector('.edit-panel');
    expect(panel()?.getAttribute('data-expanded')).toBe('false');

    const toggle = screen.getByRole('button', { name: 'Развернуть панель' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(operationsStore.getState().edit.panelExpanded).toBe(true);
    expect(panel()?.getAttribute('data-expanded')).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Свернуть панель' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('docks to the next edge from the keyboard, alongside the pointer drag', () => {
    // The keyboard equivalent of the magnetic edge dragging snaps to: there is
    // no pointer release position to read, so the chord cycles the same four
    // edges instead of picking one directly. The panel starts collapsed here,
    // which is the state this chord has to keep working in -- the docking
    // machinery is on the one root shared with the expanded body, not on a
    // second component.
    operationsStore.getState().enterEditMode();
    operationsStore.getState().dockEditPanel('left');
    const { container } = render(<EditPanel />);
    const panel = () => container.querySelector('.edit-panel');
    expect(panel()?.getAttribute('data-expanded')).toBe('false');
    expect(panel()?.getAttribute('data-edge')).toBe('left');

    act(() => {
      fireKeybind('edit.dockPanel');
    });
    expect(panel()?.getAttribute('data-edge')).toBe('top');

    act(() => {
      fireKeybind('edit.dockPanel');
    });
    expect(panel()?.getAttribute('data-edge')).toBe('right');
  });

  it('docks to the next edge from the keyboard while the panel is expanded too', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().dockEditPanel('left');
    operationsStore.getState().setEditPanelExpanded(true);
    const { container } = render(<EditPanel />);
    const panel = () => container.querySelector('.edit-panel');
    expect(panel()?.getAttribute('data-expanded')).toBe('true');
    expect(panel()?.getAttribute('data-edge')).toBe('left');

    act(() => {
      fireKeybind('edit.dockPanel');
    });
    expect(panel()?.getAttribute('data-edge')).toBe('top');
  });

  it('does nothing while edit mode is off, though there is no panel to dock', () => {
    // `EditPanel` is mounted whether or not edit mode is active -- it only
    // renders `null` -- so the chord stays claimed and `fireKeybind` reports
    // it ran; the guard inside the handler is what keeps it a no-op here,
    // the same way the panel's own placement effects guard themselves.
    operationsStore.getState().dockEditPanel('left');
    render(<EditPanel />);

    expect(fireKeybind('edit.dockPanel')).toBe(true);
    expect(operationsStore.getState().edit.dockEdge).toBe('left');
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
    expect(screen.getByText(rowLabel('themes.id'))).toBeTruthy();
    expect(screen.getByText(rowLabel('typography.weight'))).toBeTruthy();
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
    expect(screen.queryByText(rowLabel('advanced.liveEdit'))).toBeNull();

    fireEvent.change(screen.getByLabelText('Поиск по настройкам'), {
      target: { value: 'liveedit' },
    });

    // A search scoped to the open section would answer "no such setting" for a
    // setting that exists, which is the failure a section grouping creates and
    // has to answer for.
    expect(screen.getByText(rowLabel('advanced.liveEdit'))).toBeTruthy();
    expect(screen.queryByText(rowLabel('themes.id'))).toBeNull();
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
      expect(screen.queryByText(localizedSettingLabel(definition, 'ru'))).not.toBeNull();
    }
    // One render per definition over the whole catalogue is the point of the
    // test and legitimately outgrows the default five-second budget as the
    // panel and the registry gain sections; the walk is linear, not hung.
  }, 30000);

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

  it('expands the collapsed pill the moment an element is selected, not only before it mounts', () => {
    operationsStore.getState().enterEditMode();
    const { container } = render(<EditPanel />);
    expect(container.querySelector('.edit-panel')?.getAttribute('data-expanded')).toBe('false');

    act(() => {
      operationsStore.getState().selectEditElement(contentElementId('case.title', 'CASE-01'));
    });

    // A collapsed pill answering a selection with nothing would make it look
    // ignored; this is the live transition, not the panel mounting already
    // expanded because the selection was made before it rendered.
    expect(container.querySelector('.edit-panel')?.getAttribute('data-expanded')).toBe('true');
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

/*
 * The drag lifecycle, at the one point the pointer contract is easy to get
 * wrong: a cancelled pointer -- the window losing focus mid-drag, a touch
 * stolen by the system -- delivers `pointercancel` and never `pointerup`.
 * Before the cancel handler existed, the panel stayed in `data-dragging`
 * forever: transitions off, grabbing cursor, and the next click on the
 * header could not clear it because the click path returned before touching
 * the state.
 */
describe('EditPanel drag lifecycle', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
    // jsdom implements no pointer capture; the handlers only need the calls
    // to exist, the way the screen tests stub ResizeObserver.
    Object.assign(HTMLElement.prototype, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => false,
    });
  });

  it('a cancelled drag does not leave the panel stuck in the dragging state', () => {
    operationsStore.getState().enterEditMode();
    const { container } = render(<EditPanel />);
    const panel = container.querySelector('.edit-panel');
    if (panel === null) throw new Error('the edit panel did not render');
    const title = screen.getByText('РЕДАКТИРОВАНИЕ');

    fireEvent.pointerDown(title, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 140, clientY: 120 });
    expect(panel.getAttribute('data-dragging')).toBe('true');

    fireEvent.pointerCancel(panel, { pointerId: 1 });
    expect(panel.getAttribute('data-dragging')).toBe('false');

    // The next press on the header is a click again: it must neither re-dock
    // the panel with the coordinates the cancelled drag left behind nor put
    // the dragging state back.
    const before = operationsStore.getState().edit.dockEdge;
    fireEvent.pointerDown(title, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(title, { pointerId: 2, clientX: 101, clientY: 100 });
    expect(panel.getAttribute('data-dragging')).toBe('false');
    expect(operationsStore.getState().edit.dockEdge).toBe(before);
  });
});
