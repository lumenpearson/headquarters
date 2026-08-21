'use client';

import type { ReactNode } from 'react';

import { classNames } from './classNames.js';
import { TerminalButton } from './TerminalButton.js';
import type { TerminalButtonProps } from './TerminalButton.js';

export interface TerminalIconButtonProps extends Omit<TerminalButtonProps, 'children'> {
  readonly label: string;
  readonly children: ReactNode;
}

export function TerminalIconButton({
  label,
  children,
  className,
  ...properties
}: TerminalIconButtonProps) {
  return (
    <TerminalButton
      {...properties}
      aria-label={label}
      title={label}
      className={classNames('terminal-icon-button', className)}
    >
      {children}
    </TerminalButton>
  );
}
