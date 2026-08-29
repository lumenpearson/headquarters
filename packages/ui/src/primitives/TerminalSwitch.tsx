'use client';

import { Switch } from '@base-ui/react/switch';

import { classNames } from './classNames.js';

export interface TerminalSwitchProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onLabel?: string;
  readonly offLabel?: string;
}

export function TerminalSwitch({
  checked,
  onCheckedChange,
  label,
  className,
  disabled = false,
  onLabel = '[ON]',
  offLabel = '[OFF]',
}: TerminalSwitchProps) {
  /*
   * Chrome (border, background, color, font) and the `[data-checked]`/
   * `:focus-visible` state overrides stay in primitives.css for the same
   * reason as TerminalCheckbox's. Layout, spacing, the disabled dimming and
   * the thumb dot -- nothing here is contested by `[data-control-sizing]`,
   * which never names `.terminal-switch` -- move to utilities.
   */
  return (
    <Switch.Root
      nativeButton
      render={<button type="button" />}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      className={classNames(
        'terminal-switch',
        'inline-flex min-h-[27px] items-center justify-between gap-hq-2 px-hq-2 uppercase cursor-pointer data-[disabled]:cursor-not-allowed data-[disabled]:opacity-[0.38]',
        checked && 'is-active',
        className,
      )}
      onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
    >
      <span className="terminal-switch__label">{checked ? onLabel : offLabel}</span>
      <Switch.Thumb className="terminal-switch__thumb size-[7px] bg-current" />
    </Switch.Root>
  );
}
