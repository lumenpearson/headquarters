'use client';

import type { SettingCategory, SettingDefinition, SettingValue } from '@gremuchaya/settings-schema';
import {
  TerminalInput,
  TerminalNumberField,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';
import { useEffect, type ReactNode } from 'react';

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
 */
export function groupLabel(group: SettingGroup): string {
  return (
    {
      appearance: 'ВНЕШНИЙ ВИД / APPEARANCE',
      layout: 'МАКЕТ И РАЗМЕРЫ / LAYOUT',
      motion: 'ДВИЖЕНИЕ И ДОСТУПНОСТЬ / MOTION',
      information: 'ИНФОРМАЦИЯ / INFORMATION',
      media: 'МЕДИА И КАРТА / MEDIA',
      session: 'СЕССИЯ И УПРАВЛЕНИЕ / SESSION',
      system: 'СИСТЕМА / SYSTEM',
    } satisfies Record<SettingGroup, string>
  )[group];
}

export function categoryLabel(category: SettingCategory): string {
  return (
    {
      general: 'ОБЩИЕ / GENERAL',
      information: 'ИНФОРМАЦИЯ / INFORMATION',
      layout: 'МАКЕТ / LAYOUT',
      tiles: 'ПЛИТКИ / TILES',
      themes: 'ТЕМЫ / THEMES',
      styles: 'СТИЛИ / STYLES',
      colors: 'ЦВЕТА / COLORS',
      typography: 'ТИПОГРАФИКА / TYPOGRAPHY',
      sizes: 'РАЗМЕРЫ / SIZES',
      backgrounds: 'ФОНЫ / BACKGROUNDS',
      patterns: 'ПАТТЕРНЫ / PATTERNS',
      animations: 'АНИМАЦИИ / ANIMATIONS',
      startup: 'ЗАПУСК / STARTUP',
      player: 'ПЛЕЕР / PLAYER',
      cameras: 'КАМЕРЫ / CAMERAS',
      map: 'КАРТА / MAP',
      tables: 'ТАБЛИЦЫ / TABLES',
      popups: 'POP-UP / POPUPS',
      keybinds: 'КЛАВИШИ / KEYBINDS',
      localization: 'ЛОКАЛИЗАЦИЯ / LOCALIZATION',
      dateTime: 'ДАТА И ВРЕМЯ / DATE TIME',
      telemetry: 'ТЕЛЕМЕТРИЯ / TELEMETRY',
      simulation: 'СИМУЛЯЦИЯ / SIMULATION',
      groups: 'ГРУППЫ / GROUPS',
      materials: 'МАТЕРИАЛЫ / MATERIALS',
      titlebar: 'ВЕРХНЯЯ ПАНЕЛЬ / TITLEBAR',
      accessibility: 'ДОСТУПНОСТЬ / ACCESSIBILITY',
      performance: 'ПРОИЗВОДИТЕЛЬНОСТЬ / PERFORMANCE',
      privacy: 'ПРИВАТНОСТЬ / PRIVACY',
      diagnostics: 'ДИАГНОСТИКА / DIAGNOSTICS',
      github: 'GITHUB / ИНТЕГРАЦИЯ',
      advanced: 'РАСШИРЕННЫЕ / ADVANCED',
    } satisfies Record<SettingCategory, string>
  )[category];
}
