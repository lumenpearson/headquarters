// @vitest-environment jsdom
import type { TerminalMenuItem } from '@gremuchaya/ui/primitives';
import { act, render } from '@testing-library/react';
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
