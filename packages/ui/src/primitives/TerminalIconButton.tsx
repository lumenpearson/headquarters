'use client';

import type { ReactNode } from 'react';

import { classNames } from './classNames.js';
import { TerminalButton } from './TerminalButton.js';
import type { TerminalButtonProps } from './TerminalButton.js';

export interface TerminalIconButtonProps extends Omit<TerminalButtonProps, 'children'> {
  readonly label: string;
  readonly children: ReactNode;
}

/*
 * `.terminal-icon-button` in primitives.css only ever sets sizing and layout
 * (width/min-width, zeroed padding, centered content) -- nothing there is
 * contested by an app rule keyed on width, so the whole square-button shape
 * moves here per size variant.
 */
const TERMINAL_ICON_BUTTON_SIZE_UTILITY: Record<
  NonNullable<TerminalButtonProps['size']>,
  string
> = {
  small: 'w-[26px] min-w-[26px]',
  medium: 'w-[34px] min-w-[34px]',
  large: 'w-[42px] min-w-[42px]',
};

export function TerminalIconButton({
  label,
  children,
  className,
  size = 'medium',
  ...properties
}: TerminalIconButtonProps) {
  return (
    <TerminalButton
      {...properties}
      size={size}
      aria-label={label}
      title={label}
      className={classNames(
        'terminal-icon-button',
        'p-0 justify-center',
        TERMINAL_ICON_BUTTON_SIZE_UTILITY[size],
        className,
      )}
    >
      {children}
    </TerminalButton>
  );
}
