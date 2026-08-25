'use client';

import { TerminalButton } from '@gremuchaya/ui/primitives';
import type { ReactNode } from 'react';

import {
  contentElementId,
  contentKey,
  getContentFieldDefinition,
} from '@/application/edit/contentFields';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

interface EditableContentProps {
  /** A `ContentFieldDefinition` id; an unknown one renders the children plain. */
  readonly field: string;
  readonly entityId: string;
  readonly children: ReactNode;
}

/**
 * A value on screen that edit mode can change (R4).
 *
 * Outside edit mode this is the children and nothing else, so the content
 * reads as content. Inside it the same value becomes the selector for the
 * panel's content editor, the way pressing a tile selects it for the motion
 * picker: one selection, held in `edit.selectedElementId`, and the editing
 * itself happens in the panel rather than in place. Editing in place would
 * put a control inside a table cell or a heading, where a control's height
 * moves the layout the operator is reading.
 *
 * A button rather than a span with a handler: it has to be reachable from
 * the keyboard, and it must never sit inside another interactive element.
 * The feeds render each event as a button, which is why event fields are
 * wired on the event card and not in the feed rows.
 */
export function EditableContent({ field, entityId, children }: EditableContentProps) {
  const elementId = contentElementId(field, entityId);
  const editing = useOperationsStore((state) => state.edit.active);
  const selected = useOperationsStore((state) => state.edit.selectedElementId === elementId);
  const changed = useOperationsStore(
    (state) => state.content.overrides[contentKey(field, entityId)] !== undefined,
  );
  const definition = getContentFieldDefinition(field);

  if (!editing || definition === undefined) return <>{children}</>;

  return (
    <TerminalButton
      className="editable-content"
      tone="quiet"
      size="small"
      title={definition.label}
      aria-pressed={selected}
      data-selected={selected ? 'true' : undefined}
      data-changed={changed ? 'true' : undefined}
      onClick={(event) => {
        // The value often sits in a row that selects its record on click;
        // selecting the field is a different act and must not also do that.
        event.stopPropagation();
        operationsStore.getState().selectEditElement(selected ? '' : elementId);
      }}
    >
      {children}
    </TerminalButton>
  );
}
