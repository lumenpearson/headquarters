'use client';

import type { SettingGroup } from '@/application/personalization/catalog';
import { settingGroups } from '@/application/personalization/catalog';
import { Panel } from '@/components/operations/OpsUi';

import { groupLabel } from './SchemaSetting';
import { SettingsCardIcon, type SettingsCardIconKind } from './settingsCardIcons';

/**
 * The screen's sections, in the order both the unified column and the card
 * grid draw them. `className` doubles as the scroll anchor the unified
 * layout's `IntersectionObserver` targets (`SettingsScreen.tsx`), so this
 * array stays the one ordering authority for both presentations rather than
 * two lists that could drift apart. `personalization` renders as an ordinary
 * section here -- unified mode draws it inline, exactly as it always has --
 * and only the card grid ({@link settingsCardTargets}) treats it specially,
 * replacing it with one card per `settingGroups` entry.
 */
export const settingsSections = [
  { id: 'interface', className: 'settings-interface', label: 'ИНТЕРФЕЙС', icon: 'interface' },
  { id: 'simulation', className: 'settings-simulation', label: 'СИМУЛЯЦИЯ', icon: 'simulation' },
  { id: 'workspace', className: 'settings-monitor', label: 'РАБОЧЕЕ МЕСТО', icon: 'workspace' },
  { id: 'group', className: 'settings-group', label: 'СИНХРОНИЗАЦИЯ ГРУППЫ', icon: 'group' },
  { id: 'data', className: 'settings-data', label: 'ЛОКАЛЬНЫЕ ДАННЫЕ', icon: 'data' },
  {
    id: 'personalization',
    className: 'settings-personalization',
    label: 'ПЕРСОНАЛИЗАЦИЯ',
    icon: 'appearance',
  },
  { id: 'keybinds', className: 'settings-keybinds', label: 'СОЧЕТАНИЯ КЛАВИШ', icon: 'keybinds' },
  { id: 'history', className: 'settings-history', label: 'ИСТОРИЯ НАСТРОЕК', icon: 'history' },
  { id: 'keymap', className: 'settings-keymap', label: 'ГОРЯЧИЕ КЛАВИШИ', icon: 'keymap' },
  {
    id: 'update',
    className: 'settings-update',
    label: 'ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ',
    icon: 'update',
  },
] as const satisfies readonly {
  readonly id: string;
  readonly className: string;
  readonly label: string;
  readonly icon: SettingsCardIconKind;
}[];

export type SettingsSectionId = (typeof settingsSections)[number]['id'];

const groupIcon: Readonly<Record<SettingGroup, SettingsCardIconKind>> = {
  appearance: 'appearance',
  layout: 'layout',
  motion: 'motion',
  information: 'information',
  media: 'media',
  session: 'session',
  system: 'system',
};

/**
 * What opening one card means: either one of the sections above, or one of
 * the seven personalization groups, which all open the same catalogue panel
 * pre-filtered to that group rather than each carrying a panel of its own.
 */
export type SettingsCardTarget =
  | { readonly kind: 'section'; readonly id: SettingsSectionId }
  | { readonly kind: 'group'; readonly group: SettingGroup };

interface SettingsCard {
  readonly target: SettingsCardTarget;
  readonly label: string;
  readonly icon: SettingsCardIconKind;
}

/**
 * The card roster: `settingsSections` with `personalization` replaced in
 * place by the seven `settingGroups` cards, so the grid reads in the same
 * order an operator would find the same content in the unified list.
 */
export function settingsCardTargets(): readonly SettingsCard[] {
  const cards: SettingsCard[] = [];
  for (const section of settingsSections) {
    if (section.id === 'personalization') {
      for (const group of settingGroups) {
        cards.push({
          target: { kind: 'group', group },
          label: groupLabel(group),
          icon: groupIcon[group],
        });
      }
      continue;
    }
    cards.push({
      target: { kind: 'section', id: section.id },
      label: section.label,
      icon: section.icon,
    });
  }
  return cards;
}

export function SettingsCardGrid({
  onOpen,
}: {
  readonly onOpen: (target: SettingsCardTarget) => void;
}) {
  return (
    <div className="settings-card-grid">
      {settingsCardTargets().map((card) => (
        <Panel
          key={cardKey(card.target)}
          title={card.label}
          className="settings-card"
          onClick={() => onOpen(card.target)}
        >
          <span className="settings-card__icon">
            <SettingsCardIcon kind={card.icon} />
          </span>
        </Panel>
      ))}
    </div>
  );
}

function cardKey(target: SettingsCardTarget): string {
  return target.kind === 'group' ? `group:${target.group}` : `section:${target.id}`;
}
