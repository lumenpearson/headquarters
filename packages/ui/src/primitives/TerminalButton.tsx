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

/*
 * Border-radius aside, the button's chrome (border, background, color, font,
 * min-height) stays in primitives.css: `.ops-shell button` and
 * `body.terminal-theme button` reach the same properties on the bare
 * `<button>` element at equal-or-higher specificity, and `.ops-shell[data-
 * control-sizing='custom'] .terminal-button` names this class directly to
 * override its size variants' min-height. Only the structural and spacing
 * declarations that nothing else contests move here.
 */
const TERMINAL_BUTTON_BASE_UTILITY = 'rounded-none';

const TERMINAL_BUTTON_SIZE_UTILITY: Record<TerminalButtonSize, string> = {
  small: 'px-[9px]',
  medium: '',
  large: 'px-[18px]',
};

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
        TERMINAL_BUTTON_BASE_UTILITY,
        TERMINAL_BUTTON_SIZE_UTILITY[size],
        className,
      )}
      data-tone={tone}
      data-size={size}
    />
  );
});
