'use client';

import { getSettingsDefinitionsForCategory, settingCategories } from '@gremuchaya/settings-schema';
import type { SettingCategory } from '@gremuchaya/settings-schema';
import { TerminalButton, TerminalScrollArea, TerminalSelect } from '@gremuchaya/ui/primitives';
import { useCallback, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { buildIssueDraftUrl } from '@/application/edit/issueDraft';
import { categoryLabel, SchemaSetting } from '@/components/settings/SchemaSetting';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { resolveDockEdge } from './EditPanelDock';

/**
 * The repository the issue draft points at, read from `git remote` rather than
 * guessed: this application has no server-side configuration, and a wrong slug
 * would send the operator to someone else's issue tracker.
 */
const repository = 'lumenpearson/headquarters';
const dockThresholdPx = 120;

const categoryOptions = settingCategories.map((category) => ({
  value: category,
  label: categoryLabel(category),
}));

/**
 * The floating edit-mode panel.
 *
 * It owns no draft of its own. Every edit is dispatched through the existing
 * `applySettingsPatch`, and undo through `undoSettingsDraft`, so the panel is a
 * second surface onto the personalization slice rather than a second copy of
 * it. That is why there is no local editing state here beyond which category is
 * on screen.
 */
export function EditPanel() {
  const active = useOperationsStore((state) => state.edit.active);
  const dockEdge = useOperationsStore((state) => state.edit.dockEdge);
  const draft = useOperationsStore((state) => state.personalization.draft);
  const canUndo = useOperationsStore((state) => state.personalization.undoStack.length > 0);
  const [category, setCategory] = useState<SettingCategory>('layout');
  const [dragging, setDragging] = useState(false);

  /*
   * Pointer capture is what makes the drag work at all. A drag ends with the
   * pointer somewhere else on screen -- that is the point of it -- so without
   * capture the release lands on whatever is under the cursor and this handler
   * never runs: the panel keeps its old edge and stays stuck in the dragging
   * state. Capture routes every subsequent pointer event back here regardless
   * of where the pointer went.
   */
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, []);

  // Actions are read off the vanilla store instead of subscribed to, so the
  // panel does not re-render when an action identity changes.
  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    operationsStore
      .getState()
      .dockEditPanel(
        resolveDockEdge(
          { x: event.clientX, y: event.clientY },
          { width: window.innerWidth, height: window.innerHeight },
          dockThresholdPx,
        ),
      );
  }, []);

  if (!active) return null;

  const definitions = getSettingsDefinitionsForCategory(category);
  const hasChanges = draft.changedIds.length > 0;

  return (
    <div
      className="edit-panel"
      data-edge={dockEdge}
      data-dragging={dragging}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      <header className="edit-panel__header">
        <strong>РЕЖИМ РЕДАКТИРОВАНИЯ</strong>
        <span>{draft.changedIds.length} ИЗМЕНЕНИЙ</span>
      </header>

      <TerminalSelect
        label="Категория"
        value={category}
        options={categoryOptions}
        onValueChange={setCategory}
      />

      <TerminalScrollArea className="edit-panel__settings">
        {definitions.map((definition) => (
          <SchemaSetting
            key={definition.id}
            definition={definition}
            value={draft.values[definition.id] ?? definition.defaultValue}
            changed={draft.changedIds.includes(definition.id)}
            onValueChange={(value) =>
              operationsStore.getState().applySettingsPatch([{ id: definition.id, value }])
            }
          />
        ))}
      </TerminalScrollArea>

      <footer className="edit-panel__actions">
        <TerminalButton
          size="small"
          disabled={!canUndo}
          onClick={() => {
            operationsStore.getState().undoSettingsDraft();
          }}
        >
          ОТМЕНИТЬ
        </TerminalButton>
        <TerminalButton
          size="small"
          disabled={!hasChanges}
          onClick={() => {
            window.open(buildIssueDraftUrl({ repository, draft }), '_blank', 'noopener');
          }}
        >
          ЧЕРНОВИК ISSUE
        </TerminalButton>
        <TerminalButton
          size="small"
          tone="quiet"
          onClick={() => {
            operationsStore.getState().exitEditMode();
          }}
        >
          ЗАКРЫТЬ
        </TerminalButton>
      </footer>
    </div>
  );
}
