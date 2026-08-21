'use client';

import { Slider } from '@base-ui/react/slider';
import { useState } from 'react';

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
  /*
   * R23 asks for a cursor of its own while a field is being changed, and this
   * component has to publish that state itself.
   *
   * Base UI 1.7.0 declares a `data-dragging` attribute for the slider but does
   * not render it -- measured on every element of the tree through a real drag
   * that moved the value, and it never appears; nor does `:active` match,
   * because the control takes pointer capture. The stylesheet already carried
   * a `[data-dragging]` rule that had therefore never fired once.
   *
   * `onValueChange` / `onValueCommitted` are the library's own pair for
   * "changing" and "settled", which is exactly the distinction the requirement
   * draws, and they do not depend on which element the pointer landed on.
   */
  const [adjusting, setAdjusting] = useState(false);

  return (
    <Slider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={classNames('terminal-slider', className)}
      data-adjusting={adjusting ? '' : undefined}
      onValueChange={(nextValue) => {
        setAdjusting(true);
        onValueChange(nextValue);
      }}
      onValueCommitted={() => setAdjusting(false)}
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
