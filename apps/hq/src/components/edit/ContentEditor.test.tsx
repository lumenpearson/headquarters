// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { contentElementId } from '../../application/edit/contentFields';
import { operationsStore } from '../../state/operationsStore';
import { ContentEditor } from './ContentEditor';

describe('ContentEditor', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
  });

  it('tells a screen reader that a refused value was refused', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().selectEditElement(contentElementId('case.title', 'CASE-01') ?? '');
    render(<ContentEditor />);

    const field = screen.getByRole('textbox');
    expect(field.getAttribute('aria-invalid')).toBeNull();

    // Past the field's own ceiling: the store's validator refuses it, and the
    // panel has to say so in a way a reader announces. The text control
    // commits on blur, not on every keystroke.
    fireEvent.change(field, { target: { value: 'Т'.repeat(400) } });
    fireEvent.blur(field);

    const message = screen.getByRole('status');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(message.getAttribute('id'));
    expect(message.textContent).toBeTruthy();
  });
});
