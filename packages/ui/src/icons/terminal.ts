import type { IconAdapter, IconNode } from './types.js';

/**
 * The repository's own drawn marks: plain `<path>`/`<line>`/`<rect>`/
 * `<circle>`/`<ellipse>`/`<polyline>` on a 24x24 viewBox, no fill unless a
 * comment below says otherwise, coloured entirely by `currentColor` so the
 * call site's own CSS decides light/dark and hover/focus. No icon dependency
 * for this one -- the repository draws its own chrome (see `CLAUDE.md`).
 *
 * The sixteen settings-card shapes are `settingsCardIcons.tsx`'s own `glyph`
 * switch, moved here node-for-node rather than redrawn, so `styles.iconSet`
 * at its `'terminal'` default renders the settings-card grid byte-identical
 * to before this pass. The seven window-chrome shapes are new: nothing drew
 * them before, because the controls they belong to used a bare Unicode
 * character (`titlebar.elements`' `WindowControl`, `ShellCommandsMenu`,
 * `OpsNavigation`'s compact toggle) rather than an SVG mark of any kind.
 */
export const terminalIconAdapter = {
  // A display: the frame an operator watches everything else through.
  interface: [
    ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 1, key: '0' }],
    ['line', { x1: 9, y1: 20, x2: 15, y2: 20, key: '1' }],
    ['line', { x1: 12, y1: 16, x2: 12, y2: 20, key: '2' }],
  ],
  // A running trace: the deterministic clock the world advances on.
  simulation: [['polyline', { points: '3,13 8,13 10,7 14,17 16,13 21,13', key: '0' }]],
  // Two panes sharing one desk: the multi-monitor placement section.
  workspace: [
    ['rect', { x: 2, y: 5, width: 9, height: 10, rx: 1, key: '0' }],
    ['rect', { x: 13, y: 5, width: 9, height: 10, rx: 1, key: '1' }],
  ],
  // Two nodes, one line: the devices this profile stays in sync with.
  group: [
    ['circle', { cx: 6, cy: 7, r: 3, key: '0' }],
    ['circle', { cx: 18, cy: 17, r: 3, key: '1' }],
    ['line', { x1: 8.4, y1: 9.2, x2: 15.6, y2: 14.8, key: '2' }],
  ],
  // A stack of stored rows: what stays on this machine with no network.
  data: [
    ['ellipse', { cx: 12, cy: 6, rx: 8, ry: 3, key: '0' }],
    ['path', { d: 'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6', key: '1' }],
    ['path', { d: 'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6', key: '2' }],
  ],
  // A key row: the chord reference.
  keybinds: [
    ['rect', { x: 2, y: 7, width: 20, height: 11, rx: 1, key: '0' }],
    ['line', { x1: 6, y1: 11, x2: 6, y2: 11.01, key: '1' }],
    ['line', { x1: 10, y1: 11, x2: 10, y2: 11.01, key: '2' }],
    ['line', { x1: 14, y1: 11, x2: 14, y2: 11.01, key: '3' }],
    ['line', { x1: 18, y1: 11, x2: 18, y2: 11.01, key: '4' }],
    ['line', { x1: 6, y1: 14.5, x2: 18, y2: 14.5, key: '5' }],
  ],
  // A clock face with a swept hand: the ledger of what changed and when.
  history: [
    ['circle', { cx: 12, cy: 12, r: 9, key: '0' }],
    ['line', { x1: 12, y1: 12, x2: 12, y2: 7, key: '1' }],
    ['line', { x1: 12, y1: 12, x2: 16, y2: 14, key: '2' }],
  ],
  // A reference sheet: the printed cheat-sheet, distinct from the chord list.
  keymap: [
    ['rect', { x: 4, y: 3, width: 16, height: 18, rx: 1, key: '0' }],
    ['line', { x1: 7.5, y1: 8, x2: 16.5, y2: 8, key: '1' }],
    ['line', { x1: 7.5, y1: 12, x2: 16.5, y2: 12, key: '2' }],
    ['line', { x1: 7.5, y1: 16, x2: 13, y2: 16, key: '3' }],
  ],
  // A half-lit disc: theme and accent.
  appearance: [
    ['circle', { cx: 12, cy: 12, r: 9, key: '0' }],
    ['path', { d: 'M12 3a9 9 0 0 1 0 18z', fill: 'currentColor', stroke: 'none', key: '1' }],
  ],
  // A four-tile grid: how the screen is packed.
  layout: [
    ['rect', { x: 3, y: 3, width: 8, height: 8, key: '0' }],
    ['rect', { x: 13, y: 3, width: 8, height: 8, key: '1' }],
    ['rect', { x: 3, y: 13, width: 8, height: 8, key: '2' }],
    ['rect', { x: 13, y: 13, width: 8, height: 8, key: '3' }],
  ],
  // Trailing lines: transitions and reduced motion.
  motion: [
    ['line', { x1: 4, y1: 8, x2: 14, y2: 8, key: '0' }],
    ['line', { x1: 4, y1: 12, x2: 18, y2: 12, key: '1' }],
    ['line', { x1: 4, y1: 16, x2: 11, y2: 16, key: '2' }],
  ],
  // A document: the readouts and status text the shell prints.
  information: [
    ['rect', { x: 5, y: 3, width: 14, height: 18, rx: 1, key: '0' }],
    ['line', { x1: 8, y1: 8, x2: 16, y2: 8, key: '1' }],
    ['line', { x1: 8, y1: 12, x2: 16, y2: 12, key: '2' }],
    ['line', { x1: 8, y1: 16, x2: 13, y2: 16, key: '3' }],
  ],
  // A play mark: the player and camera surfaces.
  media: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 1, key: '0' }],
    ['path', { d: 'M10 9l6 3-6 3z', fill: 'currentColor', stroke: 'none', key: '1' }],
  ],
  // A window chrome bar: popups, keybind prefixing, titlebar/statusline.
  session: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 1, key: '0' }],
    ['line', { x1: 3, y1: 9, x2: 21, y2: 9, key: '1' }],
    ['line', { x1: 6, y1: 7, x2: 6, y2: 7.01, key: '2' }],
    ['line', { x1: 9, y1: 7, x2: 9, y2: 7.01, key: '3' }],
  ],
  // A simplified cog: telemetry, performance, privacy, advanced.
  system: buildCogIcon(),
  // A download mark: the maintenance section at the end of the list.
  update: [
    ['line', { x1: 12, y1: 3, x2: 12, y2: 14, key: '0' }],
    ['path', { d: 'M7 10l5 5 5-5', key: '1' }],
    ['line', { x1: 4, y1: 20, x2: 20, y2: 20, key: '2' }],
  ],
  // A single dash: the window shrinks to the taskbar.
  minimize: [['line', { x1: 4, y1: 12, x2: 20, y2: 12, key: '0' }]],
  // A square outline: the window fills the work area.
  maximize: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 1, key: '0' }]],
  // Two overlapping squares: the window returns to its own bounds.
  restore: [
    ['rect', { x: 8, y: 4, width: 12, height: 12, rx: 1, key: '0' }],
    ['rect', { x: 4, y: 8, width: 12, height: 12, rx: 1, key: '1' }],
  ],
  // Two crossing strokes: the window closes.
  close: [
    ['line', { x1: 6, y1: 6, x2: 18, y2: 18, key: '0' }],
    ['line', { x1: 18, y1: 6, x2: 6, y2: 18, key: '1' }],
  ],
  // Three stacked lines: the commands the right-click menu also opens.
  menu: [
    ['line', { x1: 4, y1: 6, x2: 20, y2: 6, key: '0' }],
    ['line', { x1: 4, y1: 12, x2: 20, y2: 12, key: '1' }],
    ['line', { x1: 4, y1: 18, x2: 20, y2: 18, key: '2' }],
  ],
  // A rail with its wide pane open, arrow pointing into it: the compact toggle
  // when the rail is currently narrow.
  expand: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 1, key: '0' }],
    ['line', { x1: 10, y1: 4, x2: 10, y2: 20, key: '1' }],
    ['path', { d: 'M14 9l3 3-3 3', key: '2' }],
  ],
  // The same rail, arrow pointing out of it: the compact toggle when the rail
  // is currently at full width.
  collapse: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 1, key: '0' }],
    ['line', { x1: 10, y1: 4, x2: 10, y2: 20, key: '1' }],
    ['path', { d: 'M16 9l-3 3 3 3', key: '2' }],
  ],
} satisfies IconAdapter;

/**
 * The six spokes around the cog's hub, computed rather than hand-typed.
 *
 * `settingsCardIcons.tsx` built these with a `.map` over the same six angles
 * at render time; moved here to module load so the adapter stays plain data,
 * with the exact same trigonometry so the spokes land on the same pixels.
 */
function buildCogIcon(): IconNode {
  const hub: IconNode[number] = ['circle', { cx: 12, cy: 12, r: 4, key: 'hub' }];
  const spokes = [0, 60, 120, 180, 240, 300].map((angle): IconNode[number] => {
    const radians = (angle * Math.PI) / 180;
    return [
      'line',
      {
        x1: 12 + 6 * Math.cos(radians),
        y1: 12 + 6 * Math.sin(radians),
        x2: 12 + 9 * Math.cos(radians),
        y2: 12 + 9 * Math.sin(radians),
        key: `spoke-${angle.toString()}`,
      },
    ];
  });
  return [hub, ...spokes];
}
