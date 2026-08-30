import {
  Activity01Icon,
  Book01Icon,
  BrowserIcon,
  Cancel01Icon,
  ComputerIcon,
  ContrastIcon,
  Copy01Icon,
  Database01Icon,
  Download01Icon,
  File01Icon,
  GridViewIcon,
  HistoryIcon,
  KeyboardIcon,
  Menu01Icon,
  MinusSignIcon,
  MirroringScreenIcon,
  NetworkIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlayIcon,
  Settings01Icon,
  SquareIcon,
  WavesIcon,
} from '@hugeicons/core-free-icons';

import type { IconAdapter, IconNode } from './types.js';

/**
 * `@hugeicons/core-free-icons` (MIT), imported by name from the package's own
 * typed barrel -- its README names this the tree-shakeable static form (the
 * deep `/<Name>Icon` path it also offers is for a *dynamic* `import()`,
 * which this adapter has no use for). `sideEffects: false` plus a plain
 * `export const` per icon is what keeps the other ~4,500 icons out of the
 * bundle.
 *
 * Every one of this package's icons bakes `stroke`, `strokeLinecap`,
 * `strokeLinejoin` and `strokeWidth` onto *each path*, not once on an outer
 * element -- unlike lucide/tabler's raw nodes, which carry only geometry.
 * Left in place, those would sit below CSS as presentation attributes on
 * every child but not the child TerminalIcon's `.terminal-icon` class
 * actually reaches (that class is on the `<svg>` it draws; a rule targeting
 * only that element cannot out-cascade a value a descendant already
 * specifies for itself). `stripPresentation` removes exactly those four keys
 * per path so the size/colour a call site sets on the `<svg>` inherits down
 * to every child the way lucide's and tabler's already do.
 *
 * `workspace` has no dual-monitor icon in this set; `MirroringScreenIcon` (a
 * cast/mirroring glyph) is the nearest shape this library draws for "more
 * than one display," used with that one substitution. Every other name below
 * is a direct match.
 */
const presentationKeys = ['stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fill'];

function stripPresentation(node: IconNode): IconNode {
  return node.map(([tag, attrs]) => {
    const cleaned = Object.fromEntries(
      Object.entries(attrs).filter(([key]) => !presentationKeys.includes(key)),
    );
    return [tag, cleaned] as const;
  });
}

export const hugeiconsIconAdapter = {
  interface: stripPresentation(ComputerIcon),
  simulation: stripPresentation(Activity01Icon),
  workspace: stripPresentation(MirroringScreenIcon),
  group: stripPresentation(NetworkIcon),
  data: stripPresentation(Database01Icon),
  keybinds: stripPresentation(KeyboardIcon),
  history: stripPresentation(HistoryIcon),
  keymap: stripPresentation(Book01Icon),
  appearance: stripPresentation(ContrastIcon),
  layout: stripPresentation(GridViewIcon),
  motion: stripPresentation(WavesIcon),
  information: stripPresentation(File01Icon),
  media: stripPresentation(PlayIcon),
  session: stripPresentation(BrowserIcon),
  system: stripPresentation(Settings01Icon),
  update: stripPresentation(Download01Icon),
  minimize: stripPresentation(MinusSignIcon),
  maximize: stripPresentation(SquareIcon),
  restore: stripPresentation(Copy01Icon),
  close: stripPresentation(Cancel01Icon),
  menu: stripPresentation(Menu01Icon),
  expand: stripPresentation(PanelLeftOpenIcon),
  collapse: stripPresentation(PanelLeftCloseIcon),
} satisfies IconAdapter;
