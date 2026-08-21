'use client';

import { Menu } from '@base-ui/react/menu';
import type { ReactElement } from 'react';

import { classNames } from './classNames.js';
import type { TerminalPopupSide } from './TerminalTooltip.js';

export interface TerminalMenuItem {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly tone?: 'neutral' | 'primary' | 'critical';
  readonly onSelect: () => void;
}

export interface TerminalMenuProps {
  readonly trigger: ReactElement;
  readonly items: ReadonlyArray<TerminalMenuItem>;
  readonly label: string;
  readonly side?: TerminalPopupSide;
  readonly align?: 'start' | 'center' | 'end';
  readonly className?: string;
}

export function TerminalMenu({
  trigger,
  items,
  label,
  side = 'bottom',
  align = 'start',
  className,
}: TerminalMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner
          side={side}
          align={align}
          sideOffset={4}
          className="terminal-menu__positioner"
        >
          <Menu.Popup aria-label={label} className={classNames('terminal-menu', className)}>
            {items.map((item) => (
              <Menu.Item
                key={item.id}
                disabled={item.disabled}
                className="terminal-menu__item"
                data-tone={item.tone ?? 'neutral'}
                onClick={item.onSelect}
              >
                <span>{item.label}</span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
