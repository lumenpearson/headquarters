/**
 * Hand-rolled glyphs for the settings card grid, in the stroke-on-viewBox
 * style `OpsUi.tsx`'s `Gauge` already draws in: plain `<path>`/`<line>`/
 * `<circle>` on a small viewBox, no fill, coloured entirely by `currentColor`
 * so the card's own CSS decides light/dark and hover/focus. No icon
 * dependency -- the repository draws its own chrome (see `CLAUDE.md`).
 */

export type SettingsCardIconKind =
  | 'interface'
  | 'simulation'
  | 'workspace'
  | 'group'
  | 'data'
  | 'keybinds'
  | 'history'
  | 'keymap'
  | 'appearance'
  | 'layout'
  | 'motion'
  | 'information'
  | 'media'
  | 'session'
  | 'system'
  | 'update';

export function SettingsCardIcon({ kind }: { readonly kind: SettingsCardIconKind }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {glyph(kind)}
    </svg>
  );
}

function glyph(kind: SettingsCardIconKind) {
  switch (kind) {
    case 'interface':
      // A display: the frame an operator watches everything else through.
      return (
        <>
          <rect x="3" y="4" width="18" height="12" rx="1" />
          <line x1="9" y1="20" x2="15" y2="20" />
          <line x1="12" y1="16" x2="12" y2="20" />
        </>
      );
    case 'simulation':
      // A running trace: the deterministic clock the world advances on.
      return <polyline points="3,13 8,13 10,7 14,17 16,13 21,13" />;
    case 'workspace':
      // Two panes sharing one desk: the multi-monitor placement section.
      return (
        <>
          <rect x="2" y="5" width="9" height="10" rx="1" />
          <rect x="13" y="5" width="9" height="10" rx="1" />
        </>
      );
    case 'group':
      // Two nodes, one line: the devices this profile stays in sync with.
      return (
        <>
          <circle cx="6" cy="7" r="3" />
          <circle cx="18" cy="17" r="3" />
          <line x1="8.4" y1="9.2" x2="15.6" y2="14.8" />
        </>
      );
    case 'data':
      // A stack of stored rows: what stays on this machine with no network.
      return (
        <>
          <ellipse cx="12" cy="6" rx="8" ry="3" />
          <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
          <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
        </>
      );
    case 'keybinds':
      // A key row: the chord reference.
      return (
        <>
          <rect x="2" y="7" width="20" height="11" rx="1" />
          <line x1="6" y1="11" x2="6" y2="11.01" />
          <line x1="10" y1="11" x2="10" y2="11.01" />
          <line x1="14" y1="11" x2="14" y2="11.01" />
          <line x1="18" y1="11" x2="18" y2="11.01" />
          <line x1="6" y1="14.5" x2="18" y2="14.5" />
        </>
      );
    case 'history':
      // A clock face with a swept hand: the ledger of what changed and when.
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="12" x2="12" y2="7" />
          <line x1="12" y1="12" x2="16" y2="14" />
        </>
      );
    case 'keymap':
      // A reference sheet: the printed cheat-sheet, distinct from the chord list.
      return (
        <>
          <rect x="4" y="3" width="16" height="18" rx="1" />
          <line x1="7.5" y1="8" x2="16.5" y2="8" />
          <line x1="7.5" y1="12" x2="16.5" y2="12" />
          <line x1="7.5" y1="16" x2="13" y2="16" />
        </>
      );
    case 'appearance':
      // A half-lit disc: theme and accent.
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
        </>
      );
    case 'layout':
      // A four-tile grid: how the screen is packed.
      return (
        <>
          <rect x="3" y="3" width="8" height="8" />
          <rect x="13" y="3" width="8" height="8" />
          <rect x="3" y="13" width="8" height="8" />
          <rect x="13" y="13" width="8" height="8" />
        </>
      );
    case 'motion':
      // Trailing lines: transitions and reduced motion.
      return (
        <>
          <line x1="4" y1="8" x2="14" y2="8" />
          <line x1="4" y1="12" x2="18" y2="12" />
          <line x1="4" y1="16" x2="11" y2="16" />
        </>
      );
    case 'information':
      // A document: the readouts and status text the shell prints.
      return (
        <>
          <rect x="5" y="3" width="14" height="18" rx="1" />
          <line x1="8" y1="8" x2="16" y2="8" />
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="16" x2="13" y2="16" />
        </>
      );
    case 'media':
      // A play mark: the player and camera surfaces.
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="1" />
          <path d="M10 9l6 3-6 3z" fill="currentColor" stroke="none" />
        </>
      );
    case 'session':
      // A window chrome bar: popups, keybind prefixing, titlebar/statusline.
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="1" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="6" y1="7" x2="6" y2="7.01" />
          <line x1="9" y1="7" x2="9" y2="7.01" />
        </>
      );
    case 'system':
      // A simplified cog: telemetry, performance, privacy, advanced.
      return (
        <>
          <circle cx="12" cy="12" r="4" />
          {[0, 60, 120, 180, 240, 300].map((angle) => (
            <line
              key={angle}
              x1={12 + 6 * Math.cos((angle * Math.PI) / 180)}
              y1={12 + 6 * Math.sin((angle * Math.PI) / 180)}
              x2={12 + 9 * Math.cos((angle * Math.PI) / 180)}
              y2={12 + 9 * Math.sin((angle * Math.PI) / 180)}
            />
          ))}
        </>
      );
    case 'update':
      // A download mark: the maintenance section at the end of the list.
      return (
        <>
          <line x1="12" y1="3" x2="12" y2="14" />
          <path d="M7 10l5 5 5-5" />
          <line x1="4" y1="20" x2="20" y2="20" />
        </>
      );
  }
}
