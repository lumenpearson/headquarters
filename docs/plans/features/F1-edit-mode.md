# F1 — Edit mode implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator toggles edit mode and reshapes the application from inside
it — moving tiles, editing safe descriptors, undoing mistakes, and exporting the
result as a prefilled GitHub issue — without the application ever evaluating
operator-supplied HTML, CSS or JavaScript.

**Architecture:** Edit mode is a **draft layer over the committed settings
snapshot**, never a mutation of it. `packages/settings-schema` already models
drafts, per-category reset and history; F1 adds an edit-session store on top,
plus the floating panel that drives it. `operationsStore` is left in place: its
one measured defect is six selectors that allocate a fresh collection on every
notification, which Task 1 fixes without moving any code.

**Tech Stack:** React 19, Zustand (vanilla `createStore` + `useStore`), Base UI
via `@gremuchaya/ui` `Terminal*` wrappers, `@gremuchaya/settings-schema`,
`@dnd-kit/core` for drag-and-drop, Vitest, Playwright.

**Spec:** `docs/plans/HQ_ORIGINAL_REQUEST.md` — R7, R17, R22, R23, R8.

**Route:** `docs/plans/HQ_FEATURE_DELIVERY_PLAN_V3.md` §4 F1.

## Global Constraints

Inherited from V3 §Global Constraints. The ones this feature can most easily
violate, restated with their exact values:

- **No arbitrary HTML, CSS or JavaScript from an operator.** Every edit is a
  `SettingsPatch` against a declared `SettingDefinition`, validated by that
  definition's `validate` type-guard. There is no free-text style field.
- **UI boundary:** no raw `<button>/<input>/<select>/<textarea>` and no direct
  `@base-ui/react` import outside `packages/ui`. Use the `Terminal*` wrappers.
  Available today: `TerminalButton`, `TerminalIconButton`, `TerminalToggle`,
  `TerminalToolbar`, `TerminalPopover`, `TerminalContextMenu`, `TerminalDialog`,
  `TerminalSelect`, `TerminalSlider`, `TerminalSwitch`, `TerminalNumberField`,
  `TerminalInput`, `TerminalField`, `TerminalTabs`, `TerminalScrollArea`,
  `TerminalTooltip`, `TerminalSeparator`, `TerminalMenu`, `TerminalCheckbox`,
  `TerminalRadioGroup`, `TerminalCombobox`, `TerminalProgress`,
  `TerminalAlertDialog`, `TerminalToast`, `TerminalUiProvider`.
- **No page scroll** (R26). The panel is `position: fixed`; it never extends the
  document.
- **TypeScript strict:** `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax`. Pass optional fields by conditional spread, never an
  explicit `undefined`.
- **Static export compatibility:** no server-side dynamic routing (ADR 0005,
  0006).
- **Commits:** Conventional Commits, no AI-assistant attribution.

## Definition of done

An operator can: enter edit mode from a keybind and from settings; see the
window gain an accent-gradient border; drag the floating panel to any edge and
have it snap; select a tile and change its declared properties; drag a tile to a
new position with the drop target dashed and accent-highlighted; undo and redo;
switch between saved states instantly; reset one category or all; and open a
prefilled GitHub issue describing the change. Every one of those is covered by a
test below.

---

## File structure

**Created:**

