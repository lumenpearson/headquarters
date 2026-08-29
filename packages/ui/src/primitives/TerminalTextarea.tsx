'use client';

import { forwardRef } from 'react';
import type { ChangeEvent, TextareaHTMLAttributes } from 'react';

import { classNames } from './classNames.js';

export interface TerminalTextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'className' | 'onChange'
> {
  readonly className?: string;
  /** Mirrors Base UI's `Input.onValueChange`, so the two text controls read alike. */
  readonly onValueChange?: (value: string, event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}

/**
 * Base UI has no textarea component: its `Input` renders an `<input>` and
 * nothing else. This is the one place a raw `<textarea>` is allowed, so the
 * multiline control is wrapped here and consumed as a `Terminal*` export like
 * every other interactive element.
 */
export const TerminalTextarea = forwardRef<HTMLTextAreaElement, TerminalTextareaProps>(
  function TerminalTextarea({ className, onValueChange, onChange, ...properties }, reference) {
    return (
      <textarea
        {...properties}
        ref={reference}
        /*
         * Chrome (border, background, color, font) stays in primitives.css:
         * `.ops-shell textarea` and `body.terminal-theme textarea` reach the
         * bare `<textarea>` element at equal-or-higher specificity, `font:
         * inherit` on the former already wins over this class's own
         * `line-height`. Sizing and behaviour that nothing contests move here.
         */
        className={classNames(
          'hq-input',
          'terminal-input',
          'terminal-textarea',
          'min-h-[72px] py-hq-2 px-hq-3 resize-y leading-[1.4]',
          className,
        )}
        onChange={(event) => {
          onChange?.(event);
          onValueChange?.(event.target.value, event);
        }}
      />
    );
  },
);
