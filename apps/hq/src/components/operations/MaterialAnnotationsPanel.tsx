'use client';

import { useEffect, useState } from 'react';
import { TerminalButton, TerminalTextarea } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';

import {
  addMaterialAnnotation,
  annotationsFor,
  readMaterialAnnotations,
  removeMaterialAnnotation,
  writeMaterialAnnotations,
  type MaterialAnnotation,
  type MaterialAnnotations,
} from './materialAnnotations';

/**
 * Timestamped notes on the material currently in the player, the surface half
 * of F9/R21's "no model, no store region, no surface." Reads and writes
 * `localStorage` directly, in the idiom `VideoScreen.tsx` already uses for
 * `cameraMaterialAssignments` -- a narrow, presentation-local registry with no
 * cross-slice transition to route through an application service.
 */
export function MaterialAnnotationsPanel({
  materialId,
  currentTime,
  onSeek,
}: {
  readonly materialId: string;
  /** The player's current position, seeded into a new note's timestamp. */
  readonly currentTime: number;
  /** Jumps the player to an existing note's timestamp; omitted where there is no player to seek. */
  readonly onSeek?: (timestampSeconds: number) => void;
}) {
  const translate = useTranslate();
  const [annotations, setAnnotations] = useState<MaterialAnnotations>({});
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Deferred rather than a synchronous `setState` in the effect body, the
    // idiom `LocalMaterialPreview.tsx` already uses for its own initial read.
    void Promise.resolve().then(() => setAnnotations(readMaterialAnnotations(window.localStorage)));
  }, []);

  const entries = annotationsFor(annotations, materialId);

  const commit = (next: MaterialAnnotations) => {
    setAnnotations(next);
    if (typeof window !== 'undefined') writeMaterialAnnotations(window.localStorage, next);
  };

  const submit = () => {
    if (draft.trim().length === 0) return;
    commit(addMaterialAnnotation(annotations, materialId, currentTime, draft));
    setDraft('');
  };

  return (
    <section
      className="material-annotations-panel"
      aria-label={translate('annotations.panelLabel')}
    >
      <header className="material-annotations-panel__header">
        <span>{translate('annotations.headerLabel')}</span>
        <span>{entries.length}</span>
      </header>
      {entries.length === 0 ? (
        <p className="material-annotations-panel__empty">{translate('annotations.empty')}</p>
      ) : (
        <ol className="material-annotations-panel__list">
          {entries.map((annotation) => (
            <AnnotationRow
              key={annotation.id}
              annotation={annotation}
              onSeek={onSeek}
              onRemove={() =>
                commit(removeMaterialAnnotation(annotations, materialId, annotation.id))
              }
            />
          ))}
        </ol>
      )}
      <form
        className="material-annotations-panel__form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TerminalTextarea
          value={draft}
          onValueChange={setDraft}
          placeholder={translate('annotations.draftPlaceholder', {
            timestamp: formatTimestamp(currentTime),
          })}
          aria-label={translate('annotations.draftLabel')}
          rows={2}
        />
        <TerminalButton
          size="small"
          tone="primary"
          type="submit"
          disabled={draft.trim().length === 0}
        >
          {translate('annotations.addButton', { timestamp: formatTimestamp(currentTime) })}
        </TerminalButton>
      </form>
    </section>
  );
}

function AnnotationRow({
  annotation,
  onSeek,
  onRemove,
}: {
  readonly annotation: MaterialAnnotation;
  readonly onSeek?: ((timestampSeconds: number) => void) | undefined;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  return (
    <li className="material-annotations-panel__row">
      <TerminalButton
        size="small"
        tone="quiet"
        className="material-annotations-panel__timestamp"
        onClick={() => onSeek?.(annotation.timestampSeconds)}
        disabled={onSeek === undefined}
      >
        {formatTimestamp(annotation.timestampSeconds)}
      </TerminalButton>
      <span className="material-annotations-panel__text">{annotation.text}</span>
      <TerminalButton
        size="small"
        tone="critical"
        aria-label={translate('annotations.removeLabel')}
        onClick={onRemove}
      >
        [X]
      </TerminalButton>
    </li>
  );
}

function formatTimestamp(seconds: number): string {
  const wholeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(
    wholeSeconds % 60,
  ).padStart(2, '0')}`;
}
