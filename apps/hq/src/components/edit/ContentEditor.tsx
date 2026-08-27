'use client';

import { TerminalButton, TerminalInput, TerminalTextarea } from '@gremuchaya/ui/primitives';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';

import {
  ContentPatchError,
  contentKey,
  fromLocalDateTimeInput,
  getContentFieldDefinition,
  parseContentElementId,
  parseContentKey,
  readContentValue,
  seedContentValue,
  toLocalDateTimeInput,
  type ContentFieldDefinition,
  type ContentFieldEditor,
  type ContentPatchRejection,
  type ContentTarget,
} from '@/application/edit/contentFields';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

const rejectionLabels: Readonly<Record<ContentPatchRejection, string>> = {
  'unknown-field': 'ПОЛЕ НЕ РЕДАКТИРУЕТСЯ',
  'unknown-entity': 'ЗАПИСЬ НЕ ИЗ ИСХОДНОГО МИРА',
  'invalid-value': 'ЗНАЧЕНИЕ ОТКЛОНЕНО',
};

/**
 * Where this instance of the editor is mounted. The editor is rendered from
 * two places and draws in exactly one of them at a time; see
 * {@link ContentEditor}.
 */
export type ContentEditorHost = 'panel' | 'drawer';

/**
 * The content section of edit mode (R4): the field the operator selected on
 * screen, then every content value that differs from the seed, each with its
 * own way back.
 *
 * Nothing here when nothing is selected and nothing is changed. The values on
 * screen are what teach the gesture -- in edit mode each one wears a dashed
 * edge -- so a standing hint would say what the screen already shows.
 *
 * **It follows the selection into a card.** Four editable values live inside
 * the event card, and a card is a modal dialog: while one is open Base UI
 * marks every other body child `aria-hidden`, traps the tab ring inside the
 * popup and lays a full-screen backdrop over the document. Measured on the
 * running application -- twelve consecutive Tab presses never left the card,
 * `.edit-panel` carried `aria-hidden="true"`, and a click on the field in the
 * panel was refused for four seconds -- so an operator could select an event's
 * date and never reach the control that changes it. The editor therefore
 * renders inside the card while a card is open and back in the panel when it
 * closes, rather than in both at once: two mounted copies would mean two
 * drafts of one field and two elements sharing the error message's id.
 */
export function ContentEditor({ host = 'panel' }: { readonly host?: ContentEditorHost } = {}) {
  const active = useOperationsStore((state) => state.edit.active);
  // A card, not this component, is what makes the panel unreachable, so which
  // host draws is decided by whether a card is open at all.
  const carded = useOperationsStore((state) => state.ui.drawer !== null);
  const selected = useOperationsStore((state) => state.edit.selectedElementId);
  const overrides = useOperationsStore((state) => state.content.overrides);
  const target = parseContentElementId(selected);
  const definition = target === undefined ? undefined : getContentFieldDefinition(target.id);
  const value = useOperationsStore((state) =>
    target === undefined || definition === undefined
      ? undefined
      : readContentValue(state, target.id, target.entityId),
  );
  const changed = Object.entries(overrides);

  // The panel only exists in edit mode; a card exists whether or not edit mode
  // does, so the mode is checked here rather than left to the caller.
  if (!active) return null;
  if (host === 'drawer' && !carded) return null;
  if (host === 'panel' && carded) return null;
  if (definition === undefined && changed.length === 0) return null;

  return (
    <section className="edit-panel__category edit-content">
      <h3>СОДЕРЖИМОЕ / CONTENT</h3>
      {target !== undefined && definition !== undefined && value !== undefined ? (
        // Keyed by the selection so a text draft never carries over from one
        // field to the next.
        <ContentFieldControl key={selected} definition={definition} target={target} value={value} />
      ) : null}
      {changed.length > 0 ? (
        <ul className="edit-content__changed">
          {changed.map(([key, current]) => {
            const entry = parseContentKey(key);
            const label = entry === undefined ? key : getContentFieldDefinition(entry.id)?.label;
            return (
              <li key={key}>
                <span>
                  <strong>{label ?? key}</strong>
                  <small>
                    {entry?.entityId} · {current}
                  </small>
                </span>
                <TerminalButton
                  size="small"
                  tone="quiet"
                  aria-label={`Вернуть исходное значение: ${key}`}
                  disabled={entry === undefined}
                  onClick={() => {
                    if (entry !== undefined) resetToSeed(entry);
                  }}
                >
                  [↺]
                </TerminalButton>
              </li>
            );
          })}
        </ul>
      ) : null}
      {changed.length > 0 ? (
        <TerminalButton
          size="small"
          tone="quiet"
          onClick={() => {
            operationsStore.getState().resetContentEdits();
          }}
        >
          ВЕРНУТЬ ВСЁ СОДЕРЖИМОЕ
        </TerminalButton>
      ) : null}
    </section>
  );
}

