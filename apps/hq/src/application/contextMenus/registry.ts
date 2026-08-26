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

export const contextMenuRegistry: readonly ContextMenuDefinition[] = [
  {
    surface: 'shell',
    label: 'Команды штаба',
    items: [
      { id: 'shell.search', label: 'Глобальный поиск', keybind: 'shell.search' },
      { id: 'shell.keybinds', label: 'Сочетания клавиш', keybind: 'keybinds.list' },
      { id: 'shell.edit', label: 'Режим редактирования', keybind: 'edit.toggle', tone: 'primary' },
      { id: 'shell.fullscreen', label: 'Полный экран', keybind: 'shell.fullscreen' },
      { id: 'shell.production', label: 'Панель режиссёра', keybind: 'shell.productionPanel' },
      {
        id: 'shell.group',
        label: 'Синхронизация группы',
        action: 'shell.groupPairing',
      },
      {
        id: 'shell.diagnostics',
        label: 'Скопировать диагностику',
        action: 'shell.copyDiagnostics',
        requiresSetting: 'privacy.copyDiagnostics',
      },
    ],
  },
  {
    surface: 'record',
    label: 'Действия над записью',
    items: [
      { id: 'record.open', label: 'Открыть карточку', action: 'record.open', tone: 'primary' },
      { id: 'record.select', label: 'Выделить строку', action: 'record.select' },
      { id: 'record.search', label: 'Найти упоминания', action: 'record.search' },
    ],
  },
];

export function contextMenuFor(surface: string): ContextMenuDefinition | undefined {
  return contextMenuRegistry.find((definition) => definition.surface === surface);
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
