'use client';

import {
  TerminalButton,
  TerminalInput,
  TerminalScrollArea,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { buildIssueDraftUrl } from '@/application/edit/issueDraft';
import { useAppLocale } from '@/application/localization/locale';
import {
  queryCatalog,
  searchEverySetting,
  settingGroups,
  splitByCategory,
  type SettingGroup,
} from '@/application/personalization/catalog';
import { repositorySlug } from '@/application/repository';
import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import { categoryLabel, groupLabel, SchemaSetting } from '@/components/settings/SchemaSetting';
import { operationsStore, useOperationsStore, type EditDockEdge } from '@/state/operationsStore';

import { ContentEditor } from './ContentEditor';
import { nextDockEdge, resolveDockEdge } from './EditPanelDock';
import { ElementTranslation } from './ElementTranslation';
import { TileMotionPicker } from './TileMotionPicker';
import { TilePresentationPicker } from './TilePresentationPicker';
import { TileVisibility } from './TileVisibility';

const dockThresholdPx = 120;
/** Below this the press on the header was a click, not a drag. */
const dragThresholdPx = 6;
/** How far a docked panel stands off its edge. */
const dockMarginPx = 16;

/**
 * Where a docked panel sits, from its edge and its own box.
 *
 * Pure so the placement can be reasoned about apart from the DOM writes: the
 * panel is anchored to its dock edge and centred along it, the way a devtools
 * strip parks against a side of the window rather than stretching along it.
 */
function dockedPosition(
  edge: EditDockEdge,
  panel: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const centeredX = Math.max(dockMarginPx, (viewport.width - panel.width) / 2);
  const centeredY = Math.max(dockMarginPx, (viewport.height - panel.height) / 2);
  switch (edge) {
    case 'left':
      return { x: dockMarginPx, y: centeredY };
    case 'right':
      return { x: viewport.width - panel.width - dockMarginPx, y: centeredY };
    case 'top':
      return { x: centeredX, y: dockMarginPx };
    case 'bottom':
      return { x: centeredX, y: viewport.height - panel.height - dockMarginPx };
  }
}

/**
 * The floating edit-mode panel: a draggable strip in the devtools idiom.
 *
 * It owns no draft of its own. Every edit is dispatched through the existing
 * `applySettingsPatch`, and undo through `undoSettingsDraft`, so the panel is a
 * second surface onto the personalization slice rather than a second copy of
 * it. That is why there is no local editing state here beyond what is on
 * screen. R4 adds a second patch target with the same shape: a content field
 * selected on screen is dispatched through `applyContentPatch`, into the same
 * ledger and the same undo stack, and `ContentEditor` is its surface here.
 *
 * The panel is a compact strip parked against an edge rather than a column
 * stretched along it. Its header is the whole collapsed state -- a floating
 * pill of a grip, a change count, undo and close, and the control that
 * expands it, translating the devtools idiom into this design system's own
 * square-cornered, blurred-glass vocabulary rather than copying a rounded
 * one wholesale (`--radius-1`/`--radius-2` are 0 here, on purpose). The body
 * below is a disclosure that grows along Y with what it holds and caps at
 * `min(56vh, 540px)`, past which it scrolls internally -- a few settings make
 * a short panel, a whole section makes a capped one, and the document never
 * scrolls either way (R26). `edit.panelExpanded` starts every session
 * collapsed (`enterEditMode` resets it), and selecting an element on screen
 * opens it back up -- see `selectEditElement` in the store, which is also
 * why the flag lives there rather than as a `useState` here. Dragging
 * follows the pointer with a transform and the release animates the snap to
 * the nearest edge; positioning is one transform throughout, so the drag and
 * the docking cannot fight over who places the panel.
 *
 * It navigates the same catalogue as the settings screen and through the same
 * functions -- `queryCatalog` and `searchEverySetting` -- but not through the
 * same layout. The screen spends two selects, a search field and a switch on
 * its toolbar; this panel spends one row:
 *
 * - a section select of **seven** options rather than a flat list of the
 *   categories, which is the thing that had stopped being navigable;
 * - the categories demoted from a control to headings inside the list, so a
 *   whole section is read at once and the structure is still visible;
 * - one search field that answers across **every** section rather than the
 *   screen's section-scoped search plus its "found elsewhere" block, because
 *   an operator who is already pointing at something knows its name and wants
 *   one list, not two.
 *
 * Every definition stays reachable both ways: each belongs to exactly one
 * category and each category to exactly one section, so browsing covers the
 * catalogue, and search covers it again independently.
 */
export function EditPanel() {
  const active = useOperationsStore((state) => state.edit.active);
  const dockEdge = useOperationsStore((state) => state.edit.dockEdge);
  const panelExpanded = useOperationsStore((state) => state.edit.panelExpanded);
  const draft = useOperationsStore((state) => state.personalization.draft);
  const overrides = useOperationsStore((state) => state.content.overrides);
  const canUndo = useOperationsStore((state) => state.personalization.undoStack.length > 0);
  // The subscription behind `groupLabel` and `categoryLabel` below, both of
  // which read the locale at the moment they are called rather than taking it.
  useAppLocale();
  const [group, setGroup] = useState<SettingGroup>('appearance');
  const [search, setSearch] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const position = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const origin = useRef<{
    readonly x: number;
    readonly y: number;
    readonly panelX: number;
    readonly panelY: number;
  } | null>(null);
  const moved = useRef(false);
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
  // Built each render rather than hoisted to module scope, where it was built
  // once at import and so could never have followed the setting. Seven
  // entries: a memo over them would cost more than the map does.
  const groupOptions = settingGroups.map((entry) => ({ value: entry, label: groupLabel(entry) }));

  /*
   * One placement path: the panel always sits where its transform puts it.
   *
   * Outside a drag that transform is the docked position -- anchored to the
   * dock edge, centred along it -- recomputed whenever the edge, the panel's
   * own size (the body growing or collapsing) or the window changes. The
   * transform transitions in CSS, so a re-dock glides rather than teleports,
   * and `data-dragging` switches the transition off while the pointer is the
   * one deciding where the panel is.
   *
   * The root's own width never changes between the collapsed pill and the
   * expanded panel -- only the body's height does, through the grid-rows
   * technique below. That is deliberate: the `ResizeObserver` a few lines
   * down re-centres on every box-size change it sees, including the
   * intermediate frames of a running CSS transition, so a *width* transition
   * here would feed this callback a different panel width each frame and the
   * docked position would chase a box that has not finished changing size --
   * visible as the panel overshooting or trembling against the viewport edge
   * mid-expand, exactly where R26's no-scroll poll would catch it. Holding
   * the width constant keeps that measurement to one call per state change;
   * the existing transform transition is what does the animating, gliding
   * the panel to its new centred position around the height it already has.
   */
  const place = useCallback(() => {
    const element = rootRef.current;
    if (element === null) return;
    const box = element.getBoundingClientRect();
    const next = dockedPosition(
      dockEdge,
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    position.current = next;
    element.style.transform = `translate3d(${next.x.toString()}px, ${next.y.toString()}px, 0)`;
  }, [dockEdge]);

  useLayoutEffect(() => {
    if (!active || dragging) return;
    place();
  }, [active, dragging, panelExpanded, place]);

  useEffect(() => {
    if (!active) return;
    const element = rootRef.current;
    const onViewportResize = () => {
      if (origin.current === null) place();
    };
    window.addEventListener('resize', onViewportResize);
    // The disclosure body changes the panel's height as sections open, search
    // narrows or the strip collapses; a bottom- or centre-anchored panel has
    // to follow its own size, not only the window's.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onViewportResize);
    if (element !== null) observer?.observe(element);
    return () => {
      window.removeEventListener('resize', onViewportResize);
      observer?.disconnect();
    };
  }, [active, place]);

  /*
   * The drag starts on the panel header and nowhere else -- and not on the
   * header's own buttons, whose press is a click by declaration.
   *
   * It used to start anywhere inside the panel, which made every press on a
   * control a drag: clicking the panel's select re-docked it from the right
   * edge to the top, the popup's anchor moved with it, and the click on an
   * option landed on nothing. Measured, not deduced -- the selection could not
   * be changed with a pointer at all, only with the keyboard.
   *
   * Pointer capture is what makes the drag work at all. A drag ends with the
   * pointer somewhere else on screen -- that is the point of it -- so without
   * capture the release lands on whatever is under the cursor and this handler
   * never runs: the panel keeps its old edge and stays stuck in the dragging
   * state. Capture routes every subsequent pointer event back here regardless
   * of where the pointer went.
   */
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.edit-panel__header') || target.closest('button') !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = {
      x: event.clientX,
      y: event.clientY,
      panelX: position.current.x,
      panelY: position.current.y,
    };
    moved.current = false;
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = origin.current;
    if (start === null) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    // A press that never travelled is a click; the panel must not twitch
    // under a pointer that is aiming at the header's own content.
    if (!moved.current && Math.abs(deltaX) + Math.abs(deltaY) < dragThresholdPx) return;
    if (!moved.current) {
      moved.current = true;
      setDragging(true);
    }
    const element = event.currentTarget;
    position.current = { x: start.panelX + deltaX, y: start.panelY + deltaY };
    element.style.transform = `translate3d(${position.current.x.toString()}px, ${position.current.y.toString()}px, 0)`;
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
    const travelled = moved.current;
    moved.current = false;
    // Cleared on both paths, not only after a real drag: a press that ends as
    // a click must still leave the dragging state, or a drag whose cancel was
    // missed would keep the panel without transitions until the next drag.
    setDragging(false);
    if (!travelled) return;
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

  /*
   * A cancelled pointer -- the window losing focus mid-drag, a touch stolen by
   * the system -- never delivers a pointerup, and capture is released
   * implicitly. Without this handler the origin stayed set, `data-dragging`
   * stayed on, and the panel was left without transitions and with a grabbing
   * cursor until the next completed drag. Dropping the dragging state also
   * re-runs the placement effect, which glides the panel back to its edge.
   */
  const handlePointerCancel = useCallback(() => {
    origin.current = null;
    moved.current = false;
    setDragging(false);
  }, []);

  /*
   * The keyboard equivalent of the magnetic edge dragging snaps to.
   * `resolveDockEdge` reads where the pointer left the window, and a keypress
   * has no such position to read, so this cycles the same four edges instead
   * of guessing one -- see `EditPanelDock.nextDockEdge`. Guarded on `active`
   * rather than left unclaimed while the panel is closed: the panel mounts
   * regardless of it, and an unclaimed keybind would let the chord fall
   * through to whatever the browser does with it instead of being silently
   * absorbed here.
   */
  useKeybind('edit.dockPanel', () => {
    if (!active) return;
    operationsStore.getState().dockEditPanel(nextDockEdge(dockEdge));
  });

  if (!active) return null;

  const changeCount = draft.changedIds.length + Object.keys(overrides).length;
  const hasChanges = changeCount > 0;
  const shown = runs.reduce((total, run) => total + run.definitions.length, 0);

  return (
    <div
      ref={rootRef}
      // `color-mix` over `--panel-raised` plus a blur read from
      // `--ops-overlay-blur` (the same variable and literal-fallback idiom
      // as the dialog/drawer scrims) is the floating-glass half of the
      // Vercel-devtools translation; the square corners and hairline
      // `--line-2` border are what keep it this design system's own rather
      // than a copy of theirs.
      //
      // The width grew from the pre-pill `clamp(300px,22vw,380px)`: the
      // header now carries five interactive children (grip aside) instead of
      // one, and measured against the live layout, that row's own min-content
      // width (~440px at the default type scale) already exceeds the old
      // 380px ceiling before `typography.weight`'s R19 range or a longer `en`
      // label is even in play. The header's own `flex-wrap` (below) is the
      // structural backstop for whatever this clamp does not cover -- a
      // locale, a font scale or a narrow window this number was not measured
      // against wraps the row onto a second line instead of pushing a button
      // past the viewport edge, which is the failure a fixed width alone
      // cannot rule out.
      className="edit-panel group fixed top-0 left-0 z-[var(--z-dialog)] grid grid-rows-[auto_auto] w-[clamp(320px,32vw,460px)] border border-hq-line-2 bg-[color-mix(in_srgb,var(--panel-raised)_88%,transparent)] [backdrop-filter:blur(var(--ops-overlay-blur,16px))_saturate(90%)] will-change-transform [transition:transform_320ms_cubic-bezier(0.22,1,0.36,1),box-shadow_var(--motion-standard)_ease] shadow-[0_14px_44px_rgb(0_0_0_/_42%),0_0_0_1px_color-mix(in_srgb,var(--accent)_10%,transparent)] data-[dragging=true]:shadow-[0_22px_64px_rgb(0_0_0_/_55%),0_0_0_1px_color-mix(in_srgb,var(--accent)_28%,transparent)] data-[dragging=true]:transition-none"
      data-edge={dockEdge}
      data-dragging={dragging}
      data-expanded={panelExpanded}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <header className="edit-panel__header flex flex-wrap gap-hq-2 items-center py-hq-2 px-hq-3 text-hq-accent text-hq-xs tracking-[0.12em] cursor-grab group-data-[dragging=true]:cursor-grabbing">
        <span className="edit-panel__grip text-hq-text-2 tracking-[0em]" aria-hidden="true">
          ⠿
        </span>
        <strong>РЕДАКТИРОВАНИЕ</strong>
        <span className="edit-panel__count ml-auto text-hq-text-2">{changeCount} ИЗМЕНЕНИЙ</span>
        {/*
         * The pill's own actions, next to the control that expands it: the
         * two the footer below holds that stay useful without opening the
         * body at all. ОТМЕНИТЬ needs no context to matter -- it is one step
         * back, whatever that step was -- and ЗАКРЫТЬ is how an operator who
         * is done, or opened edit mode by mistake, leaves it without
         * expanding first. ЧЕРНОВИК ISSUE stays in the footer only: it opens
         * a browser tab, which a glance at the pill should never trigger.
         * One instance of each, not a pill copy and a footer copy -- moved
         * here rather than duplicated, so `ОТМЕНИТЬ`/`ЗАКРЫТЬ` stay reachable
         * by name regardless of `data-expanded`.
         */}
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
          tone="quiet"
          onClick={() => {
            operationsStore.getState().exitEditMode();
          }}
        >
          ЗАКРЫТЬ
        </TerminalButton>
        <TerminalButton
          size="small"
          tone="quiet"
          aria-label={panelExpanded ? 'Свернуть панель' : 'Развернуть панель'}
          aria-expanded={panelExpanded}
          onClick={() => {
            operationsStore.getState().setEditPanelExpanded(!panelExpanded);
          }}
        >
          {panelExpanded ? '[▾]' : '[▸]'}
        </TerminalButton>
      </header>

      <div className="edit-panel__body grid grid-rows-[1fr] group-data-[expanded=false]:grid-rows-[0fr] [transition:grid-template-rows_300ms_cubic-bezier(0.22,1,0.36,1)]">
        <div className="edit-panel__body-inner grid grid-rows-[auto_minmax(0,1fr)_auto] gap-hq-2 min-h-0 pt-0 px-hq-3 pb-hq-3 overflow-hidden">
          <div className="edit-panel__nav grid gap-hq-1">
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
            <div className="edit-panel__filter flex gap-hq-2 items-center justify-between text-hq-text-2 text-hq-xs tracking-[0.08em]">
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

          <TerminalScrollArea className="edit-panel__settings min-h-0 max-h-[min(56vh,540px)]">
            {/*
             * Above the catalogue and outside the section and search, because the
             * operator reaches it by pointing at a value on screen, not by
             * navigating here: whatever the panel was showing, the field they
             * just selected is the next thing they want to see.
             */}
            <ContentEditor />
            {runs.length === 0 ? (
              <p className="edit-panel__empty py-hq-3 px-0 text-hq-text-2 text-hq-xs tracking-[0.08em] text-center">
                {changedOnly ? 'НИЧЕГО НЕ ИЗМЕНЕНО ЗДЕСЬ' : 'НИЧЕГО НЕ НАЙДЕНО'}
              </p>
            ) : null}
            {runs.map((run) => (
              <section key={run.category} className="edit-panel__category grid gap-hq-1">
                <h3 className="sticky top-0 z-[1] pt-hq-2 px-0 pb-hq-1 border-b border-b-hq-line-2 bg-hq-panel-raised text-hq-accent text-hq-xs tracking-[0.12em]">
                  {categoryLabel(run.category)}
                </h3>
                {/*
                 * The tile and motion pickers belong to their category, so they
                 * appear under its heading rather than beside a select that no
                 * longer exists. They stay out of a search result on purpose: a
                 * search is the operator naming one setting, and answering it with
                 * a picker over every tile on the screen would bury the answer.
                 */}
                {!searching && run.category === 'tiles' ? (
                  <>
                    <TileVisibility />
                    <TilePresentationPicker />
                  </>
                ) : null}
                {!searching && run.category === 'animations' ? <TileMotionPicker /> : null}
                {!searching && run.category === 'localization' ? <ElementTranslation /> : null}
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

          {/*
           * ОТМЕНИТЬ and ЗАКРЫТЬ moved to the header, which is reachable
           * whether the panel is collapsed or not; this footer keeps the one
           * action that belongs to the expanded body, since it opens a
           * browser tab and should never fire from a glance at the pill.
           */}
          <footer className="edit-panel__actions flex gap-hq-2">
            <TerminalButton
              size="small"
              disabled={!hasChanges}
              onClick={() => {
                window.open(
                  buildIssueDraftUrl({ repository: repositorySlug, draft, content: overrides }),
                  '_blank',
                  'noopener',
                );
              }}
            >
              ЧЕРНОВИК ISSUE
            </TerminalButton>
          </footer>
        </div>
      </div>
    </div>
  );
}
