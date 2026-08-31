// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { translateWith } from '@/application/localization/messages';
import {
  setTranslationOverridesForTests,
  translationOverridesStorageKey,
} from '@/application/localization/translationOverrides';

import { TranslationEditorSection } from './TranslationEditorSection';

/*
 * jsdom implements no Web Animations API, and `TerminalScrollArea` (Base UI's
 * `ScrollArea.Viewport`) calls `Element.prototype.getAnimations` on a delayed
 * timer to learn whether its scrollbar's hide transition is still running.
 * Scoped to this file rather than the shared `vitest.setup.ts`: this is the
 * first suite that mounts and unmounts a `TerminalScrollArea` fast enough
 * for that timer to fire during a still-running test.
 */
if (typeof Element.prototype.getAnimations !== 'function') {
  Element.prototype.getAnimations = () => [];
}

/** The row for one message id, once it has been searched into view. */
function rowFor(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`tr[data-message-id="${id}"]`);
  if (row === null) throw new Error(`no row rendered for ${id}`);
  return row;
}

function overrideInput(container: HTMLElement, id: string): HTMLElement {
  return within(rowFor(container, id)).getByRole('textbox');
}

function commit(input: HTMLElement, text: string): void {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

/**
 * Narrows the table to one id via the search box -- every test does this
 * first, the same way an operator would, rather than relying on catalogue
 * order to put a given id on page one.
 */
function searchFor(query: string): void {
  fireEvent.change(screen.getByLabelText('Поиск по идентификатору или тексту'), {
    target: { value: query },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setTranslationOverridesForTests([]);
});

afterEach(() => {
  setTranslationOverridesForTests([]);
});

describe('committing an override', () => {
  it('changes what translateWith renders, and a reset restores the built-in text', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');
    // The tab defaults to `ru`, the source locale -- switch to the locale
    // this assertion actually reads through `translateWith`.
    fireEvent.click(screen.getByRole('tab', { name: /EN/ }));

    expect(translateWith('en', 'nav.overview')).toBe('OVERVIEW');

    const input = overrideInput(container, 'nav.overview');
    commit(input, 'OVERVIEW (OPS)');

    expect(translateWith('en', 'nav.overview')).toBe('OVERVIEW (OPS)');
    expect(JSON.parse(window.localStorage.getItem(translationOverridesStorageKey) ?? '{}')).toEqual(
      { 'en:nav.overview': 'OVERVIEW (OPS)' },
    );

    const reset = within(rowFor(container, 'nav.overview')).getByRole('button', {
      name: /Сбросить/,
    });
    fireEvent.click(reset);

    expect(translateWith('en', 'nav.overview')).toBe('OVERVIEW');
    expect(JSON.parse(window.localStorage.getItem(translationOverridesStorageKey) ?? '{}')).toEqual(
      {},
    );
  });
});

describe('refusal reasons reachable by typing into a row', () => {
  it('refuses text past the length cap, inline, and stores nothing', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');

    const input = overrideInput(container, 'nav.overview');
    commit(input, 'x'.repeat(513));

    const row = rowFor(container, 'nav.overview');
    expect(within(row).getByRole('alert').getAttribute('data-refusal-reason')).toBe('too-long');
    expect(window.localStorage.getItem(translationOverridesStorageKey)).toBeNull();
  });

  it('refuses a control character, inline, and stores nothing', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');

    const input = overrideInput(container, 'nav.overview');
    // A literal control byte pasted into this file would be invisible on
    // review; built from `String.fromCharCode` instead.
    commit(input, `OVER${String.fromCharCode(7)}VIEW`);

    const row = rowFor(container, 'nav.overview');
    expect(within(row).getByRole('alert').getAttribute('data-refusal-reason')).toBe(
      'control-character',
    );
    expect(window.localStorage.getItem(translationOverridesStorageKey)).toBeNull();
  });

  it('refuses a bidi-override character, inline, and stores nothing', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');

    const input = overrideInput(container, 'nav.overview');
    commit(input, `OVER${String.fromCharCode(0x202e)}VIEW`);

    const row = rowFor(container, 'nav.overview');
    expect(within(row).getByRole('alert').getAttribute('data-refusal-reason')).toBe(
      'bidi-override',
    );
    expect(window.localStorage.getItem(translationOverridesStorageKey)).toBeNull();
  });

  it('refuses an override that drops the source message’s placeholder, and stores nothing', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('keybind.navigate');
    fireEvent.click(screen.getByRole('tab', { name: /EN/ }));

    // `keybind.navigate` reads `Go to: {target}`; dropping `{target}` would
    // silently break every numbered-route shortcut label.
    const input = overrideInput(container, 'keybind.navigate');
    commit(input, 'Go to somewhere');

    const row = rowFor(container, 'keybind.navigate');
    expect(within(row).getByRole('alert').getAttribute('data-refusal-reason')).toBe(
      'placeholder-mismatch',
    );
    expect(window.localStorage.getItem(translationOverridesStorageKey)).toBeNull();
  });

  it('refuses an override for a token id, because a token is the same word in every locale', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('token.utc');

    const input = overrideInput(container, 'token.utc');
    commit(input, 'UTC-ALIAS');

    const row = rowFor(container, 'token.utc');
    expect(within(row).getByRole('alert').getAttribute('data-refusal-reason')).toBe(
      'non-catalog-id',
    );
    expect(window.localStorage.getItem(translationOverridesStorageKey)).toBeNull();
  });

  it('refuses an override for a counted message, out of scope for this editor', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('search.matchCount');

    const input = overrideInput(container, 'search.matchCount');
    commit(input, '{count} notice(s)');

    const row = rowFor(container, 'search.matchCount');
    expect(within(row).getByRole('alert').getAttribute('data-refusal-reason')).toBe(
      'plural-message',
    );
    expect(window.localStorage.getItem(translationOverridesStorageKey)).toBeNull();
  });
});

