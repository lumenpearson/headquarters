// @vitest-environment jsdom
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { elementTranslationsSetting } from '@/application/localization/elementTranslations';
import { operationsStore } from '@/state/operationsStore';

import { ElementTranslation } from './ElementTranslation';

describe('the element-translation surface', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().enterEditMode();
  });

  it('says what is missing rather than offering a field that cannot store', () => {
    /*
     * `packages/settings-schema` does not declare
     * `localization.elementOverrides` yet, and `applyDraftPatch` answers an
     * unknown id with `UnknownSettingError` -- so a field wired straight to
     * `applySettingsPatch` would accept a caption and throw on the keystroke
     * that committed it. This asserts the honest state, and it is the
     * assertion that flips the day the definition lands: the notice goes and
     * the field appears.
     */
    expect(getSettingDefinition(elementTranslationsSetting)).toBeUndefined();

    operationsStore.getState().selectEditElement('brief');
    render(<ElementTranslation />);

    expect(screen.getByText(/localization.elementOverrides/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
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
