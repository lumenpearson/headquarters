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
  return (
    <Toggle
      pressed={pressed}
      disabled={disabled}
      aria-label={label}
      className={classNames('terminal-toggle', className)}
      onPressedChange={(nextPressed) => onPressedChange(nextPressed)}
    >
      {label}
    </Toggle>
  );
}
