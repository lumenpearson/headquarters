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
      <NumberField.Group className="terminal-number-field__group">
        <NumberField.Decrement
          aria-label={`Уменьшить: ${label}`}
          className="terminal-number-field__step"
        >
          [−]
        </NumberField.Decrement>
        <NumberField.Input aria-label={label} className="terminal-number-field__input" />
        <NumberField.Increment
          aria-label={`Увеличить: ${label}`}
          className="terminal-number-field__step"
        >
          [+]
        </NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  );
}
