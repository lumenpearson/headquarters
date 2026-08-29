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

  /*
   * `Progress.Root` and its parts render as plain `<div>`s, which no app
   * stylesheet's element reset or `.ops-shell`/`body.terminal-theme` rule
   * reaches, so the whole component migrates. The tone-to-indicator-colour
   * link reads `data-tone` off an ancestor rather than the indicator itself,
   * so it moves to a `group`/`group-data-*` pair rather than a plain
   * `data-*` variant on the indicator.
   */
  return (
    <Progress.Root
      value={value}
      min={min}
      max={max}
      locale="en-US"
      className={classNames(
        'terminal-progress',
        'group grid gap-hq-1 text-hq-text-1 [font-family:var(--font-mono)] text-hq-xs',
        className,
      )}
      data-tone={tone}
    >
      <div className="terminal-progress__header flex justify-between gap-hq-2 uppercase">
        <Progress.Label>{label}</Progress.Label>
        {showValue ? (
          <Progress.Value>{(formattedValue) => formattedValue ?? '…'}</Progress.Value>
        ) : null}
      </div>
      <Progress.Track className="terminal-progress__track h-[5px] overflow-hidden bg-hq-line-2">
        <Progress.Indicator
          className="terminal-progress__indicator w-[var(--terminal-progress)] h-full bg-hq-accent transition-[width] duration-hq-standard [transition-timing-function:ease] group-data-[tone=success]:bg-hq-ok group-data-[tone=warning]:bg-hq-warning group-data-[tone=critical]:bg-hq-critical"
          style={style}
        />
      </Progress.Track>
    </Progress.Root>
  );
}
