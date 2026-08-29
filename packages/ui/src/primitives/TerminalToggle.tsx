'use client';

import { Toggle } from '@base-ui/react/toggle';

import { classNames } from './classNames.js';

export interface TerminalToggleProps {
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

export function TerminalToggle({
  pressed,
  onPressedChange,
  label,
  className,
  disabled = false,
}: TerminalToggleProps) {
  /*
   * `.terminal-toggle` shares its primitives.css rule with `.terminal-
   * toolbar__button` (TerminalToolbar.tsx carries the matching utilities).
   * Chrome (border, background, color, font) and the `[data-pressed]`/
   * `:focus-visible` overrides stay in css: those state selectors carry two
   * classes' worth of specificity, already ahead of `.ops-shell button`'s
   * one. Layout, spacing and the uppercase caption -- nothing `[data-
   * control-sizing]` reaches, since it never names `.terminal-toggle` --
   * move here.
   */
  return (
    <Toggle
      pressed={pressed}
      disabled={disabled}
      aria-label={label}
      className={classNames(
        'terminal-toggle',
        'min-h-[30px] px-hq-2 uppercase cursor-pointer',
        className,
      )}
      onPressedChange={(nextPressed) => onPressedChange(nextPressed)}
    >
      {label}
    </Toggle>
  );
}