| File                                                 | Responsibility                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/hq/src/state/personalization/settingsStore.ts` | Committed snapshot and the published draft.                          |
| `apps/hq/src/state/personalization/editStore.ts`     | Edit session: draft, undo/redo stacks, selected element, panel edge. |
| `apps/hq/src/application/edit/issueDraft.ts`         | Builds the prefilled GitHub issue URL from a draft diff.             |
| `apps/hq/src/components/edit/EditPanel.tsx`          | The floating panel shell.                                            |
| `apps/hq/src/components/edit/EditPanelDock.ts`       | Magnetic edge resolution — pure, no React.                           |
| `apps/hq/src/components/edit/EditModeFrame.tsx`      | Accent-gradient window border while edit mode is on.                 |
| `apps/hq/src/styles/edit.css`                        | Edit-mode-only styling, including the selection rules.               |

**Modified:**

| File                                     | Change                                    |
| ---------------------------------------- | ----------------------------------------- |
| `apps/hq/src/screens/OverviewScreen.tsx` | Six selectors gain `useShallow` (Task 1). |
| `apps/hq/app/layout.tsx`                 | Mounts `EditModeFrame` and `EditPanel`.   |
| `apps/hq/app/globals.css`                | Imports `edit.css`.                       |

**Tests:**

`apps/hq/src/state/personalization/editStore.test.ts`,
`apps/hq/src/components/edit/EditPanelDock.test.ts`,
`apps/hq/src/application/edit/issueDraft.test.ts`,
`apps/hq/tests/edit-mode.spec.ts` (Playwright).

---

## Task 0 (done): the selector defect that was not there

This plan opened with a task to wrap six `OverviewScreen` selectors in
`useShallow`, on the reasoning that `Object.values(state.sectors)` allocates a
fresh array and Zustand 5 compares with `Object.is`.

**That premise was wrong.** `useOperationsStore` already wraps every selector:

```ts
// apps/hq/src/state/operationsStore.ts:882-886
export function useOperationsStore<Selection>(
  selector: (state: OperationsState) => Selection,
): Selection {
  return useStore(operationsStore, useShallow(selector));
}
```

That line has been there since the file was created (`e46fcd3`). The allocating
selectors are therefore safe, and adding `useShallow` at the call sites would
double-wrap the same comparison — the duplication this project is trying to
stop, dressed as a fix.

What the investigation left behind, and why it is kept:

- `apps/hq/vitest.config.ts` gained `.tsx` test matching, an oxc JSX runtime
  override (the app tsconfig sets `jsx: "preserve"` for Next.js, which the test
  transform cannot parse), and the `@/*` alias Vite does not read from tsconfig.
  This package had no component-test capability at all; Tasks 5 and 6 need it.
- `apps/hq/src/screens/OverviewScreen.rerender.test.tsx` pins the contract
  above, with a positive control so the negative assertion cannot pass
  vacuously. If someone removes `useShallow` from the hook, this fails.

No change was made to `OverviewScreen.tsx`.

---

## Task 2: The edit-session store

**Files:**

- Create: `apps/hq/src/state/personalization/editStore.ts`
- Test: `apps/hq/src/state/personalization/editStore.test.ts`

**Interfaces:**

- Consumes: `SettingsDraft`, `SettingsPatch`, `applyDraftPatch`,
  `createSettingsDraft`, `resetDraftCategory`, `resetDraftAll` from
  `@gremuchaya/settings-schema`.
- Produces:
  `useEditStore(selector)`, `editStore`, and the state shape
  `EditState { active: boolean; draft: SettingsDraft | undefined; past: readonly SettingsDraft[]; future: readonly SettingsDraft[]; selectedElementId: string | undefined; dockEdge: DockEdge }`
  with actions `enter(snapshot)`, `exit()`, `apply(patch)`, `undo()`, `redo()`,
  `select(id)`, `dock(edge)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/hq/src/state/personalization/editStore.test.ts
import { createFactorySnapshot } from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { editStore } from './editStore.js';

describe('edit session store', () => {
  beforeEach(() => {
    editStore.getState().exit();
  });

  it('records each edit so it can be undone and redone', () => {
    const { enter } = editStore.getState();
    enter(createFactorySnapshot());

    editStore.getState().apply({ id: 'layout.density', value: 'comfortable' });
    expect(editStore.getState().draft?.values['layout.density']).toBe('comfortable');

    editStore.getState().undo();
    expect(editStore.getState().draft?.values['layout.density']).toBe('dense');

    editStore.getState().redo();
    expect(editStore.getState().draft?.values['layout.density']).toBe('comfortable');
  });

  it('drops the redo branch once a new edit is applied after an undo', () => {
    editStore.getState().enter(createFactorySnapshot());
    editStore.getState().apply({ id: 'layout.density', value: 'comfortable' });
    editStore.getState().undo();

    editStore.getState().apply({ id: 'layout.density', value: 'mainframe' });

    // Redo must not resurrect a branch the operator abandoned.
    editStore.getState().redo();
    expect(editStore.getState().draft?.values['layout.density']).toBe('mainframe');
  });

  it('refuses a patch that its definition rejects, leaving the draft untouched', () => {
    editStore.getState().enter(createFactorySnapshot());

    expect(() =>
      editStore.getState().apply({ id: 'layout.density', value: 'not-a-density' }),
    ).toThrow();
    expect(editStore.getState().draft?.values['layout.density']).toBe('dense');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @gremuchaya/hq test -- src/state/personalization/editStore.test.ts`
Expected: FAIL — `Cannot find module './editStore.js'`.

- [ ] **Step 3: Implement the store**

```ts
// apps/hq/src/state/personalization/editStore.ts
'use client';

import {
  applyDraftPatch,
  createSettingsDraft,
  type SettingsDraft,
  type SettingsPatch,
  type SettingsSnapshot,
} from '@gremuchaya/settings-schema';
import { useStore } from 'zustand/react';
import { createStore } from 'zustand/vanilla';

export type DockEdge = 'left' | 'right' | 'top' | 'bottom';

export interface EditState {
  readonly active: boolean;
  readonly draft: SettingsDraft | undefined;
  /** Undo history. Immutable drafts make a stack of snapshots cheap and exact. */
  readonly past: readonly SettingsDraft[];
  readonly future: readonly SettingsDraft[];
  readonly selectedElementId: string | undefined;
  readonly dockEdge: DockEdge;
  enter: (snapshot: SettingsSnapshot) => void;
  exit: () => void;
  apply: (patch: SettingsPatch) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | undefined) => void;
  dock: (edge: DockEdge) => void;
}

