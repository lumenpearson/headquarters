'use client';

import { useEffect, useRef } from 'react';

import type { SettingGroup } from '@/application/personalization/catalog';
import { settingGroups } from '@/application/personalization/catalog';
import { useAppLocale, t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
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
 *
 * `labelId` rather than a resolved `label`: `SettingsSectionId` is derived from
 * this very array, so every member already carries one by construction, and
 * resolving through `t()` here rather than at each reader keeps a locale
 * change from requiring a second table.
 */
export const settingsSections = [
  {
    id: 'interface',
    className: 'settings-interface',
    labelId: 'settingsSection.interface',
    icon: 'interface',
  },
  {
    id: 'simulation',
    className: 'settings-simulation',
    labelId: 'settingsSection.simulation',
    icon: 'simulation',
  },
  {
    id: 'workspace',
    className: 'settings-monitor',
    labelId: 'settingsSection.workspace',
    icon: 'workspace',
  },
  {
    id: 'group',
    className: 'settings-group',
    labelId: 'settingsSection.group',
    icon: 'group',
  },
  {
    id: 'data',
    className: 'settings-data',
    labelId: 'settingsSection.data',
    icon: 'data',
  },
  {
    id: 'personalization',
    className: 'settings-personalization',
    labelId: 'settingsSection.personalization',
    icon: 'appearance',
  },
  {
    id: 'keybinds',
    className: 'settings-keybinds',
    labelId: 'settingsSection.keybinds',
    icon: 'keybinds',
  },
  {
    id: 'history',
    className: 'settings-history',
    labelId: 'settingsSection.history',
    icon: 'history',
  },
  {
    id: 'keymap',
    className: 'settings-keymap',
    labelId: 'settingsSection.keymap',
    icon: 'keymap',
  },
  {
    id: 'update',
    className: 'settings-update',
    labelId: 'settingsSection.update',
    icon: 'update',
  },
] as const satisfies readonly {
  readonly id: string;
  readonly className: string;
  readonly labelId: MessageId;
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
      label: t(section.labelId),
      icon: section.icon,
    });
  }
  return cards;
}

export function SettingsCardGrid({
  onOpen,
  focusTarget = null,
  onFocused,
}: {
  readonly onOpen: (target: SettingsCardTarget) => void;
  /**
   * The card to hand keyboard focus back to as soon as the grid mounts, or
   * `null` for none -- the caller sets it to whichever card the operator
   * just closed. Without this, closing a card drops focus to `<body>`: the
   * button that had it leaves the DOM the instant the grid replaces the
   * open section (item 6, H3 review). Read once, at mount, through a ref
   * rather than a `focusTarget` dependency -- the grid itself remounts
   * fresh every time it reappears, so "at mount" already means "when this
   * card should regain focus."
   */
  readonly focusTarget?: SettingsCardTarget | null;
  /**
   * Fires once, right after `focusTarget` has been consumed (whether or not
   * a matching card was found to focus). Lets the caller clear its own
   * `focusTarget` state so an unrelated remount of this grid -- toggling
   * `layout.settingsLanding` back to `cards` with no card having closed in
   * between -- does not replay the same focus jump.
   */
  readonly onFocused?: () => void;
}) {
  // `settingsCardTargets` resolves every label through `t()` at call time,
  // not through a hook, so nothing here re-renders on a locale change without
  // this subscription -- unlike `SettingsScreen`, which selects the whole
  // store and re-renders on any change, a caller that mounts this grid on
  // its own would otherwise leave it in whichever language was in force at
  // mount.
  useAppLocale();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const initialFocusTarget = useRef(focusTarget);
  const onFocusedRef = useRef(onFocused);
  useEffect(() => {
    onFocusedRef.current = onFocused;
  });
  useEffect(() => {
    const target = initialFocusTarget.current;
    if (target !== null) {
      const card = settingsCardTargets().find((candidate) => sameTarget(candidate.target, target));
      if (card !== undefined) {
        gridRef.current?.querySelector<HTMLElement>(`[data-panel="${card.label}"]`)?.focus();
      }
    }
    onFocusedRef.current?.();
    // Mount-only: `initialFocusTarget`/`onFocusedRef` are refs, and
    // `settingsCardTargets`/`sameTarget` are module-level functions, so
    // nothing reactive is missing from this dependency list.
  }, []);

  return (
    <div className="settings-card-grid" ref={gridRef}>
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

function sameTarget(a: SettingsCardTarget, b: SettingsCardTarget): boolean {
  return a.kind === 'group' && b.kind === 'group'
    ? a.group === b.group
    : a.kind === 'section' && b.kind === 'section'
      ? a.id === b.id
      : false;
}
