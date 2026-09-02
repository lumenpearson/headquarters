/*
 * Shared utility strings for the portalled overlay primitives (dialog, alert
 * dialog, popover, tooltip and the three menu flavours). Every surface here
 * is rendered through a Base UI `Portal` straight onto `document.body`: it
 * escapes `.ops-shell` entirely, so none of that stylesheet's descendant
 * selectors reach it, but it stays a plain element for `body.terminal-theme`
 * and the bare-element reset in `hq.css` (`button, select, input { border: 0;
 * outline: 0 }`), which key off the tag name rather than an ancestor.
 *
 * Base UI's own popup parts render `<div>`s (menu items, popovers, dialogs,
 * tooltips) rather than form controls, so neither of those rules reaches
 * them, and grepping every app stylesheet for the class names below turned
 * up no competing declaration. That leaves only two things this file keeps
 * out of Tailwind:
 *
 * - `border-radius` -- `body.terminal-theme * { border-radius: 0 !important }`
 *   already zeroes it everywhere, `!important` beats layered and unlayered
 *   rules alike, and a `rounded-*` utility would be dead weight.
 * - The `[data-highlighted]` / `[data-tone='critical']` colour overrides on a
 *   menu item, and the toast's per-tone `border-left-color` -- these remain in
 *   primitives.css, which is unlayered and therefore always outranks a
 *   Tailwind utility regardless of specificity. The *base* colour each of
 *   them overrides is safe to migrate: the override stays authoritative
 *   either way, migrated base or not.
 *
 * This file is not re-exported from `index.ts`: it is an implementation
 * detail the menu trio and the dialog pair share, not new package surface.
 */

/** `.terminal-menu__positioner, .terminal-tooltip__positioner` in primitives.css. */
export const TERMINAL_POPUP_POSITIONER_UTILITY = 'z-[var(--z-popup)] outline-none';

/**
 * `.terminal-menu` plus its enter/exit motion. Shared by `TerminalMenu`,
 * `TerminalContextMenu` and `TerminalPointerMenu`, which each append their own
 * additional semantic class (`terminal-context-menu` / `terminal-pointer-menu`)
 * next to this one.
 *
 * The popup carries the shell's fluid font size the way `.terminal-select__popup`
 * does on this branch -- portalled past `.ops-shell`, it cannot inherit the
 * shell's viewport-scaled type, so it reads `--ops-font-size` off `body`
 * (mirrored there by `OperationsShell`) with the previous static token as the
 * fallback for a route that never mounts the shell. `.terminal-menu__item`
 * no longer sets its own font-size/font-family: it inherits both from here.
 */
export const TERMINAL_MENU_BASE_UTILITY =
  'min-w-[190px] max-w-[min(360px,calc(100vw_-_16px))] p-[3px] border border-hq-line-2 outline-none bg-hq-bg-1 text-hq-text-1 shadow-none [font-family:var(--font-mono)] text-[length:var(--ops-font-size,var(--font-xs))] origin-[var(--transform-origin)] transition-[opacity,transform] duration-hq-micro [transition-timing-function:linear,ease] data-[starting-style]:opacity-0 data-[starting-style]:scale-y-[0.94] data-[ending-style]:opacity-0 data-[ending-style]:scale-y-[0.94]';

/**
 * `.terminal-menu__item`. The `[data-highlighted]` background/colour and the
 * `[data-tone='critical']:not([data-highlighted])` colour stay in
 * primitives.css (see the file header); `[data-disabled]` is a plain
 * cursor/opacity pair nothing else contests, so it migrates whole.
 */
export const TERMINAL_MENU_ITEM_UTILITY =
  'grid min-h-[30px] grid-cols-[minmax(0,1fr)_auto] items-center gap-hq-4 px-hq-2 outline-none cursor-pointer uppercase data-[disabled]:cursor-not-allowed data-[disabled]:opacity-[0.38]';

/** `.terminal-menu__item kbd`. */
export const TERMINAL_MENU_ITEM_KBD_UTILITY = 'text-current [font:inherit] opacity-[0.72]';

