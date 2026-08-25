'use client';

import {
  TerminalButton,
  TerminalInput,
  TerminalScrollArea,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { buildIssueDraftUrl } from '@/application/edit/issueDraft';
import {
  queryCatalog,
  searchEverySetting,
  settingGroups,
  splitByCategory,
  type SettingGroup,
} from '@/application/personalization/catalog';
import { categoryLabel, groupLabel, SchemaSetting } from '@/components/settings/SchemaSetting';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { ContentEditor } from './ContentEditor';
import { resolveDockEdge } from './EditPanelDock';
import { TileMotionPicker } from './TileMotionPicker';
import { TileVisibility } from './TileVisibility';

/**
 * The repository the issue draft points at, read from `git remote` rather than
 * guessed: this application has no server-side configuration, and a wrong slug
 * would send the operator to someone else's issue tracker.
 */
const repository = 'lumenpearson/headquarters';
const dockThresholdPx = 120;
/** Below this the press on the header was a click, not a drag. */
const dragThresholdPx = 6;

const groupOptions = settingGroups.map((group) => ({
  value: group,
  label: groupLabel(group),
}));

/**
 * The floating edit-mode panel.
 *
 * It owns no draft of its own. Every edit is dispatched through the existing
 * `applySettingsPatch`, and undo through `undoSettingsDraft`, so the panel is a
 * second surface onto the personalization slice rather than a second copy of
 * it. That is why there is no local editing state here beyond what is on
 * screen. R4 adds a second patch target with the same shape: a content field
 * selected on screen is dispatched through `applyContentPatch`, into the same
 * ledger and the same undo stack, and `ContentEditor` is its surface here.
 *
 * It navigates the same catalogue as the settings screen and through the same
 * functions -- `queryCatalog` and `searchEverySetting` -- but not through the
 * same layout. The screen spends two selects, a search field and a switch on
 * its toolbar; this panel is `clamp(280px, 22vw, 380px)` wide against an edge,
 * and capped at `40dvh` against the top or bottom one, so four navigation rows
 * would leave nothing under them to navigate to. It spends one row instead:
 *
 * - a section select of **seven** options rather than a flat list of
 *   thirty-two categories, which is the thing that had stopped being navigable;
 * - the categories demoted from a control to headings inside the list, so a
 *   whole section is read at once and the structure is still visible;
 * - one search field that answers across **every** section rather than the
 *   screen's section-scoped search plus its "found elsewhere" block, because
 *   an operator who is already pointing at something knows its name and wants
 *   one list, not two.
 *
 * Every one of the seventy-one definitions stays reachable both ways: each
 * belongs to exactly one category and each category to exactly one section, so
 * browsing covers the catalogue, and search covers it again independently.
 */
export function EditPanel() {
  const active = useOperationsStore((state) => state.edit.active);
  const dockEdge = useOperationsStore((state) => state.edit.dockEdge);
  const draft = useOperationsStore((state) => state.personalization.draft);
  const overrides = useOperationsStore((state) => state.content.overrides);
  const canUndo = useOperationsStore((state) => state.personalization.undoStack.length > 0);
  const [group, setGroup] = useState<SettingGroup>('appearance');
  const [search, setSearch] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const searching = search.trim().length > 0;
  const changedIds = draft.changedIds;
  /*
   * Searching leaves the section behind on purpose. The screen keeps its
   * section list and offers what it found elsewhere underneath; splitting a
   * panel this size into two lists would spend the room the second list needs
   * on saying that it is a second list.
   */
  const catalog = useMemo(
    () => queryCatalog({ group, category: 'all', search: '', changedOnly, changedIds }),
    [group, changedOnly, changedIds],
  );
  const found = useMemo(
    () => (searching ? searchEverySetting(search, changedIds, changedOnly) : []),
    [searching, search, changedIds, changedOnly],
  );
  const runs = useMemo(
    () => splitByCategory(searching ? found : catalog.definitions),
    [searching, found, catalog.definitions],
  );

  /*
   * The drag starts on the panel header and nowhere else.
   *
   * It used to start anywhere inside the panel, which made every press on a
   * control a drag: clicking the panel's select re-docked it from the right
   * edge to the top, the popup's anchor moved with it, and the click on an
   * option landed on nothing. Measured, not deduced -- the selection could not
   * be changed with a pointer at all, only with the keyboard. The select was
   * over categories then and is over sections now; the gesture is what the
   * threshold below protects, whatever the control turns out to be.
   *
   * Pointer capture is what makes the drag work at all. A drag ends with the
   * pointer somewhere else on screen -- that is the point of it -- so without
   * capture the release lands on whatever is under the cursor and this handler
   * never runs: the panel keeps its old edge and stays stuck in the dragging
   * state. Capture routes every subsequent pointer event back here regardless
   * of where the pointer went.
   */
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest('.edit-panel__header')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { x: event.clientX, y: event.clientY };
    setDragging(true);
  }, []);

  // Actions are read off the vanilla store instead of subscribed to, so the
  // panel does not re-render when an action identity changes.
  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = origin.current;
    origin.current = null;
    if (start === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    // A press on the header that never travelled is not a drag, and re-docking
    // the panel under the operator because they clicked its title would be a
    // surprise rather than a gesture.
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) < dragThresholdPx) {
      return;
    }
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

  const changeCount = draft.changedIds.length + Object.keys(overrides).length;
  const hasChanges = changeCount > 0;
  const shown = runs.reduce((total, run) => total + run.definitions.length, 0);

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
        <span>{changeCount} ИЗМЕНЕНИЙ</span>
      </header>

      <div className="edit-panel__nav">
        <TerminalSelect
          label="Раздел"
          value={group}
          options={groupOptions}
          onValueChange={(value) => setGroup(value as SettingGroup)}
        />
        <TerminalInput
          aria-label="Поиск по настройкам"
          placeholder="ИМЯ ИЛИ ОПИСАНИЕ"
          value={search}
          onValueChange={setSearch}
        />
        <div className="edit-panel__filter">
          <TerminalSwitch
            label="Только изменённые"
            checked={changedOnly}
            onCheckedChange={setChangedOnly}
          />
          <span>
            {shown} {searching ? 'ВО ВСЁМ КАТАЛОГЕ' : `ИЗ ${catalog.groupTotal}`}
          </span>
        </div>
      </div>

      <TerminalScrollArea className="edit-panel__settings">
        {/*
         * Above the catalogue and outside the section and search, because the
         * operator reaches it by pointing at a value on screen, not by
         * navigating here: whatever the panel was showing, the field they
         * just selected is the next thing they want to see.
         */}
        <ContentEditor />
        {runs.length === 0 ? (
          <p className="edit-panel__empty">
            {changedOnly ? 'НИЧЕГО НЕ ИЗМЕНЕНО ЗДЕСЬ' : 'НИЧЕГО НЕ НАЙДЕНО'}
          </p>
        ) : null}
        {runs.map((run) => (
          <section key={run.category} className="edit-panel__category">
            <h3>{categoryLabel(run.category)}</h3>
            {/*
             * The tile and motion pickers belong to their category, so they
             * appear under its heading rather than beside a select that no
             * longer exists. They stay out of a search result on purpose: a
             * search is the operator naming one setting, and answering it with
             * a picker over every tile on the screen would bury the answer.
             */}
            {!searching && run.category === 'tiles' ? <TileVisibility /> : null}
            {!searching && run.category === 'animations' ? <TileMotionPicker /> : null}
            {run.definitions.map((definition) => (
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
          </section>
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
            window.open(
              buildIssueDraftUrl({ repository, draft, content: overrides }),
              '_blank',
              'noopener',
            );
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
