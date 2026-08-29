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
  /**
   * Whether the label is drawn above the track. Off where the caller already
   * renders the name beside the control -- a settings row, for one -- so the
   * same text is not on screen twice; the thumb keeps the accessible name
   * either way.
   */
  readonly showLabel?: boolean;
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
  showLabel = true,
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
      className={classNames(
        'terminal-slider',
        'group grid min-w-0 gap-hq-2 text-hq-text-1 font-mono text-hq-xs',
        className,
      )}
      data-adjusting={adjusting ? '' : undefined}
      onValueChange={(nextValue) => {
        setAdjusting(true);
        onValueChange(nextValue);
      }}
      onValueCommitted={() => setAdjusting(false)}
    >
      {showLabel || showValue ? (
        <div className="terminal-slider__header flex justify-between gap-hq-2 uppercase">
          {showLabel ? <Slider.Label>{label}</Slider.Label> : null}
          {showValue ? <Slider.Value>{() => value}</Slider.Value> : null}
        </div>
      ) : null}
      <Slider.Control className="terminal-slider__control flex h-6 items-center cursor-pointer group-data-[adjusting]:cursor-grabbing">
        <Slider.Track className="terminal-slider__track relative w-full h-[5px] bg-hq-line-2">
          <Slider.Indicator className="terminal-slider__indicator h-full bg-hq-accent" />
          <Slider.Thumb
            className="terminal-slider__thumb w-[10px] h-[18px] border border-hq-accent outline-none bg-hq-bg-0 focus-within:bg-hq-accent group-data-[adjusting]:bg-hq-accent"
            getAriaLabel={() => label}
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