describe('importing a translation file', () => {
  function importFile(container: HTMLElement, text: string, name = 'file.json'): void {
    const input = container.querySelector('input[type="file"]');
    if (input === null) throw new Error('no import input rendered');
    fireEvent.change(input, {
      target: { files: [new File([text], name, { type: 'application/json' })] },
    });
  }

  it('refuses an id the catalogue does not have, by name, without discarding what is already stored', async () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');
    commit(overrideInput(container, 'nav.overview'), 'ОБЗОР (ПРАВКА)');
    expect(JSON.parse(window.localStorage.getItem(translationOverridesStorageKey) ?? '{}')).toEqual(
      { 'ru:nav.overview': 'ОБЗОР (ПРАВКА)' },
    );

    importFile(container, JSON.stringify({ locale: 'ru', overrides: { 'no.such.id': 'GHOST' } }));

    expect(await screen.findByText(/ЗАПИСЬ.*ОТКЛОНЕНА/)).toBeTruthy();
    // Nothing already on disk was touched by the refused import.
    expect(JSON.parse(window.localStorage.getItem(translationOverridesStorageKey) ?? '{}')).toEqual(
      { 'ru:nav.overview': 'ОБЗОР (ПРАВКА)' },
    );
  });

  it('refuses a corrupt file, by name, without discarding what is already stored', async () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');
    commit(overrideInput(container, 'nav.overview'), 'ОБЗОР (ПРАВКА)');

    importFile(container, '{not json');

    expect(await screen.findByText(/ФАЙЛ ОТКЛОНЁН/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(translationOverridesStorageKey) ?? '{}')).toEqual(
      { 'ru:nav.overview': 'ОБЗОР (ПРАВКА)' },
    );
  });

  it('round-trips through export and import', async () => {
    let capturedBlob: Blob | null = null;
    const objectUrl = 'blob:translations';
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        capturedBlob = blob;
        return objectUrl;
      },
      revokeObjectURL: () => undefined,
    });

    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');
    fireEvent.click(screen.getByRole('tab', { name: /EN/ }));
    commit(overrideInput(container, 'nav.overview'), 'OVERVIEW (OPS)');

    fireEvent.click(screen.getByText('[↓] ЭКСПОРТ'));
    expect(capturedBlob).not.toBeNull();
    const exported = JSON.parse(await (capturedBlob as unknown as Blob).text()) as {
      locale: string;
      overrides: Record<string, string>;
    };
    expect(exported).toEqual({ locale: 'en', overrides: { 'nav.overview': 'OVERVIEW (OPS)' } });

    // A fresh session, nothing stored yet. The first render is unmounted
    // first -- `render()`'s returned queries read the whole document, and a
    // second mount without cleanup would leave both on screen at once.
    cleanup();
    window.localStorage.clear();
    setTranslationOverridesForTests([]);
    const second = render(<TranslationEditorSection />);
    fireEvent.click(second.getByRole('tab', { name: /EN/ }));
    fireEvent.change(second.getByLabelText('Поиск по идентификатору или тексту'), {
      target: { value: 'nav.overview' },
    });

    importFile(second.container, JSON.stringify(exported));

    expect(await second.findByText(/ИМПОРТИРОВАНО/)).toBeTruthy();
    expect(translateWith('en', 'nav.overview')).toBe('OVERVIEW (OPS)');

    vi.unstubAllGlobals();
  });
});

describe('staying responsive at catalogue scale', () => {
  it('never mounts more rows than one page, regardless of catalogue size', () => {
    const { container } = render(<TranslationEditorSection />);
    // No search text: every one of the catalogue's 1,800+ ids matches.
    expect(container.querySelectorAll('tr[data-message-id]').length).toBeLessThanOrEqual(30);
  });

  it('narrows to the matching rows when searching', () => {
    const { container } = render(<TranslationEditorSection />);
    searchFor('nav.overview');
    expect(container.querySelectorAll('tr[data-message-id]').length).toBe(1);
    expect(rowFor(container, 'nav.overview')).toBeTruthy();
  });
});