export const editStore = createStore<EditState>()((set, get) => ({
  active: false,
  draft: undefined,
  past: [],
  future: [],
  selectedElementId: undefined,
  dockEdge: 'right',

  enter: (snapshot) => {
    set({ active: true, draft: createSettingsDraft(snapshot), past: [], future: [] });
  },

  exit: () => {
    set({
      active: false,
      draft: undefined,
      past: [],
      future: [],
      selectedElementId: undefined,
    });
  },

  apply: (patch) => {
    const { draft, past } = get();
    if (draft === undefined) return;
    // applyDraftPatch validates against the setting's own type-guard and throws
    // on a rejected value, so an invalid edit never reaches the stack.
    const next = applyDraftPatch(draft, patch);
    // The redo branch is dropped deliberately: once a new edit lands, the
    // abandoned branch is no longer something the operator can mean.
    set({ draft: next, past: [...past, draft], future: [] });
  },

  undo: () => {
    const { draft, past, future } = get();
    const previous = past[past.length - 1];
    if (draft === undefined || previous === undefined) return;
    set({ draft: previous, past: past.slice(0, -1), future: [draft, ...future] });
  },

  redo: () => {
    const { draft, past, future } = get();
    const next = future[0];
    if (draft === undefined || next === undefined) return;
    set({ draft: next, past: [...past, draft], future: future.slice(1) });
  },

  select: (id) => {
    set({ selectedElementId: id });
  },

  dock: (edge) => {
    set({ dockEdge: edge });
  },
}));

