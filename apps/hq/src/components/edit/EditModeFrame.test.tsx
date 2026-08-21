// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '../../state/operationsStore';
import { EditModeFrame } from './EditModeFrame';

describe('EditModeFrame', () => {
  beforeEach(() => {
    operationsStore.getState().exitEditMode();
  });

  it('renders nothing while edit mode is off', () => {
    const { container } = render(<EditModeFrame />);
    expect(container.querySelector('.edit-mode-frame')).toBeNull();
  });

  it('renders the gradient frame once edit mode is on', () => {
    operationsStore.getState().enterEditMode();
    const { container } = render(<EditModeFrame />);
    expect(container.querySelector('.edit-mode-frame')).not.toBeNull();
  });

  it('is decorative rather than a landmark a screen reader announces', () => {
    // A full-viewport overlay with no accessible name would otherwise be read
    // as an unlabelled region on every page in edit mode.
    operationsStore.getState().enterEditMode();
    const { container } = render(<EditModeFrame />);
    expect(container.querySelector('.edit-mode-frame')?.getAttribute('aria-hidden')).toBe('true');
  });
});
