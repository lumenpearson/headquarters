import type { MessageId, MessageParams } from '@/application/localization/messages';

import { primaryNavigation } from '../navigation';
import { matchesChord, type Chord } from './match';

export const keybindCategories = ['navigation', 'operation', 'editing', 'developer'] as const;

export type KeybindCategory = (typeof keybindCategories)[number];

export interface Keybind {
  readonly id: string;
  readonly chord: Chord;
  readonly category: KeybindCategory;
  /**
   * What the list says this keybind does, as a catalogue id rather than as
   * text.
   *
   * The registry is a declaration and the list is a surface; whichever
   * language the surface is drawing in is not the registry's business. Naming
   * the field `descriptionId` rather than leaving `description` holding an id
   * is the difference between a table a reader can trust and one where the
   * same field means two things depending on the row.
   */
  readonly descriptionId: MessageId;
  /**
   * The parameters that description takes, for the one that takes any.
   *
   * The nine numbered routes read `Перейти: {target}`, and the target is the
   * rail's own label from `primaryNavigation` -- so the badge, the chord and
   * the description all still come from one list.
   */
  readonly descriptionParams?: MessageParams;
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
 *
 * This is also the `terminal-default` collection `keybinds.scheme` names. The
 * other two collections are chord tables over these entries (`./schemes`), so
 * an action's id, category, description and typing guard are still declared
 * once whichever scheme is active.
 */
export const keybindRegistry: readonly Keybind[] = [
  ...primaryNavigation.slice(0, 9).map((entry, index) => ({
    // Digits address the rail by position, which is what the badge beside each
    // entry has always shown. Only the first nine: there is no key for "10".
    id: `navigate.${entry[0]}`,
    chord: { code: `Digit${(index + 1).toString()}` },
    category: 'navigation' as const,
    descriptionId: 'keybind.navigate' as const,
    descriptionParams: { target: entry[3] },
    whileTyping: false,
    preventsDefault: true,
  })),
  {
    id: 'shell.search',
    chord: { code: 'KeyK', ctrl: true },
    category: 'navigation',
    descriptionId: 'keybind.shell.search',
    whileTyping: true,
    preventsDefault: true,
  },
  {
    id: 'shell.dismiss',
    chord: { code: 'Escape' },
    category: 'operation',
    descriptionId: 'keybind.shell.dismiss',
    whileTyping: true,
    preventsDefault: false,
  },
  {
    id: 'shell.productionPanel',
    chord: { code: 'KeyP', ctrl: true, shift: true },
    category: 'operation',
    descriptionId: 'keybind.shell.productionPanel',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'shell.fullscreen',
    chord: { code: 'KeyF' },
    category: 'operation',
    descriptionId: 'keybind.shell.fullscreen',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'shell.togglePlayback',
    chord: { code: 'Space' },
    category: 'operation',
    descriptionId: 'keybind.shell.togglePlayback',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'edit.toggle',
    chord: { code: 'KeyE', ctrl: true, shift: true },
    category: 'editing',
    descriptionId: 'keybind.edit.toggle',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    // Dragging picks an edge directly, by where the pointer left the window;
    // the keybind has no equivalent gesture, so it cycles the same four edges
    // instead -- see `EditPanelDock.nextDockEdge`.
    id: 'edit.dockPanel',
    chord: { code: 'ArrowRight', ctrl: true, shift: true },
    category: 'editing',
    descriptionId: 'keybind.edit.dockPanel',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'keybinds.list',
    chord: { code: 'Slash', ctrl: true },
    category: 'operation',
    descriptionId: 'keybind.keybinds.list',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'files.import',
    chord: { code: 'KeyS', ctrl: true, shift: true, alt: true },
    category: 'editing',
    descriptionId: 'keybind.files.import',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.commandPalette',
    chord: { code: 'KeyK', ctrl: true, shift: true },
    category: 'developer',
    descriptionId: 'keybind.scene.commandPalette',
    whileTyping: true,
    preventsDefault: true,
  },
  {
    id: 'scene.sectionFiles',
    chord: { code: 'F2' },
    category: 'developer',
    descriptionId: 'keybind.scene.sectionFiles',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.sectionMap',
    chord: { code: 'F3' },
    category: 'developer',
    descriptionId: 'keybind.scene.sectionMap',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.previousCue',
    chord: { code: 'F7' },
    category: 'developer',
    descriptionId: 'keybind.scene.previousCue',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.nextCue',
    chord: { code: 'F8' },
    category: 'developer',
    descriptionId: 'keybind.scene.nextCue',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'scene.resetScene',
    chord: { code: 'F9' },
    category: 'developer',
    descriptionId: 'keybind.scene.resetScene',
    whileTyping: false,
    preventsDefault: true,
  },
  {
    id: 'developer.toggle',
    chord: { code: 'KeyD', ctrl: true, shift: true, alt: true },
    category: 'developer',
    descriptionId: 'keybind.developer.toggle',
    whileTyping: false,
    preventsDefault: true,
  },
];

/**
 * Finds the keybind an event fires, if any.
 *
 * `typing` is decided once by the runtime rather than per handler, which is
 * what the three separate guards used to disagree about.
 *
 * `keybinds` is the collection `keybinds.scheme` selected; it defaults to the
 * declarations above, which are the `terminal-default` scheme itself. A caller
 * that does not pass one therefore gets the default collection rather than
 * whatever the operator chose, so the runtime passes it explicitly.
 *
 * A pending prefix is tried first and the unprefixed chords second. Falling
 * through matters: with `g` held open, Escape still has to dismiss the panel,
 * and a scheme that swallowed it until the prefix expired would leave the
 * operator with an overlay they cannot close.
 */
export function findKeybind(
  event: KeyboardEvent,
  {
    typing,
    prefix,
    keybinds = keybindRegistry,
  }: {
    readonly typing: boolean;
    readonly prefix?: string | undefined;
    readonly keybinds?: readonly Keybind[];
  },
): Keybind | undefined {
  const reachable = keybinds.filter((keybind) => keybind.whileTyping || !typing);
  if (prefix !== undefined) {
    const chained = reachable.find((keybind) => matchesChord(event, keybind.chord, prefix));
    if (chained !== undefined) return chained;
  }
  return reachable.find((keybind) => matchesChord(event, keybind.chord));
}

/**
 * The prefix this event opens, if the active collection has one.
 *
 * A prefix is a bare key: every modifier combination is already a chord in its
 * own right, and arming on Ctrl+G would take a combination away from the
 * scheme that declares it.
 */
export function prefixKeyFor(
  event: KeyboardEvent,
  keybinds: readonly Keybind[],
): string | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return undefined;
  return keybinds.some((keybind) => keybind.chord.prefix === event.code) ? event.code : undefined;
}
