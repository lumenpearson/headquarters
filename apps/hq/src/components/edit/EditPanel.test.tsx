// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '../../state/operationsStore';
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
