'use client';

import { Menu } from '@base-ui/react/menu';
import type { ReactElement } from 'react';

import { classNames } from './classNames.js';
import type { TerminalPopupSide } from './TerminalTooltip.js';
import {
  TERMINAL_MENU_BASE_UTILITY,
  TERMINAL_MENU_ITEM_KBD_UTILITY,
  TERMINAL_MENU_ITEM_UTILITY,
  TERMINAL_POPUP_POSITIONER_UTILITY,
} from './terminalOverlayStyles.js';

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
          className={classNames('terminal-menu__positioner', TERMINAL_POPUP_POSITIONER_UTILITY)}
        >
          <Menu.Popup
            aria-label={label}
            className={classNames('terminal-menu', TERMINAL_MENU_BASE_UTILITY, className)}
          >
            {items.map((item) => (
              <Menu.Item
                key={item.id}
                disabled={item.disabled}
                className={classNames('terminal-menu__item', TERMINAL_MENU_ITEM_UTILITY)}
                data-tone={item.tone ?? 'neutral'}
                onClick={item.onSelect}
              >
                <span>{item.label}</span>
                {item.shortcut ? (
                  <kbd className={TERMINAL_MENU_ITEM_KBD_UTILITY}>{item.shortcut}</kbd>
                ) : null}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
