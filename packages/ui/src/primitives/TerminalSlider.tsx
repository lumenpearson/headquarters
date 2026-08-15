'use client';

import { Slider } from '@base-ui/react/slider';

import { classNames } from './classNames.js';

export interface TerminalSliderProps {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly label: string;
  readonly className?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly disabled?: boolean;
  readonly showValue?: boolean;
}

export function TerminalSlider({
  value,
  onValueChange,
  label,
  className,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  showValue = true,
}: TerminalSliderProps) {
  return (
    <Slider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={classNames('terminal-slider', className)}
      onValueChange={(nextValue) => onValueChange(nextValue)}
    >
      <div className="terminal-slider__header">
        <Slider.Label>{label}</Slider.Label>
        {showValue ? <Slider.Value>{() => value}</Slider.Value> : null}
      </div>
      <Slider.Control className="terminal-slider__control">
        <Slider.Track className="terminal-slider__track">
          <Slider.Indicator className="terminal-slider__indicator" />
          <Slider.Thumb className="terminal-slider__thumb" getAriaLabel={() => label} />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
