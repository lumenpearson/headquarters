'use client';

import type { SettingCategory, SettingDefinition, SettingValue } from '@gremuchaya/settings-schema';
import {
  TerminalInput,
  TerminalNumberField,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';
import { useEffect, type ReactNode } from 'react';

import { t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import type { SettingGroup } from '@/application/personalization/catalog';

import { CurveSetting } from './CurveSetting';
import { useMaterialCatalog } from './MaterialCatalog';
import { materialOptionsFor, unsetMaterialOption } from './MaterialOptions';

/**
 * Shared between `SettingsScreen` and the edit-mode floating panel, which both
 * need to render one setting from its declared `editor` without duplicating
 * the switch over editor kinds. Extracted from `SettingsScreen`, which was the
 * only consumer before edit mode needed the same rendering.
 */
export function SchemaSetting({
  definition,
  value,
  changed,
  onValueChange,
}: {
  readonly definition: SettingDefinition;
  readonly value: SettingValue;
  readonly changed: boolean;
  readonly onValueChange: (value: SettingValue) => void;
}) {
  const label = settingLabel(definition.id);
  const editor = definition.editor;

  // Called unconditionally, as a hook must be, but the catalogue only loads
  // when a picker over it is actually on screen.
  const catalog = useMaterialCatalog();
  const needsMaterials = editor.kind === 'material';
  const requestMaterials = catalog.request;
  useEffect(() => {
    if (needsMaterials) requestMaterials();
  }, [needsMaterials, requestMaterials]);

  const control = (() => {
    switch (editor.kind) {
      case 'boolean':
        return (
          <TerminalSwitch
            label={label}
            className="settings-toggle"
            checked={value === true}
            onCheckedChange={onValueChange}
          />
        );
      case 'enum':
        return (
          <TerminalSelect
            label={label}
            value={String(value)}
            onValueChange={(nextValue) =>
              onValueChange(
                typeof definition.defaultValue === 'number' ? Number(nextValue) : nextValue,
              )
            }
            options={editor.options.map((option) => ({
              value: option,
              label: option.toUpperCase(),
            }))}
          />
        );
      case 'number':
        return (
          <TerminalNumberField
            label={label}
            value={typeof value === 'number' ? value : null}
            min={editor.minimum}
            max={editor.maximum}
            step={editor.step}
            onValueChange={(nextValue) => {
              if (nextValue !== null) onValueChange(nextValue);
            }}
          />
        );
      case 'material': {
        const chosen = typeof value === 'string' ? value : '';
        const options = materialOptionsFor(catalog.materials, editor.accept, chosen);
        return (
          <TerminalSelect
            label={label}
            value={chosen === '' ? unsetMaterialOption : chosen}
            onValueChange={(nextValue) =>
              onValueChange(nextValue === unsetMaterialOption ? '' : nextValue)
            }
            options={options}
          />
        );
      }
      case 'curve':
        return (
          <CurveSetting editor={editor} label={label} value={value} onValueChange={onValueChange} />
        );
      case 'string-list':
        return (
          <TerminalInput
            aria-label={label}
            value={Array.isArray(value) ? value.join(`${editor.delimiter} `) : ''}
            onValueChange={(nextValue) =>
              onValueChange(
                [...new Set(nextValue.split(editor.delimiter).map((item) => item.trim()))].filter(
                  Boolean,
                ),
              )
            }
          />
        );
    }
  })();

  return (
    <Setting
      label={`${label}${changed ? ' *' : ''}`}
      detail={`${definition.scope.toUpperCase()} · ${definition.description}`}
    >
      {control}
    </Setting>
  );
}

export function Setting({
  label,
  detail,
  children,
}: {
  readonly label: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      {children}
    </div>
  );
}

export function settingLabel(id: string): string {
  return id
    .replaceAll('.', ' / ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase();
}

/**
 * The name of a section, in the words an operator would use to look for it.
 *
 * Grouping is what makes seventy-one definitions navigable, and it only works
 * if the group names describe what someone is trying to change rather than the
 * layer that implements it. It sits here beside `categoryLabel` rather than in
 * the settings screen because the edit panel navigates the same sections, and
 * two copies of these names would drift the moment one section was renamed.
 *
 * Both tables read `ВНЕШНИЙ ВИД / APPEARANCE` -- the name and its own
 * translation in one string -- because before F11 there was nowhere else to
 * put the second half. There is now, so each half stands alone and a session
 * in either language reads one heading rather than two.
 *
 * Both resolve the locale at the moment of the call. The two surfaces that
 * draw them, `SettingsScreen` and `EditPanel`, take the subscription with
 * `useAppLocale`; that is what re-renders these headings when the locale moves.
 */
const groupMessages: Readonly<Record<SettingGroup, MessageId>> = {
  appearance: 'settingsGroup.appearance',
  layout: 'settingsGroup.layout',
  motion: 'settingsGroup.motion',
  information: 'settingsGroup.information',
  media: 'settingsGroup.media',
  session: 'settingsGroup.session',
  system: 'settingsGroup.system',
};

export function groupLabel(group: SettingGroup): string {
  return t(groupMessages[group]);
}

const categoryMessages: Readonly<Record<SettingCategory, MessageId>> = {
  general: 'settingsCategory.general',
  information: 'settingsCategory.information',
  layout: 'settingsCategory.layout',
  tiles: 'settingsCategory.tiles',
  themes: 'settingsCategory.themes',
  styles: 'settingsCategory.styles',
  colors: 'settingsCategory.colors',
  typography: 'settingsCategory.typography',
  sizes: 'settingsCategory.sizes',
  backgrounds: 'settingsCategory.backgrounds',
  patterns: 'settingsCategory.patterns',
  animations: 'settingsCategory.animations',
  startup: 'settingsCategory.startup',
  player: 'settingsCategory.player',
  cameras: 'settingsCategory.cameras',
  map: 'settingsCategory.map',
  tables: 'settingsCategory.tables',
  popups: 'settingsCategory.popups',
  keybinds: 'settingsCategory.keybinds',
  localization: 'settingsCategory.localization',
  dateTime: 'settingsCategory.dateTime',
  telemetry: 'settingsCategory.telemetry',
  simulation: 'settingsCategory.simulation',
  groups: 'settingsCategory.groups',
  materials: 'settingsCategory.materials',
  titlebar: 'settingsCategory.titlebar',
  accessibility: 'settingsCategory.accessibility',
  performance: 'settingsCategory.performance',
  privacy: 'settingsCategory.privacy',
  diagnostics: 'settingsCategory.diagnostics',
  github: 'settingsCategory.github',
  advanced: 'settingsCategory.advanced',
};

export function categoryLabel(category: SettingCategory): string {
  return t(categoryMessages[category]);
}