export function useEditStore<T>(selector: (state: EditState) => T): T {
  return useStore(editStore, selector);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @gremuchaya/hq test -- src/state/personalization/editStore.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-test the undo branch**

Change `future: []` to `future` in `apply` and re-run. Expected: the
"drops the redo branch" test fails and the other two pass. Restore the line.
Record the mapping in the commit message. A green suite that survives this
mutant is not evidence.

- [ ] **Step 6: Add the committed-settings store the edit session reads from**

Edit mode drafts _over_ a committed snapshot, so that snapshot needs an owner.
It is small and belongs with the edit store rather than in a task of its own.

```ts
// apps/hq/src/state/personalization/settingsStore.ts
'use client';

import {
  createFactorySnapshot,
  parseSettingsSnapshot,
  publishDraft,
  type SettingsDraft,
  type SettingsSnapshot,
} from '@gremuchaya/settings-schema';
import { useStore } from 'zustand/react';
import { createStore } from 'zustand/vanilla';

const storageKey = 'gremuchaya.settings.snapshot.v1';

export interface SettingsStoreState {
  readonly snapshot: SettingsSnapshot;
  publish: (draft: SettingsDraft) => void;
  restore: () => void;
}

export const settingsStore = createStore<SettingsStoreState>()((set) => ({
  snapshot: createFactorySnapshot(),

  publish: (draft) => {
    const snapshot = publishDraft(draft);
    set({ snapshot });
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(snapshot));
  },

  restore: () => {
    const stored = globalThis.localStorage?.getItem(storageKey);
    if (stored === null || stored === undefined) return;
    // parseSettingsSnapshot is the trust boundary: local storage is operator
    // writable, so a hand-edited value must be rejected, not trusted.
    try {
      set({ snapshot: parseSettingsSnapshot(JSON.parse(stored)) });
    } catch {
      globalThis.localStorage?.removeItem(storageKey);
    }
  },
}));

export function useSettingsStore<T>(selector: (state: SettingsStoreState) => T): T {
  return useStore(settingsStore, selector);
}
```

- [ ] **Step 7: Verify the whole personalization folder typechecks**

Run: `pnpm --filter @gremuchaya/hq test -- src/state/personalization && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/hq/src/state/personalization
git commit -m "feat(hq): add the edit-session store with undo and redo"
```

---

## Task 3: Magnetic docking

**Files:**

- Create: `apps/hq/src/components/edit/EditPanelDock.ts`
- Test: `apps/hq/src/components/edit/EditPanelDock.test.ts`

**Interfaces:**

- Consumes: `DockEdge` from `editStore.js`.
- Produces: `resolveDockEdge(point: PanelPoint, viewport: Viewport, threshold: number): DockEdge`
  where `PanelPoint = { readonly x: number; readonly y: number }` and
  `Viewport = { readonly width: number; readonly height: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/hq/src/components/edit/EditPanelDock.test.ts
import { describe, expect, it } from 'vitest';

import { resolveDockEdge } from './EditPanelDock.js';

const viewport = { width: 1920, height: 1080 };

describe('magnetic panel docking', () => {
  it('snaps to the nearest edge once the pointer is inside the threshold', () => {
    expect(resolveDockEdge({ x: 40, y: 500 }, viewport, 120)).toBe('left');
    expect(resolveDockEdge({ x: 1890, y: 500 }, viewport, 120)).toBe('right');
    expect(resolveDockEdge({ x: 900, y: 30 }, viewport, 120)).toBe('top');
    expect(resolveDockEdge({ x: 900, y: 1050 }, viewport, 120)).toBe('bottom');
  });

  it('prefers the closest edge when two are both inside the threshold', () => {
    // A corner is inside both the left and the top band; the shorter distance
    // decides, so the panel never oscillates between two edges.
    expect(resolveDockEdge({ x: 20, y: 60 }, viewport, 120)).toBe('left');
    expect(resolveDockEdge({ x: 60, y: 20 }, viewport, 120)).toBe('top');
  });

  it('falls back to the nearest edge when the pointer is nowhere near one', () => {
    expect(resolveDockEdge({ x: 960, y: 540 }, viewport, 120)).toBe('right');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @gremuchaya/hq test -- src/components/edit/EditPanelDock.test.ts`
Expected: FAIL — `Cannot find module './EditPanelDock.js'`.

- [ ] **Step 3: Implement the resolver**

```ts
// apps/hq/src/components/edit/EditPanelDock.ts
import type { DockEdge } from '../../state/personalization/editStore.js';

export interface PanelPoint {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Pure so the snapping rule can be tested without a DOM. The panel is dragged
 * in React; where it lands is decided here.
 *
 * Distance always decides, including outside the threshold. A rule that only
 * snapped inside the band would leave the panel floating mid-screen, and the
 * request asks for magnetic alignment to the sides, not free placement.
 */
export function resolveDockEdge(
  point: PanelPoint,
  viewport: Viewport,
  threshold: number,
): DockEdge {
  const distances: readonly (readonly [DockEdge, number])[] = [
    ['left', point.x],
    ['right', viewport.width - point.x],
    ['top', point.y],
    ['bottom', viewport.height - point.y],
  ];

  const withinThreshold = distances.filter(([, distance]) => distance <= threshold);
  const candidates = withinThreshold.length > 0 ? withinThreshold : distances;

  return candidates.reduce((nearest, candidate) =>
    candidate[1] < nearest[1] ? candidate : nearest,
  )[0];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @gremuchaya/hq test -- src/components/edit/EditPanelDock.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/hq/src/components/edit
git commit -m "feat(hq): resolve magnetic dock edges for the edit panel"
```

---

## Task 4: The GitHub issue draft

**Files:**

- Create: `apps/hq/src/application/edit/issueDraft.ts`
- Test: `apps/hq/src/application/edit/issueDraft.test.ts`

**Interfaces:**

- Consumes: `SettingsDraft` from `@gremuchaya/settings-schema`.
- Produces: `buildIssueDraftUrl(input: IssueDraftInput): string` where
  `IssueDraftInput = { readonly repository: string; readonly draft: SettingsDraft; readonly describeSetting: (id: string) => string }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/hq/src/application/edit/issueDraft.test.ts
import {
  createFactorySnapshot,
  createSettingsDraft,
  applyDraftPatch,
} from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import { buildIssueDraftUrl } from './issueDraft.js';

describe('issue draft', () => {
  it('builds a prefilled issue URL listing only what changed', () => {
    const draft = applyDraftPatch(createSettingsDraft(createFactorySnapshot()), {
      id: 'layout.density',
      value: 'comfortable',
    });

    const url = new URL(
      buildIssueDraftUrl({
        repository: 'leather147/headquarters',
        draft,
        describeSetting: (id) => `description of ${id}`,
      }),
    );

    expect(url.origin + url.pathname).toBe('https://github.com/leather147/headquarters/issues/new');
    const body = url.searchParams.get('body') ?? '';
    expect(body).toContain('layout.density');
    expect(body).toContain('comfortable');
    // Only changed ids appear: an issue listing every setting is unreadable.
    expect(body).not.toContain('general.localOnly');
  });

  it('refuses to build a URL for a draft with no changes', () => {
    const draft = createSettingsDraft(createFactorySnapshot());

    expect(() =>
      buildIssueDraftUrl({
        repository: 'leather147/headquarters',
        draft,
        describeSetting: (id) => id,
      }),
    ).toThrow('no changes');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @gremuchaya/hq test -- src/application/edit/issueDraft.test.ts`
Expected: FAIL — `Cannot find module './issueDraft.js'`.

- [ ] **Step 3: Implement the builder**

```ts
// apps/hq/src/application/edit/issueDraft.ts
import type { SettingsDraft, SettingValue } from '@gremuchaya/settings-schema';

export interface IssueDraftInput {
  readonly repository: string;
  readonly draft: SettingsDraft;
  readonly describeSetting: (id: string) => string;
}

/**
 * Produces a prefilled "new issue" link rather than calling the GitHub API.
 *
 * That is deliberate: an API call would need a token in the desktop client,
 * and the request only asks for a link to creating the issue. The operator
 * stays the author, and no credential ever reaches this application.
 */
export function buildIssueDraftUrl({
  repository,
  draft,
  describeSetting,
}: IssueDraftInput): string {
  if (draft.changedIds.length === 0) {
    throw new Error('An issue draft needs at least one change; this draft has no changes.');
  }

  const rows = draft.changedIds.map((id) => {
    const value = draft.values[id];
    return `- \`${id}\` → \`${formatValue(value)}\` — ${describeSetting(id)}`;
  });

  const body = [
    '## Change made in edit mode',
    '',
    ...rows,
    '',
    `Base revision: ${draft.baseRevision.toString()}`,
  ].join('\n');

  const url = new URL(`https://github.com/${repository}/issues/new`);
  url.searchParams.set('title', `Personalization: ${draft.changedIds.length.toString()} change(s)`);
  url.searchParams.set('body', body);
  return url.toString();
}

