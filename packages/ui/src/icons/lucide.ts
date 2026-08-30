import { __iconNode as close } from 'lucide-react/dist/esm/icons/x.mjs';
import { __iconNode as collapse } from 'lucide-react/dist/esm/icons/panel-left-close.mjs';
import { __iconNode as data } from 'lucide-react/dist/esm/icons/database.mjs';
import { __iconNode as expand } from 'lucide-react/dist/esm/icons/panel-left-open.mjs';
import { __iconNode as group } from 'lucide-react/dist/esm/icons/network.mjs';
// 'history' re-exports 'rotate-ccw-clock''s default component but not its
// `__iconNode`, so the canonical file is imported directly.
import { __iconNode as history } from 'lucide-react/dist/esm/icons/rotate-ccw-clock.mjs';
import { __iconNode as information } from 'lucide-react/dist/esm/icons/file-text.mjs';
import { __iconNode as interfaceIcon } from 'lucide-react/dist/esm/icons/monitor.mjs';
import { __iconNode as keybinds } from 'lucide-react/dist/esm/icons/keyboard.mjs';
import { __iconNode as keymap } from 'lucide-react/dist/esm/icons/book-open.mjs';
import { __iconNode as layout } from 'lucide-react/dist/esm/icons/layout-grid.mjs';
import { __iconNode as maximize } from 'lucide-react/dist/esm/icons/square.mjs';
import { __iconNode as media } from 'lucide-react/dist/esm/icons/play.mjs';
import { __iconNode as menu } from 'lucide-react/dist/esm/icons/menu.mjs';
import { __iconNode as minimize } from 'lucide-react/dist/esm/icons/minus.mjs';
// Same reason as 'history' above: 'waves' is an alias of 'waves-horizontal'.
import { __iconNode as motion } from 'lucide-react/dist/esm/icons/waves-horizontal.mjs';
import { __iconNode as restore } from 'lucide-react/dist/esm/icons/copy.mjs';
import { __iconNode as session } from 'lucide-react/dist/esm/icons/layout-panel-top.mjs';
import { __iconNode as simulation } from 'lucide-react/dist/esm/icons/activity.mjs';
import { __iconNode as styleAppearance } from 'lucide-react/dist/esm/icons/contrast.mjs';
import { __iconNode as system } from 'lucide-react/dist/esm/icons/settings.mjs';
import { __iconNode as update } from 'lucide-react/dist/esm/icons/download.mjs';
import { __iconNode as workspace } from 'lucide-react/dist/esm/icons/columns-2.mjs';

import type { IconAdapter } from './types.js';

/**
 * lucide-react (ISC), already in Next's default `experimental.
 * optimizePackageImports` -- one icon per import, so the bundle carries the
 * ~23 paths this adapter names and none of the other roughly 4,000.
 *
 * Every import here reaches a single icon's own module for its raw
 * `__iconNode` rather than the component `createLucideIcon` builds from it:
 * that component hard-codes `width`, `height` and `stroke` on the outer
 * `<svg>` with no prop that removes them (only ones that recolour or
 * resize), which is exactly the attribute leak `TerminalIcon`'s contract
 * refuses. The raw node carries only `d`/`key` (or the primitive's own
 * geometry) on each child, so `TerminalIcon` owns the outer `<svg>` and every
 * attribute on it outright.
 *
 * Every name below is a direct match for the shape lucide already draws;
 * none needed a substitute.
 */
export const lucideIconAdapter = {
  interface: interfaceIcon,
  simulation,
  workspace,
  group,
  data,
  keybinds,
  history,
  keymap,
  appearance: styleAppearance,
  layout,
  motion,
  information,
  media,
  session,
  system,
  update,
  minimize,
  maximize,
  restore,
  close,
  menu,
  expand,
  collapse,
} satisfies IconAdapter;
