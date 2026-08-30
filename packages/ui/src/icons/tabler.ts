import { __iconNode as close } from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import { __iconNode as collapse } from '@tabler/icons-react/dist/esm/icons/IconLayoutSidebarLeftCollapse.mjs';
import { __iconNode as data } from '@tabler/icons-react/dist/esm/icons/IconDatabase.mjs';
import { __iconNode as expand } from '@tabler/icons-react/dist/esm/icons/IconLayoutSidebarLeftExpand.mjs';
import { __iconNode as group } from '@tabler/icons-react/dist/esm/icons/IconAffiliate.mjs';
import { __iconNode as history } from '@tabler/icons-react/dist/esm/icons/IconHistory.mjs';
import { __iconNode as information } from '@tabler/icons-react/dist/esm/icons/IconFileText.mjs';
import { __iconNode as interfaceIcon } from '@tabler/icons-react/dist/esm/icons/IconDeviceDesktop.mjs';
import { __iconNode as keybinds } from '@tabler/icons-react/dist/esm/icons/IconKeyboard.mjs';
import { __iconNode as keymap } from '@tabler/icons-react/dist/esm/icons/IconBook2.mjs';
import { __iconNode as layout } from '@tabler/icons-react/dist/esm/icons/IconLayoutGrid.mjs';
import { __iconNode as maximize } from '@tabler/icons-react/dist/esm/icons/IconSquare.mjs';
import { __iconNode as media } from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import { __iconNode as menu } from '@tabler/icons-react/dist/esm/icons/IconMenu2.mjs';
import { __iconNode as minimize } from '@tabler/icons-react/dist/esm/icons/IconMinus.mjs';
import { __iconNode as motion } from '@tabler/icons-react/dist/esm/icons/IconWaveSine.mjs';
import { __iconNode as restore } from '@tabler/icons-react/dist/esm/icons/IconCopy.mjs';
import { __iconNode as session } from '@tabler/icons-react/dist/esm/icons/IconLayoutNavbar.mjs';
import { __iconNode as simulation } from '@tabler/icons-react/dist/esm/icons/IconActivity.mjs';
import { __iconNode as styleAppearance } from '@tabler/icons-react/dist/esm/icons/IconContrast.mjs';
import { __iconNode as system } from '@tabler/icons-react/dist/esm/icons/IconSettings.mjs';
import { __iconNode as update } from '@tabler/icons-react/dist/esm/icons/IconDownload.mjs';
import { __iconNode as workspace } from '@tabler/icons-react/dist/esm/icons/IconLayoutColumns.mjs';

import type { IconAdapter } from './types.js';

/**
 * `@tabler/icons-react` (MIT), already in Next's default `experimental.
 * optimizePackageImports` -- one icon per import, so the bundle carries the
 * ~23 paths this adapter names and none of the other roughly 5,900.
 *
 * `createReactComponent`'s `stroke` prop sets *stroke-width*, not colour --
 * the DOM `stroke` attribute is fixed to its `color` prop, which the
 * component always writes (there is no prop whose name lands past that
 * destructuring and reaches the element unset). The raw `__iconNode` each
 * icon module also exports carries only `d`/`key` on every child, so this
 * adapter reads that directly and lets `TerminalIcon` own the outer `<svg>`,
 * the same reason `lucide.ts` bypasses its own package's component.
 *
 * Every name below is a direct match for the shape tabler already draws;
 * none needed a substitute.
 */
export const tablerIconAdapter = {
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