/**
 * A reset is a patch back to the seed value: the override disappears because
 * the value equals the seed's, and the ledger records it as the patch it is.
 */
function resetToSeed(target: ContentTarget): void {
  const seed = seedContentValue(target.id, target.entityId);
  if (seed === undefined) return;
  operationsStore.getState().applyContentPatch([{ ...target, value: seed }]);
}

function ContentFieldControl({
  definition,
  target,
  value,
}: {
  readonly definition: ContentFieldDefinition;
  readonly target: ContentTarget;
  readonly value: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const changed = useOperationsStore(
    (state) => state.content.overrides[contentKey(target.id, target.entityId)] !== undefined,
  );
  const seed = seedContentValue(target.id, target.entityId);
  const label = `${definition.label}${changed ? ' *' : ''}`;
  // A rejection has to reach a screen reader, not only the eye: the control
  // says it is invalid and names the message, and the message announces
  // itself politely so it is read without stealing focus from the field.
  const errorId = `edit-content-error-${contentKey(target.id, target.entityId)}`;
  const invalid = error === null ? {} : { 'aria-invalid': true, 'aria-describedby': errorId };

  // Applied the moment the control reports a value: that is R17 for content,
  // and the store's own validator is the last word rather than this control.
  const commit = (next: string): void => {
    try {
      operationsStore.getState().applyContentPatch([{ ...target, value: next }]);
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof ContentPatchError
          ? rejectionLabels[failure.reason]
          : rejectionLabels['invalid-value'],
      );
    }
  };

  const editor = definition.editor;
  const control = (() => {
    switch (editor.kind) {
      case 'date':
        return (
          <TerminalInput
            type="date"
            aria-label={label}
            {...invalid}
            value={value}
            onValueChange={(next) => {
              // A cleared picker reports an empty string; nothing to apply.
              if (next !== '') commit(next);
            }}
          />
        );
      case 'time':
        return (
          <TerminalInput
            type="time"
            step={1}
            aria-label={label}
            {...invalid}
            value={value}
            onValueChange={(next) => {
              if (next !== '') commit(next);
            }}
          />
        );
      case 'datetime':
        return (
          <TerminalInput
            type="datetime-local"
            step={1}
            aria-label={label}
            {...invalid}
            value={toLocalDateTimeInput(value)}
            onValueChange={(next) => {
              const instant = fromLocalDateTimeInput(next);
              if (instant !== undefined) commit(instant);
            }}
          />
        );
      case 'text':
        return (
          <ContentTextControl
            label={label}
            editor={editor}
            value={value}
            onCommit={commit}
            invalid={invalid}
          />
        );
    }
  })();

  return (
    <div className="edit-content__field">
      <span>
        <strong>{label}</strong>
        <small>
          {target.entityId} · ИСХОДНОЕ: {seed ?? '—'}
        </small>
      </span>
      {control}
      {error === null ? null : (
        <small id={errorId} role="status" className="edit-content__error">
          {error}
        </small>
      )}
    </div>
  );
}

/**
 * The one place the panel holds a draft of its own: keystrokes stay here until
 * Enter or blur, because a history entry per keystroke would make undo step
 * back one letter at a time and fill the ledger with a word.
 */
function ContentTextControl({
  label,
  editor,
  value,
  onCommit,
  invalid,
}: {
  readonly label: string;
  readonly editor: Extract<ContentFieldEditor, { kind: 'text' }>;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly invalid: Readonly<Record<string, unknown>>;
}) {
  const [draft, setDraft] = useState(value);
  const [committed, setCommitted] = useState(value);
  // An undo or another session moves the value under the control; the draft
  // follows it rather than holding stale text over a changed field.
  if (value !== committed) {
    setCommitted(value);
    setDraft(value);
  }

  const commit = (): void => {
    const next = draft.trim();
    if (next === '' || next === value) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };

  if (editor.multiline) {
    return (
      <TerminalTextarea
        aria-label={label}
        {...invalid}
        rows={4}
        maxLength={editor.maxLength}
        value={draft}
        onValueChange={setDraft}
        onBlur={commit}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit();
          }
        }}
      />
    );
  }

  return (
    <TerminalInput
      aria-label={label}
      {...invalid}
      maxLength={editor.maxLength}
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
  );
}
