'use client';

import { Input } from '@base-ui/react/input';
import { forwardRef } from 'react';
import type { InputProps } from '@base-ui/react/input';

import { classNames } from './classNames.js';

export interface TerminalInputProps extends Omit<InputProps, 'className'> {
  readonly className?: string;
}

export const TerminalInput = forwardRef<HTMLElement, TerminalInputProps>(function TerminalInput(
  { className, ...properties },
  reference,
) {
  return (
    <Input
      {...properties}
      ref={reference}
      /*
       * Chrome (border, background, color, font, min-height) stays in
       * primitives.css: `.ops-shell input` and `body.terminal-theme input`
       * reach the bare `<input>` element at equal-or-higher specificity, and
       * `.ops-shell[data-control-sizing='custom'] .terminal-input` names this
       * class directly for its min-height override. Only sizing that nothing
       * contests moves here.
       */
      className={classNames('hq-input', 'terminal-input', 'w-full rounded-none', className)}
    />
  );
});