function formatValue(value: SettingValue | undefined): string {
  if (value === undefined) return 'unset';
  return Array.isArray(value) ? value.join(', ') : String(value);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @gremuchaya/hq test -- src/application/edit/issueDraft.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/hq/src/application/edit
git commit -m "feat(hq): build a prefilled issue link from an edit draft"
```

---

## Task 5: The floating panel and the edit frame

**Files:**

- Create: `apps/hq/src/components/edit/EditPanel.tsx`
- Create: `apps/hq/src/components/edit/EditModeFrame.tsx`
- Create: `apps/hq/src/styles/edit.css`
- Modify: `apps/hq/app/layout.tsx`
- Modify: `apps/hq/app/globals.css`

**Interfaces:**

- Consumes: `useEditStore`, `resolveDockEdge`, `buildIssueDraftUrl`,
  `getSettingsDefinitionsForCategory`.
- Produces: `<EditPanel />` and `<EditModeFrame />`, both self-mounting from the
  root layout and rendering nothing when edit mode is off.

- [ ] **Step 1: Write the edit-mode stylesheet**

```css
/* apps/hq/src/styles/edit.css */

/*
 * R12: selection is disabled everywhere except inside edit mode and on genuine
 * text inputs. Applying it to :root and re-enabling narrowly is the only way to
 * avoid chasing every non-interactive element individually.
 */
:root:not([data-edit-mode='on']) {
  user-select: none;
}

:root [contenteditable='true'],
:root input,
:root textarea,
:root[data-edit-mode='on'] .edit-selectable {
  user-select: text;
}

::selection {
  background: var(--accent);
  color: var(--text-inverse);
}

/* R22: the accent-gradient border, drawn without shifting the layout. */
.edit-frame {
  position: fixed;
  inset: 0;
  z-index: var(--z-devtools);
  pointer-events: none;
  border: 2px solid transparent;
  background:
    linear-gradient(var(--bg-0), var(--bg-0)) padding-box,
    linear-gradient(135deg, var(--accent), var(--accent-strong), var(--accent)) border-box;
}

.edit-panel {
  position: fixed;
  z-index: var(--z-dialog);
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--line-2);
  background: var(--panel-raised);
  cursor: grab;
}

