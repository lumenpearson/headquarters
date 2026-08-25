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
 * The content section of the edit panel (R4): the field the operator selected
 * on screen, then every content value that differs from the seed, each with
 * its own way back.
 *
 * Nothing here when nothing is selected and nothing is changed. The values on
 * screen are what teach the gesture -- in edit mode each one wears a dashed
 * edge -- so a standing hint in the panel would say what the screen already
 * shows.
 */
export function ContentEditor() {
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
            value={toLocalDateTimeInput(value)}
            onValueChange={(next) => {
              const instant = fromLocalDateTimeInput(next);
              if (instant !== undefined) commit(instant);
            }}
          />
        );
      case 'text':
        return <ContentTextControl label={label} editor={editor} value={value} onCommit={commit} />;
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
      {error === null ? null : <small className="edit-content__error">{error}</small>}
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
}: {
  readonly label: string;
  readonly editor: Extract<ContentFieldEditor, { kind: 'text' }>;
  readonly value: string;
  readonly onCommit: (value: string) => void;
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
