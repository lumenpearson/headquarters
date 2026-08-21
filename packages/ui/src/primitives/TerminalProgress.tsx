'use client';

import { Progress } from '@base-ui/react/progress';
import type { CSSProperties } from 'react';

import { classNames } from './classNames.js';

export interface TerminalProgressProps {
  readonly value: number | null;
  readonly label: string;
  readonly className?: string;
  readonly min?: number;
  readonly max?: number;
  readonly tone?: 'neutral' | 'success' | 'warning' | 'critical';
  readonly showValue?: boolean;
}

export function TerminalProgress({
  value,
  label,
  className,
  min = 0,
  max = 100,
  tone = 'neutral',
  showValue = true,
}: TerminalProgressProps) {
  const normalizedValue =
    value === null ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const style = { '--terminal-progress': `${normalizedValue * 100}%` } as CSSProperties;

  return (
    <Progress.Root
      value={value}
      min={min}
      max={max}
      locale="en-US"
      className={classNames('terminal-progress', className)}
      data-tone={tone}
    >
      <div className="terminal-progress__header">
        <Progress.Label>{label}</Progress.Label>
        {showValue ? (
          <Progress.Value>{(formattedValue) => formattedValue ?? '…'}</Progress.Value>
        ) : null}
      </div>
      <Progress.Track className="terminal-progress__track">
        <Progress.Indicator className="terminal-progress__indicator" style={style} />
      </Progress.Track>
    </Progress.Root>
  );
}
