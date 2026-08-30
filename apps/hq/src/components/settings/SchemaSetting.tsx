'use client';

import {
  statuslineElements,
  titlebarElements,
  type SettingCategory,
  type SettingDefinition,
  type SettingValue,
} from '@gremuchaya/settings-schema';
import {
  TerminalColorPicker,
  TerminalElementsConstructor,
  TerminalIcon,
  TerminalInput,
  TerminalNumberField,
  TerminalSelect,
  TerminalSlider,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';
import { useEffect, type ReactNode } from 'react';

import { t, useAppLocale } from '@/application/localization/locale';
import type { AppLocale, MessageId } from '@/application/localization/messages';
import {
  localizedEnumOptionLabel,
  localizedSettingDescription,
} from '@/application/localization/settingLocalization';
import { statuslineElementLabel } from '@/application/localization/statuslineLabels';
import { titlebarElementLabel } from '@/application/localization/titlebarLabels';
import type { SettingGroup } from '@/application/personalization/catalog';
import { settingsAwaitingTheirFeature } from '@/application/personalization/presentation';

import { CurveSetting } from './CurveSetting';
import { useMaterialCatalog } from './MaterialCatalog';
import { materialOptionsFor, unsetMaterialOption } from './MaterialOptions';

/**
 * What each `colors.accent` member actually looks like, for the picker below.
 *
 * Taken from `operations.css`'s own `body[data-accent='…']` overrides rather
 * than invented: every regular theme (every theme but the two high-contrast
 * ones, which replace the accent outright) repaints `--ops-orange` to exactly
 * these five values. `orange` itself has no such override -- it is the
 * unmarked default -- so it takes the accent token every theme is built
 * against instead (`packages/ui/src/styles/tokens.css`).
 */
const accentSwatches: Readonly<Record<string, string>> = {
  orange: '#ff3d00',
  green: '#53b979',
  amber: '#d8a547',
  cyan: '#45b9c6',
  red: '#dc5c57',
};

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
  // Subscribed rather than read once: a description or enum option translated
  // by `settingLocalization.ts` must follow `localization.locale` the way
  // every other row on this screen already does.
  const locale = useAppLocale();

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
        // `colors.accent` is a picker over five fixed swatches, never
        // arbitrary CSS (the definition says so), so it draws the color the
        // operator is actually choosing rather than the token's own name --
        // every other enum still reads as a dropdown of its options.
        if (definition.id === 'colors.accent') {
          return (
            <TerminalColorPicker
              label={label}
              value={String(value)}
              onValueChange={onValueChange}
              options={editor.options.map((option) => ({
                value: option,
                label: option.toUpperCase(),
                swatch: accentSwatches[option] ?? option,
              }))}
            />
          );
        }
        // `styles.iconSet`: the operator has no reason to recognise a
        // library's name, only what it draws, so this row gets a preview
        // strip beside the dropdown -- each option's own close/system/menu
        // marks, read from that option's adapter regardless of which one is
        // currently active.
        if (definition.id === 'styles.iconSet') {
          return (
            <span className="settings-iconset-setting">
              <TerminalSelect
                label={label}
                value={String(value)}
                onValueChange={onValueChange}
                options={editor.options.map((option) => ({
                  value: option,
                  label: localizedEnumOptionLabel(definition, option, locale),
                }))}
              />
              <span className="settings-iconset-preview" aria-hidden="true">
                {editor.options.map((option) => (
                  <span
                    key={option}
                    className="settings-iconset-preview__option"
                    data-selected={option === String(value)}
                  >
                    <TerminalIcon name="close" iconSet={option} size={16} />
                    <TerminalIcon name="system" iconSet={option} size={16} />
                    <TerminalIcon name="menu" iconSet={option} size={16} />
                  </span>
                ))}
              </span>
            </span>
          );
        }
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
              label: localizedEnumOptionLabel(definition, option, locale),
            }))}
          />
        );
      case 'number':
        // The definition names the control: a slider where the operator tunes
        // by eye, a typed field where the exact number is the point.
        if (editor.control === 'slider') {
          return (
            <TerminalSlider
              label={label}
              value={typeof value === 'number' ? value : editor.minimum}
              min={editor.minimum}
              max={editor.maximum}
              step={editor.step}
              showValue
              // The row already prints the name; a second copy above the track
              // would put the same text on screen twice.
              showLabel={false}
              onValueChange={onValueChange}
            />
          );
        }
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
        // `titlebar.elements` and `statusline.elements` are each an
        // arrangement of one fixed, small roster (R25's titlebar
        // constructor), which the generic comma-delimited text field below
        // let the operator type badly -- a misspelled or repeated id was
        // silently dropped rather than refused. `TerminalElementsConstructor`
        // is the pick-and-order control that replaces it for these two;
        // every other `string-list` setting has no such roster and keeps the
        // text field.
        if (definition.id === 'titlebar.elements') {
          return (
            <TerminalElementsConstructor
              label={label}
              value={Array.isArray(value) ? value.map(String) : []}
              onValueChange={onValueChange}
              options={titlebarElements.map((element) => ({
                value: element,
                label: titlebarElementLabel(element),
              }))}
            />
          );
        }
        if (definition.id === 'statusline.elements') {
          return (
            <TerminalElementsConstructor
              label={label}
              value={Array.isArray(value) ? value.map(String) : []}
              onValueChange={onValueChange}
              options={statuslineElements.map((element) => ({
                value: element,
                label: statuslineElementLabel(element),
              }))}
            />
          );
        }
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

  const awaitingFeature = settingsAwaitingTheirFeature[definition.id];

  return (
    <Setting
      label={`${label}${changed ? ' *' : ''}`}
      detail={`${definition.scope.toUpperCase()} · ${settingDescription(definition, locale)}`}
      notice={awaitingFeature === undefined ? undefined : t('settings.awaitingFeature')}
    >
      {control}
    </Setting>
  );
}

/**
 * The row's own description, in the operator's language where one has been
 * authored, save for the two settings whose description is a bare
 * `join(', ')` over their member ids: `titlebar.elements` and
 * `statusline.elements` are each edited as a comma list (`string-list` has no
 * per-value catalogue the way `enum` does), so their definitions fall back to
 * naming their members in the schema's own English rather than the
 * operator's language. These are the two detail lines that read through
 * `titlebarElementLabel`/`statuslineElementLabel` instead of the raw
 * description for that reason; every other setting reads through
 * `localizedSettingDescription`, which itself falls back to the schema's own
 * English line for a definition this pass has not yet translated.
 */
function settingDescription(definition: SettingDefinition, locale: AppLocale): string {
  if (definition.id === 'titlebar.elements') {
    return titlebarElements.map((element) => titlebarElementLabel(element)).join(', ');
  }
  if (definition.id === 'statusline.elements') {
    return statuslineElements.map((element) => statuslineElementLabel(element)).join(', ');
  }
  return localizedSettingDescription(definition, locale);
}

export function Setting({
  label,
  detail,
  notice,
  children,
}: {
  readonly label: string;
  readonly detail: string;
  readonly notice?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
        {notice === undefined ? null : <small className="settings-row__notice">{notice}</small>}
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
  statusline: 'settingsCategory.statusline',
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
