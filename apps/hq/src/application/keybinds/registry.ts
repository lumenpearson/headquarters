import { primaryNavigation } from '../navigation';
import { matchesChord, type Chord } from './match';

export const keybindCategories = ['navigation', 'operation', 'editing', 'developer'] as const;

export type KeybindCategory = (typeof keybindCategories)[number];

export interface Keybind {
  readonly id: string;
  readonly chord: Chord;
  readonly category: KeybindCategory;
  readonly description: string;
  /**
   * Whether the keybind still fires while a field has focus.
   *
   * True only for the ones whose whole purpose is to get out of a field --
   * dismissing an overlay, or jumping to search. Everything else would eat a
   * character the operator meant to type.
   */
  readonly whileTyping: boolean;
  /**
   * Whether firing this keybind also swallows the key.
   *
   * False for Escape alone: overlays, dialogs and menus all close on it, and
   * swallowing it here would leave them open. Everything else replaces a
   * browser default the application does not want.
   */
  readonly preventsDefault: boolean;
}

/**
 * Every application-wide keybind, declared in one place.
 *
 * Before this, each one was an `if` inside whichever effect happened to own it
 * -- the shell, edit mode, the files screen, the developer gate -- which is why
 * R11 could not be built: there was no list to show, nothing could detect two
 * chords colliding, and the "is the operator typing?" guard was written three
 * times with three different answers.
 *
 * Element-scoped keys are deliberately not here. The media player's arrows and
 * space act on a focused player, not on the application, and listing them as
 * global would be a promise the application does not keep.
 */
export const keybindRegistry: readonly Keybind[] = [
  ...primaryNavigation.slice(0, 9).map((entry, index) => ({
    // Digits address the rail by position, which is what the badge beside each
    // entry has always shown. Only the first nine: there is no key for "10".
    id: `navigate.${entry[0]}`,
    chord: { code: `Digit${(index + 1).toString()}` },
    category: 'navigation' as const,
    description: `Перейти: ${entry[3]}`,
    whileTyping: false,
    preventsDefault: true,
  })),
  {
    id: 'shell.search',
    chord: { code: 'KeyK', ctrl: true },
    category: 'navigation',
    description: 'Глобальный поиск',
    whileTyping: true,
    preventsDefault: true,
  },
  {
    id: 'shell.dismiss',
    chord: { code: 'Escape' },
    category: 'operation',
    description: 'Закрыть панель или ящик',
    whileTyping: true,
    preventsDefault: false,
  },
  {
    id: 'shell.productionPanel',
    chord: { code: 'KeyP', ctrl: true, shift: true },
    category: 'operation',
    description: 'Панель режиссёра',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'shell.fullscreen',
    chord: { code: 'KeyF' },
    category: 'operation',
    description: 'Полный экран',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'shell.togglePlayback',
    chord: { code: 'Space' },
    category: 'operation',
    description: 'Пуск и пауза видео (на видеоэкранах)',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'edit.toggle',
    chord: { code: 'KeyE', ctrl: true, shift: true },
    category: 'editing',
    description: 'Режим редактирования',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'keybinds.list',
    chord: { code: 'Slash', ctrl: true },
    category: 'operation',
    description: 'Список сочетаний клавиш',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'files.import',
    chord: { code: 'KeyS', ctrl: true, shift: true, alt: true },
    category: 'editing',
    description: 'Локальный импорт материалов',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.commandPalette',
    chord: { code: 'KeyK', ctrl: true, shift: true },
    category: 'developer',
    description: 'Палитра команд сцены',
    whileTyping: true,
    preventsDefault: true,
  },
  {
    id: 'scene.sectionFiles',
    chord: { code: 'F2' },
    category: 'developer',
    description: 'Раздел: файлы',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.sectionMap',
    chord: { code: 'F3' },
    category: 'developer',
    description: 'Раздел: карта',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.previousCue',
    chord: { code: 'F7' },
    category: 'developer',
    description: 'Предыдущая реплика сцены',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.nextCue',
    chord: { code: 'F8' },
    category: 'developer',
    description: 'Следующая реплика сцены',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.resetScene',
    chord: { code: 'F9' },
    category: 'developer',
    description: 'Сбросить сцену',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'developer.toggle',
    chord: { code: 'KeyD', ctrl: true, shift: true, alt: true },
    category: 'developer',
    description: 'Панель разработчика',
    whileTyping: false,
    preventsDefault: true,
  },
];

/**
 * Finds the keybind an event fires, if any.
 *
 * `typing` is decided once by the runtime rather than per handler, which is
 * what the three separate guards used to disagree about.
 */
export function findKeybind(
  event: KeyboardEvent,
  { typing }: { readonly typing: boolean },
): Keybind | undefined {
  return keybindRegistry.find(
    (keybind) => (keybind.whileTyping || !typing) && matchesChord(event, keybind.chord),
  );
}
