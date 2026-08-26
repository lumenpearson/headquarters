'use client';

import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';

import { parseContentElementId } from '@/application/edit/contentFields';
import {
  elementTranslation,
  elementTranslationsFor,
  elementTranslationsSetting,
  maxElementTranslationLength,
  withElementTranslation,
} from '@/application/localization/elementTranslations';
import { useAppLocale, useTranslate } from '@/application/localization/locale';
import { buildTranslationRequestUrl } from '@/application/localization/translationRequest';
import { repositoryDefaultBranch, repositorySlug } from '@/application/repository';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * R28's edit-mode half, and the link that carries it out of the application.
 *
 * The gesture is the one `TileMotionPicker` established: press a tile, and the
 * panel offers what can be said about that tile. What is said here is its
 * caption in the language now selected, stored as an ordinary setting -- so it
 * lands in undo, in the settings history, in the issue draft and in the group
 * scope with every other change, which is the whole argument for not giving
 * edit mode a store of its own.
 *
 * The route is re-applied at read and at write, exactly as the motion picker
 * does it: `edit.selectedElementId` holds a bare tile id, and `registry` is
 * the table on four screens. A caption stored without the screen would rename
 * all four.
 */
export function ElementTranslation() {
  const t = useTranslate();
  const locale = useAppLocale();
  const selectedElement = useOperationsStore((state) => state.edit.selectedElementId);
  // The selection is shared with content fields (R4) and with the motion
  // picker; a content field is not a tile and has its own editor.
  const selected = parseContentElementId(selectedElement) === undefined ? selectedElement : '';
  const screen = useOperationsStore((state) => state.ui.route);
  const entries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values[elementTranslationsSetting]),
  );

  /*
   * The definition is looked up rather than assumed.
   *
   * `packages/settings-schema` does not declare `localization.elementOverrides`
   * yet, and `applyDraftPatch` answers an unknown id by throwing
   * `UnknownSettingError` -- so a field wired straight to `applySettingsPatch`
   * would take a caption and fail on the keystroke that committed it. The
   * panel says what is missing instead of offering a control that cannot work.
   */
  const stored = getSettingDefinition(elementTranslationsSetting) !== undefined;
  const mine = elementTranslationsFor(entries, locale);

  return (
    <div className="edit-tile-motion">
      <h3>{t('edit.translation.heading')}</h3>
      {!stored ? (
        <p className="edit-tile-motion__hint">{t('edit.translation.unavailable')}</p>
      ) : selected === '' ? (
        // Said rather than hidden, in the idiom the motion picker uses: a
        // control that appears only once the operator has already done the
        // thing it needs cannot teach them to do it.
        <p className="edit-tile-motion__hint">{t('edit.translation.hint')}</p>
      ) : (
        <CaptionField
          // Keyed by the selection and the locale so a draft never carries
          // over from one element, or one language, to the next.
          key={`${locale}:${screen}:${selected}`}
          label={t('edit.translation.field', { element: selected.toUpperCase(), locale })}
          resetLabel={t('edit.translation.reset')}
          value={elementTranslation(entries, { locale, screen, element: selected }) ?? ''}
          onCommit={(text) => {
            operationsStore.getState().applySettingsPatch([
              {
                id: elementTranslationsSetting,
                value: withElementTranslation(entries, { locale, screen, element: selected }, text),
              },
            ]);
          }}
        />
      )}
      <p className="edit-tile-motion__hint">
        {t('edit.translation.count', { count: mine.length })}
      </p>
      <TerminalButton
        size="small"
        disabled={mine.length === 0}
        onClick={() => {
          window.open(
            buildTranslationRequestUrl({
              repository: repositorySlug,
              branch: repositoryDefaultBranch,
              locale,
              entries: mine,
              now: new Date(),
            }),
            '_blank',
            'noopener',
          );
        }}
      >
        {t('edit.translation.propose')}
      </TerminalButton>
      {/*
       * The honesty note, in the panel rather than only in the commit form:
       * the operator is about to leave for GitHub, and a pull request has no
       * address until they commit. Nothing here holds a token, so nothing here
       * can go and look for it afterwards.
       */}
      <p className="edit-tile-motion__hint">{t('edit.translation.proposeHint')}</p>
    </div>
  );
}

/**
 * The one place this section holds a draft of its own.
 *
 * Keystrokes stay here until Enter or blur, the way `ContentEditor` handles
 * free text: a settings-history entry per keystroke would make undo step back
 * one letter at a time and fill the ledger with a word.
 */
function CaptionField({
  label,
  resetLabel,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly resetLabel: string;
  readonly value: string;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [committed, setCommitted] = useState(value);
  // An undo, or another session of the group, moves the value under the
  // control; the draft follows it rather than holding stale text.
  if (value !== committed) {
    setCommitted(value);
    setDraft(value);
  }

  const commit = (): void => {
    const next = draft.trim();
    if (next === value) return;
    onCommit(next);
  };

  return (
    <>
      <TerminalInput
        aria-label={label}
        maxLength={maxElementTranslationLength}
        value={draft}
        onValueChange={setDraft}
        onBlur={commit}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
      <TerminalButton
        size="small"
        tone="quiet"
        disabled={value === ''}
        onClick={() => {
          setDraft('');
          onCommit('');
        }}
      >
        {resetLabel}
      </TerminalButton>
    </>
  );
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