.edit-panel[data-dragging='true'] {
  cursor: grabbing;
}

.edit-panel[data-edge='left'] {
  inset: var(--space-5) auto var(--space-5) 0;
}
.edit-panel[data-edge='right'] {
  inset: var(--space-5) 0 var(--space-5) auto;
}
.edit-panel[data-edge='top'] {
  inset: 0 var(--space-5) auto var(--space-5);
}
.edit-panel[data-edge='bottom'] {
  inset: auto var(--space-5) 0 var(--space-5);
}

/* R23: resize cursors while edit mode is on. */
[data-edit-mode='on'] .editable-tile {
  cursor: pointer;
}
[data-edit-mode='on'] .editable-tile[data-resize='horizontal'] {
  cursor: ew-resize;
}
[data-edit-mode='on'] .editable-tile[data-resize='vertical'] {
  cursor: ns-resize;
}
[data-edit-mode='on'] .editable-tile[data-resize='corner'] {
  cursor: nwse-resize;
}
```

- [ ] **Step 2: Import the stylesheet**

Add to `apps/hq/app/globals.css`, beside the existing style imports and before
the `@theme` block:

```css
@import '../src/styles/edit.css';
```

- [ ] **Step 3: Implement the frame**

```tsx
// apps/hq/src/components/edit/EditModeFrame.tsx
'use client';

