'use client';

import { NumberField } from '@base-ui/react/number-field';

import { classNames } from './classNames.js';

export interface TerminalNumberFieldProps {
  readonly value: number | null;
  readonly onValueChange: (value: number | null) => void;
  readonly label: string;
  readonly className?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly disabled?: boolean;
  readonly format?: Intl.NumberFormatOptions;
}

export function TerminalNumberField({
  value,
  onValueChange,
  label,
  className,
  min,
  max,
  step = 1,
  disabled = false,
  format,
}: TerminalNumberFieldProps) {
  /*
   * `.terminal-number-field__group` is a plain `<div>` -- no app stylesheet
   * reaches it -- and migrates in full, focus-within border included. `__input`
   * and `__step` render as a real `<input>`/`<button>` pair: their chrome
   * (border, background, color, font) stays in primitives.css for the same
   * reason as TerminalInput's and TerminalButton's; the divider borders on
   * `:first-child`/`:last-child` also stay, since that pseudo-class gives them
   * two classes' worth of specificity, already ahead of `.ops-shell button`'s
   * one. Sizing, alignment and the step buttons' cursor, none of it contested,
   * moves here.
   */
  return (
    <NumberField.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      format={format}
      className={classNames('terminal-number-field', className)}
      onValueChange={(nextValue) => onValueChange(nextValue)}
    >
      <NumberField.Group className="terminal-number-field__group grid min-w-0 grid-cols-[30px_minmax(0,1fr)_30px] border border-hq-line-1 bg-hq-bg-0 focus-within:border-hq-line-focus">
        <NumberField.Decrement
          aria-label={`Уменьшить: ${label}`}
          className="terminal-number-field__step min-w-0 min-h-[32px] cursor-pointer"
        >
          [−]
        </NumberField.Decrement>
        <NumberField.Input
          aria-label={label}
          className="terminal-number-field__input min-w-0 min-h-[32px] w-full text-center"
        />
        <NumberField.Increment
          aria-label={`Увеличить: ${label}`}
          className="terminal-number-field__step min-w-0 min-h-[32px] cursor-pointer"
        >
          [+]
        </NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  );
}
