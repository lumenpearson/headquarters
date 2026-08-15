'use client';

import { Button } from '@base-ui/react/button';
import { forwardRef } from 'react';
import type { ButtonProps } from '@base-ui/react/button';

import { classNames } from './classNames.js';

export type TerminalButtonTone = 'neutral' | 'primary' | 'critical' | 'quiet';
export type TerminalButtonSize = 'small' | 'medium' | 'large';

export interface TerminalButtonProps extends Omit<ButtonProps, 'className'> {
  readonly className?: string;
  readonly tone?: TerminalButtonTone;
  readonly size?: TerminalButtonSize;
}

export const TerminalButton = forwardRef<HTMLElement, TerminalButtonProps>(function TerminalButton(
  { className, tone = 'neutral', size = 'medium', type = 'button', ...properties },
  reference,
) {
  return (
    <Button
      {...properties}
      ref={reference}
      type={type}
      className={classNames(
        'hq-button',
        'terminal-button',
        `terminal-button--${tone}`,
        `terminal-button--${size}`,
        className,
      )}
      data-tone={tone}
      data-size={size}
    />
  );
});
