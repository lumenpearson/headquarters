// @vitest-environment jsdom
import type { TerminalMenuItem } from '@gremuchaya/ui/primitives';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextMenuFor } from '../../application/contextMenus/registry';
import { operationsStore } from '../../state/operationsStore';
import { ContextMenuRuntime, buildContextMenuItems, useMenuOwners } from './ContextMenuRuntime';

let shellItems: readonly TerminalMenuItem[] = [];

/*
 * Composes the shell menu exactly the way the topbar trigger does -- subscribe
 * to the claim tables, then build. Asserting on the registry alone would pass
 * while the built list ignored the setting entirely.
 */
function ShellMenuProbe() {
  const owners = useMenuOwners();
  const definition = contextMenuFor('shell');
  if (definition === undefined) throw new Error('the shell surface is not declared');
  const items = buildContextMenuItems(definition, undefined, owners);
  useEffect(() => {
    shellItems = items;
  });
  return null;
}

function diagnosticsEntry(): TerminalMenuItem {
  const entry = shellItems.find((item) => item.id === 'shell.diagnostics');
  if (entry === undefined) throw new Error('the diagnostics entry left the shell menu');
  return entry;
}

function allow(allowed: boolean): void {
  act(() => {
    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'privacy.copyDiagnostics', value: allowed }]);
  });
}

describe('the diagnostics entry in the shell menu', () => {
  beforeEach(() => {
    shellItems = [];
    operationsStore.getState().resetWorld();
  });

  it('is listed and disabled while privacy.copyDiagnostics is off', () => {
    render(
      <>
        <ContextMenuRuntime />
        <ShellMenuProbe />
      </>,
    );

    // Shown, not removed: an operator who cannot see the command cannot go
    // and find the setting that would give it back.
    expect(shellItems.map((item) => item.id)).toContain('shell.diagnostics');
    expect(diagnosticsEntry().disabled).toBe(true);
  });

  it('becomes runnable as soon as the operator allows redacted diagnostic copy', () => {
    render(
      <>
        <ContextMenuRuntime />
        <ShellMenuProbe />
      </>,
    );
    allow(true);

    expect(diagnosticsEntry().disabled).toBe(false);
  });

  it('goes back to disabled when the permission is withdrawn', () => {
    render(
      <>
        <ContextMenuRuntime />
        <ShellMenuProbe />
      </>,
    );
    allow(true);
    allow(false);

    expect(diagnosticsEntry().disabled).toBe(true);
  });

  it('puts the report on the clipboard when the enabled entry is chosen', () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    // jsdom implements no clipboard, so the write has to be observed through a
    // stub; the property is not writable and has to be defined.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <>
        <ContextMenuRuntime />
        <ShellMenuProbe />
      </>,
    );
    allow(true);

    act(() => {
      diagnosticsEntry().onSelect();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('GREMUCHAYA HQ / DIAGNOSTIC REPORT');
  });

  it('leaves the other shell commands alone', () => {
    render(
      <>
        <ContextMenuRuntime />
        <ShellMenuProbe />
      </>,
    );

    // No setting gates the search entry, so it stays disabled only because
    // nothing claims its keybind here -- not because a gate leaked onto it.
    const search = shellItems.find((item) => item.id === 'shell.search');
    expect(search).toBeDefined();
    allow(true);
    expect(shellItems.find((item) => item.id === 'shell.search')?.disabled).toBe(true);
  });
});

describe('the shell menu and the locale', () => {
  beforeEach(() => {
    shellItems = [];
    operationsStore.getState().resetWorld();
  });

  it('redraws its labels when the locale changes', () => {
    render(
      <>
        <ContextMenuRuntime />
        <ShellMenuProbe />
      </>,
    );
    expect(shellItems.find((item) => item.id === 'shell.search')?.label).toBe('Глобальный поиск');

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    /*
     * This is what `l:${locale}` in `menuOwnerSnapshot` buys. `contextMenuFor`
     * resolves a label at the moment the menu is built, but a subscriber whose
     * snapshot did not change is never asked to build one -- so without the
     * locale in that string the shell's commands button keeps the previous
     * language until some unrelated claim moves.
     */
    expect(shellItems.find((item) => item.id === 'shell.search')?.label).toBe('Global search');
  });
});

/*
 * R12: the engine's menu is replaced everywhere, not only on declared
 * surfaces -- with the two deliberate exceptions pinned below. `fireEvent`
 * returns whether the default was left alone, which is exactly the question:
 * a prevented default is the engine menu staying closed.
 */
describe('the right button on a surface no one declared', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    window.getSelection()?.removeAllRanges();
  });

  it('falls back to the shell menu instead of the engine menu', async () => {
    render(<ContextMenuRuntime />);
    const outsider = document.createElement('p');
    outsider.textContent = 'НЕОБЪЯВЛЕННАЯ ПОВЕРХНОСТЬ';
    document.body.append(outsider);

    const keptDefault = fireEvent.contextMenu(outsider, { clientX: 40, clientY: 40 });

    expect(keptDefault).toBe(false);
    expect(await screen.findByRole('menu')).toBeTruthy();
    outsider.remove();
  });

  it('keeps the engine menu for a click inside an active selection', () => {
    render(<ContextMenuRuntime />);
    const quoted = document.createElement('p');
    quoted.textContent = 'ВЫДЕЛЕННАЯ СТРОКА ПРЕДПРОСМОТРА';
    document.body.append(quoted);
    const range = document.createRange();
    range.selectNode(quoted);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // Copy lives in the engine's menu, and that is what the click was aimed
    // at: R12 opened preview text and table cells for selection, and the
    // shell menu has no copy to offer in its place.
    expect(fireEvent.contextMenu(quoted, { clientX: 40, clientY: 40 })).toBe(true);
    quoted.remove();
  });

  it('yields to an element that owns a Base UI menu of its own', () => {
    render(<ContextMenuRuntime />);
    const owner = document.createElement('div');
    owner.setAttribute('data-context-menu-own', '');
    document.body.append(owner);

    // The runtime opens nothing and prevents nothing: the element's own menu
    // is the one that answers, and it prevents the default itself.
    expect(fireEvent.contextMenu(owner, { clientX: 40, clientY: 40 })).toBe(true);
    owner.remove();
  });
});