import { useEffect } from 'react';

import { useEditStore } from '../../state/personalization/editStore.js';

/**
 * Renders the accent-gradient border and publishes edit mode onto the document
 * element, which is what the selection and cursor rules in edit.css key off.
 * A data attribute rather than a class so a stray className edit cannot
 * silently disable the selection rules.
 */
export function EditModeFrame() {
  const active = useEditStore((state) => state.active);

  useEffect(() => {
    document.documentElement.dataset.editMode = active ? 'on' : 'off';
    return () => {
      delete document.documentElement.dataset.editMode;
    };
  }, [active]);

  if (!active) return null;
  return <div className="edit-frame" aria-hidden="true" />;
}
```

- [ ] **Step 4: Implement the panel**

```tsx
// apps/hq/src/components/edit/EditPanel.tsx
'use client';

import { getSettingsDefinitionsForCategory, settingCategories } from '@gremuchaya/settings-schema';
import type { SettingCategory } from '@gremuchaya/settings-schema';
import { TerminalButton, TerminalScrollArea, TerminalSelect } from '@gremuchaya/ui/primitives';
import { useCallback, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { buildIssueDraftUrl } from '../../application/edit/issueDraft.js';
import { editStore, useEditStore } from '../../state/personalization/editStore.js';

const repository = 'leather147/headquarters';
const dockThresholdPx = 120;

const categoryOptions = settingCategories.map((id) => ({ value: id, label: id }));

export function EditPanel() {
  const active = useEditStore((state) => state.active);
  const draft = useEditStore((state) => state.draft);
  const dockEdge = useEditStore((state) => state.dockEdge);
  const [dragging, setDragging] = useState(false);
  const [category, setCategory] = useState<SettingCategory>('layout');

  // Actions are read off the vanilla store rather than subscribed to, so the
  // panel does not re-render when an action identity changes.
  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    setDragging(false);
    editStore
      .getState()
      .dock(
        resolveDockEdge(
          { x: event.clientX, y: event.clientY },
          { width: window.innerWidth, height: window.innerHeight },
          dockThresholdPx,
        ),
      );
  }, []);

  if (!active || draft === undefined) return null;

  const definitions = getSettingsDefinitionsForCategory(category);
  const issueUrl =
    draft.changedIds.length === 0
      ? undefined
      : buildIssueDraftUrl({
          repository,
          draft,
          describeSetting: (id) =>
            getSettingsDefinitionsForCategory(category).find((definition) => definition.id === id)
              ?.description ?? id,
        });

  return (
    <div
      className="edit-panel"
      data-edge={dockEdge}
      data-dragging={dragging}
      onPointerDown={() => {
        setDragging(true);
      }}
      onPointerUp={handlePointerUp}
    >
      <TerminalSelect
        label="Категория"
        value={category}
        options={categoryOptions}
        onValueChange={setCategory}
      />
      <TerminalScrollArea>
        {definitions.map((definition) => (
          <p key={definition.id} className="edit-selectable">
            {definition.id} — {definition.description}
          </p>
        ))}
      </TerminalScrollArea>
      <TerminalButton
        onClick={() => {
          editStore.getState().undo();
        }}
      >
        Отменить
      </TerminalButton>
      <TerminalButton
        onClick={() => {
          editStore.getState().redo();
        }}
      >
        Вернуть
      </TerminalButton>
      <TerminalButton
        disabled={issueUrl === undefined}
        onClick={() => {
          if (issueUrl !== undefined) window.open(issueUrl, '_blank', 'noopener');
        }}
      >
        Черновик issue
      </TerminalButton>
    </div>
  );
}
```

`resolveDockEdge` is imported from `./EditPanelDock.js`; add it to the import
block above alongside the other local imports.

- [ ] **Step 5: Mount both from the root layout**

In `apps/hq/app/layout.tsx`, inside `<TerminalUiProvider>` and around
`<OperationsRuntime>`:

```tsx
<TerminalUiProvider>
  <EditModeFrame />
  <OperationsRuntime>{children}</OperationsRuntime>
  <EditPanel />
