'use client';

import { Checkbox } from '@base-ui/react/checkbox';

import { classNames } from './classNames.js';

export interface TerminalCheckboxProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly indeterminate?: boolean;
}

export function TerminalCheckbox({
  checked,
  onCheckedChange,
  label,
  className,
  disabled = false,
  indeterminate = false,
}: TerminalCheckboxProps) {
  /*
   * Chrome (border, background, color, font) and the `[data-checked]`/
   * `[data-indeterminate]`/`:focus-visible` state overrides stay in
   * primitives.css: the state selectors carry two classes' worth of
   * specificity (the class plus the attribute or pseudo-class), which already
   * outranks `.ops-shell button`'s single class today, and moving them to a
   * lower-priority utility layer would not change that -- but the base
   * (unchecked, unfocused) chrome is exactly what `.ops-shell button` already
   * overrides at equal-or-higher specificity, so it stays for consistency
   * with the states next to it rather than because it still wins. Shape,
   * size and the disabled dimming, which nothing contests, move here.
   */
  return (
    <Checkbox.Root
      nativeButton
      render={<button type="button" />}
      checked={checked}
      disabled={disabled}
      indeterminate={indeterminate}
      aria-label={label}
      className={classNames(
        'terminal-checkbox',
        'inline-grid place-items-center size-6 cursor-pointer data-[disabled]:cursor-not-allowed data-[disabled]:opacity-[0.38]',
        className,
      )}
      onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
    >
      <Checkbox.Indicator className="terminal-checkbox__indicator">
        {indeterminate ? '[−]' : '[×]'}
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}