/**
 * `.terminal-dialog`'s chrome and motion, shared verbatim by `TerminalDialog`
 * and `TerminalAlertDialog`. The size (`width`/`max-height`/`grid-template-rows`)
 * is deliberately not here: `.terminal-alert-dialog` sets its own, and two
 * Tailwind classes naming the same property at equal specificity resolve by
 * generation order rather than by which one appears later in `className`, so
 * each consumer's own size utility has to be the *only* one naming that
 * property rather than a second class trying to out-cascade this one.
 */
export const TERMINAL_DIALOG_POPUP_UTILITY =
  'grid border border-hq-accent outline-none bg-hq-bg-1 text-hq-text-0 shadow-none translate-y-0 transition-[opacity,transform] duration-hq-standard [transition-timing-function:linear,ease] data-[starting-style]:opacity-0 data-[starting-style]:translate-y-[10px] data-[starting-style]:scale-[0.985] data-[ending-style]:opacity-0 data-[ending-style]:translate-y-[10px] data-[ending-style]:scale-[0.985]';

/** `.terminal-dialog`'s own size, on top of `TERMINAL_DIALOG_POPUP_UTILITY`. */
export const TERMINAL_DIALOG_SIZE_UTILITY =
  'w-[min(640px,calc(100vw_-_32px))] max-h-[min(760px,calc(100dvh_-_32px))] grid-rows-[auto_auto_minmax(0,1fr)_auto]';

/** `.terminal-dialog__header` / `.terminal-dialog__footer`, shared base. Header keeps
 * the space-between alignment and bottom rule; the footer overrides both, so
 * it carries its own literal string rather than one built from this at
 * runtime. */
export const TERMINAL_DIALOG_HEADER_UTILITY =
  'flex min-h-[46px] items-center justify-between gap-hq-3 px-hq-3 py-hq-2 border-b border-hq-line-1 bg-hq-panel-1';

export const TERMINAL_DIALOG_FOOTER_UTILITY =
  'flex min-h-[46px] items-center justify-end gap-hq-3 px-hq-3 py-hq-2 border-t border-hq-line-1 bg-hq-panel-1';

/** `.terminal-dialog__description`, shared by the dialog and the alert dialog. */
export const TERMINAL_DIALOG_DESCRIPTION_UTILITY =
  'm-0 pt-hq-3 px-hq-4 pb-0 text-hq-text-1 [font-family:var(--font-mono)] text-hq-sm';

/**
 * `.terminal-dialog__backdrop, .terminal-drawer__backdrop`'s shared halves
 * (position, blur, motion) plus the dialog's own 42% tint; `TerminalDrawer`
 * carries the same shape with its own, lighter tint (`terminal-drawer__backdrop`
 * in primitives.css overrides the shared rule's background for exactly this
 * reason).
 *
 * The blur strength reads `--ops-overlay-blur` (`popups.overlayBlur`) with a
 * literal `16px` fallback -- this package stays scene-agnostic and may only
 * see an `--ops-*` property through `var()` with a fallback equal to what the
 * property replaced, the same contract `--ops-font-size` already keeps above.
 * `saturate(90%)` and the tints stay literal: the setting governs strength
 * only.
 */
export const TERMINAL_DIALOG_BACKDROP_UTILITY =
  'fixed z-[var(--z-dialog)] inset-0 opacity-100 [backdrop-filter:blur(var(--ops-overlay-blur,16px))_saturate(90%)] bg-[rgb(0_0_0_/_42%)] transition-[opacity,backdrop-filter] duration-hq-standard [transition-timing-function:linear,ease] data-[starting-style]:opacity-0 data-[starting-style]:[backdrop-filter:blur(0px)_saturate(100%)] data-[ending-style]:opacity-0 data-[ending-style]:[backdrop-filter:blur(0px)_saturate(100%)]';

export const TERMINAL_DRAWER_BACKDROP_UTILITY =
  'fixed z-[var(--z-dialog)] inset-0 opacity-100 [backdrop-filter:blur(var(--ops-overlay-blur,16px))_saturate(90%)] bg-[rgb(0_0_0_/_26%)] transition-[opacity,backdrop-filter] duration-hq-standard [transition-timing-function:linear,ease] data-[starting-style]:opacity-0 data-[starting-style]:[backdrop-filter:blur(0px)_saturate(100%)] data-[ending-style]:opacity-0 data-[ending-style]:[backdrop-filter:blur(0px)_saturate(100%)]';
