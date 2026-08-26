// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contentElementId } from '../../application/edit/contentFields';
import { operationsStore } from '../../state/operationsStore';
import { EditableContent } from './EditableContent';

describe('EditableContent', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
  });

  it('renders the value as plain text outside edit mode', () => {
    const { container } = render(
      <EditableContent field="case.title" entityId="CASE-01">
        НАБЛЮДЕНИЕ / K-01
      </EditableContent>,
    );

    expect(container.querySelector('button')).toBeNull();
    expect(screen.getByText('НАБЛЮДЕНИЕ / K-01')).toBeTruthy();
  });

  it('renders plain for a field the registry does not declare, even in edit mode', () => {
    operationsStore.getState().enterEditMode();
    const { container } = render(
      <EditableContent field="case.priority" entityId="CASE-01">
        P3
      </EditableContent>,
    );

    expect(container.querySelector('button')).toBeNull();
  });

  it('selects the field for the panel in edit mode, and clears it on a second press', () => {
    operationsStore.getState().enterEditMode();
    render(
      <EditableContent field="case.title" entityId="CASE-01">
        НАБЛЮДЕНИЕ / K-01
      </EditableContent>,
    );

    const control = screen.getByRole('button', { name: 'НАБЛЮДЕНИЕ / K-01' });
    fireEvent.click(control);
    expect(operationsStore.getState().edit.selectedElementId).toBe(
      contentElementId('case.title', 'CASE-01'),
    );
    expect(control.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(control);
    expect(operationsStore.getState().edit.selectedElementId).toBe('');
  });

  it('does not also act on the row it sits in', () => {
    operationsStore.getState().enterEditMode();
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <EditableContent field="case.title" entityId="CASE-01">
          НАБЛЮДЕНИЕ / K-01
        </EditableContent>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'НАБЛЮДЕНИЕ / K-01' }));

    // The registry rows select their record on click; selecting a field to
    // edit is a different act and must not also change the selected case.
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('does not open the record when two quick corrections reach a row that opens on a double click', () => {
    operationsStore.getState().enterEditMode();
    const rowOpen = vi.fn();
    render(
      <div onDoubleClick={rowOpen}>
        <EditableContent field="case.title" entityId="CASE-01">
          НАБЛЮДЕНИЕ / K-01
        </EditableContent>
      </div>,
    );

    const control = screen.getByRole('button', { name: 'НАБЛЮДЕНИЕ / K-01' });
    fireEvent.click(control);
    fireEvent.click(control);
    fireEvent.doubleClick(control);

    // The case registry opens a case on a double click on its row. Two
    // corrections made in quick succession are two selections, not a request
    // to leave the screen the operator is editing.
    expect(rowOpen).not.toHaveBeenCalled();
  });
});