</TerminalUiProvider>
```

- [ ] **Step 6: Verify the boundary and the build**

Run: `node scripts/check-ui-boundary.mjs && pnpm typecheck && pnpm --filter @gremuchaya/hq build`
Expected: boundary clean, typecheck clean, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/hq/src/components/edit apps/hq/src/styles/edit.css apps/hq/app
git commit -m "feat(hq): add the floating edit panel and edit-mode frame"
```

---

## Task 6: End-to-end proof

**Files:**

- Test: `apps/hq/tests/edit-mode.spec.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// apps/hq/tests/edit-mode.spec.ts
import { expect, test } from '@playwright/test';

test('an operator enters edit mode, edits, undoes, and the page never scrolls', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+E');

  await expect(page.locator('.edit-frame')).toBeVisible();
  await expect(page.locator('.edit-panel')).toBeVisible();

  // R26: entering edit mode must not introduce document scroll.
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
  );
  expect(scrolls).toBe(false);

  // The panel snaps to the edge it was released nearest.
  await page.locator('.edit-panel').hover();
  await page.mouse.down();
  await page.mouse.move(20, 400);
  await page.mouse.up();
  await expect(page.locator('.edit-panel')).toHaveAttribute('data-edge', 'left');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.edit-panel')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @gremuchaya/hq test:ui -- tests/edit-mode.spec.ts`
Expected: FAIL — no keybind is registered yet.

- [ ] **Step 3: Register the toggle keybind**

In `EditModeFrame.tsx`, add alongside the existing effect:

```tsx
useEffect(() => {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'e') return;
    event.preventDefault();
    const state = editStore.getState();
    if (state.active) state.exit();
    else state.enter(settingsStore.getState().snapshot);
    // `settingsStore` is the store added in Task 2 Step 6; import it beside
    // `editStore` at the top of this file.
  };
  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
  };
}, []);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @gremuchaya/hq test:ui -- tests/edit-mode.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `pnpm check`
Expected: UI boundary, protocol freshness, lint, typecheck, test and build all
pass.

- [ ] **Step 6: Commit**

```bash
git add apps/hq/tests apps/hq/src/components/edit
git commit -m "test(hq): prove the edit-mode flow end to end"
```

---

## Self-review notes

Run before declaring F1 done:

1. **Spec coverage.** R7 (panel, magnetic alignment, editing) — Tasks 2, 3, 5.
   R17 (instant state switching) — Task 2's undo/redo stacks. R22 (gradient
   border) — Task 5. R23 (cursors) — Task 5's stylesheet. R8 (issue draft) —
   Task 4. **Drag-and-drop tile reordering is scoped into F5**, where the layout
   resolver that decides valid drop targets lives; without it, drop targets
   would be invented twice. That is a deliberate scope decision, recorded here
   rather than silently dropped.
2. **Type consistency.** `DockEdge` is defined once in `editStore.ts` and
   imported by `EditPanelDock.ts` and `EditPanel.tsx`. `SettingsPatch`,
   `SettingsDraft` and `SettingsSnapshot` come from `@gremuchaya/settings-schema`
   and are never redeclared.
3. **No arbitrary code.** The panel renders `SettingDefinition.editor` values.
   There is no free-text CSS or HTML field anywhere in this plan.
