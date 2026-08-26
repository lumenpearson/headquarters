import { t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';

import { activeKeybinds } from '../keybinds/activeScheme';
import { formatChord } from '../keybinds/match';

/**
 * The surfaces that answer a right click with a menu of their own.
 *
 * An element opts in by carrying `data-context-menu="<surface>"`; the runtime
 * walks up from whatever the pointer hit and takes the nearest one, so a row
 * inside the shell gets the row's menu and the space around it gets the
 * shell's.
 */
export const contextSurfaces = ['shell', 'record'] as const;

export type ContextSurface = (typeof contextSurfaces)[number];

export interface ContextMenuEntry {
  readonly id: string;
  /** Already in the locale in force -- see {@link contextMenuFor}. */
  readonly label: string;
  /**
   * The keybind this entry runs, when it runs one.
   *
   * A command that already has a chord is not re-implemented here: the entry
   * fires that keybind's owners, and prints its chord beside itself. The
   * alternative -- a second handler doing the same work -- is how the shortcut
   * list and the menu would come to disagree about what a command does.
   */
  readonly keybind?: string;
  /**
   * The action this entry raises, when it is not a keybind.
   *
   * Claimed with `useContextMenuAction` by whichever screen can carry it out,
   * and drawn disabled where nothing claims it.
   */
  readonly action?: string;
  /**
   * The boolean setting that has to be on before this entry may run.
   *
   * A command the operator has switched off is drawn disabled, never dropped,
   * for the same reason an unclaimed one is: a command that disappears is a
   * command the operator concludes this build does not have, and then looks
   * for the switch that would bring it back without knowing one exists.
   */
  readonly requiresSetting?: string;
  readonly tone?: 'neutral' | 'primary' | 'critical';
}

export interface ContextMenuDefinition {
  readonly surface: ContextSurface;
  readonly label: string;
  readonly items: readonly ContextMenuEntry[];
}

/**
 * What the registry declares, as against what a menu renders.
 *
 * The two are separated because the consumers of a rendered menu are not all
 * reachable from here -- `OperationsShell` draws the shell menu from a
 * `ContextMenuDefinition` and reads `label` straight onto a `TerminalMenu`.
 * Resolving the catalogue inside {@link contextMenuFor} keeps every one of
 * those call sites correct without any of them learning that a locale exists,
 * and keeps the declaration itself free of text, which is the point.
 */
export type ContextMenuEntryDeclaration = Omit<ContextMenuEntry, 'label'> & {
  readonly labelId: MessageId;
};

export interface ContextMenuDeclaration {
  readonly surface: ContextSurface;
  readonly labelId: MessageId;
  readonly items: readonly ContextMenuEntryDeclaration[];
}

export const contextMenuRegistry: readonly ContextMenuDeclaration[] = [
  {
    surface: 'shell',
    labelId: 'menu.shell',
    items: [
      { id: 'shell.search', labelId: 'menu.shell.search', keybind: 'shell.search' },
      { id: 'shell.keybinds', labelId: 'menu.shell.keybinds', keybind: 'keybinds.list' },
      {
        id: 'shell.edit',
        labelId: 'menu.shell.edit',
        keybind: 'edit.toggle',
        tone: 'primary',
      },
      { id: 'shell.fullscreen', labelId: 'menu.shell.fullscreen', keybind: 'shell.fullscreen' },
      {
        id: 'shell.production',
        labelId: 'menu.shell.production',
        keybind: 'shell.productionPanel',
      },
      {
        id: 'shell.group',
        labelId: 'menu.shell.group',
        action: 'shell.groupPairing',
      },
      {
        id: 'shell.diagnostics',
        labelId: 'menu.shell.diagnostics',
        action: 'shell.copyDiagnostics',
        requiresSetting: 'privacy.copyDiagnostics',
      },
    ],
  },
  {
    surface: 'record',
    labelId: 'menu.record',
    items: [
      { id: 'record.open', labelId: 'menu.record.open', action: 'record.open', tone: 'primary' },
      { id: 'record.select', labelId: 'menu.record.select', action: 'record.select' },
      { id: 'record.search', labelId: 'menu.record.search', action: 'record.search' },
    ],
  },
];

/**
 * The menu for a surface, in the language the operator is reading.
 *
 * Resolved here rather than by each caller because the menu is drawn in three
 * places -- the right-click runtime, the shell's own commands button, and
 * whatever else claims a surface next -- and a caller that forgot to translate
 * would show `menu.record.open` on a row. Callers re-render on a locale change
 * for the same reason they re-render on a claim: `menuOwnerSnapshot` carries
 * the locale, so the snapshot they subscribe to changes with it.
 */
export function contextMenuFor(surface: string): ContextMenuDefinition | undefined {
  const declaration = contextMenuRegistry.find((entry) => entry.surface === surface);
  if (declaration === undefined) return undefined;
  return {
    surface: declaration.surface,
    label: t(declaration.labelId),
    items: declaration.items.map(({ labelId, ...entry }) => ({ ...entry, label: t(labelId) })),
  };
}

/**
 * The chord printed beside an entry, taken from the collection now in force.
 *
 * Never a literal: a chord written twice is a chord that will be changed once.
 *
 * It resolved through `keybindRegistry` — the `terminal-default` collection —
 * rather than through the scheme the operator selected, so under
 * `vim-inspired` or the accessibility collection the menu advertised a chord
 * that would not fire. The same defect the shell's own hint had (C35, commit
 * `43f622b`); a menu is the second place a chord is printed, and it drifted the
 * same way.
 */
export function entryShortcut(entry: ContextMenuEntry): string | undefined {
  if (entry.keybind === undefined) return undefined;
  const keybind = activeKeybinds().find((candidate) => candidate.id === entry.keybind);
  return keybind === undefined ? undefined : formatChord(keybind.chord);
}
