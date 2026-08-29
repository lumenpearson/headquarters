'use client';

import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';

import { classNames } from './classNames.js';

export interface TerminalColorPickerOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Any valid CSS color -- the swatch's own background, not a token name. */
  readonly swatch: string;
  readonly disabled?: boolean;
}

export interface TerminalColorPickerProps<Value extends string> {
  readonly value: Value;
  readonly options: ReadonlyArray<TerminalColorPickerOption<Value>>;
  readonly onValueChange: (value: Value) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

/**
 * A grid of color swatches over Base UI's radio group, the same way
 * `TerminalRadioGroup` renders a grid of dots -- one value selected out of a
 * fixed set, never a free color the operator types in. `colors.accent`
 * declares itself "never arbitrary CSS" (`packages/settings-schema`) for a
 * reason this picker keeps: the swatches are `options`, not a canvas, so a
 * consumer can only ever hand back one of the values it was given.
 */
export function TerminalColorPicker<Value extends string>({
  value,
  options,
  onValueChange,
  label,
  className,
  disabled = false,
}: TerminalColorPickerProps<Value>) {
  return (
    <RadioGroup
      value={value}
      disabled={disabled}
      aria-label={label}
      className={classNames('terminal-color-picker', 'flex min-w-0 flex-wrap gap-hq-2', className)}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          nativeButton
          render={<button type="button" />}
          value={option.value}
          disabled={option.disabled}
          aria-label={option.label}
          title={option.label}
          className="terminal-color-swatch grid size-7 shrink-0 place-items-center border border-hq-line-2 outline-none"
          style={{ background: option.swatch }}
        >
          <Radio.Indicator className="terminal-color-swatch__indicator">×</Radio.Indicator>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
