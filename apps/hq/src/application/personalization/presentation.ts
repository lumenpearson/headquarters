import {
  getSettingDefinition,
  settingsDefinitions,
  type SettingValue,
  type SettingValues,
} from '@gremuchaya/settings-schema';

/**
 * How a personalization setting reaches the document.
 *
 * Before this table each binding was written by hand inside `OperationsShell`'s
 * JSX: one `data-*` attribute or one inline custom property per setting, read
 * with its own fallback. That works at a dozen settings and stops working at a
 * hundred — and, worse, it made "declared but inert" invisible. Sixteen of
 * thirty-nine definitions were drawn, validated, saved and read by nothing, and
 * nothing in the tree said so (C20, C31).
 *
 * Listing the bindings makes the gap checkable. `presentation.test.ts` asserts
 * that every binding names a real definition and that every definition is
 * either bound here or listed in {@link settingsWithoutPresentation} with a
 * reason. Adding a definition therefore forces a decision instead of allowing
 * silence.
 */
export type PresentationBinding = AttributeBinding | CustomPropertyBinding;

interface BindingBase {
  readonly setting: string;
}

/**
 * A `data-*` attribute on the shell root. CSS keys off it, so the value has to
 * be a short stable token — an enum member or a boolean rendered as `on`/`off`.
 */
export interface AttributeBinding extends BindingBase {
  readonly kind: 'attribute';
  readonly attribute: string;
  readonly toAttribute?: (value: SettingValue) => string;
}

/** A CSS custom property on the shell root, so a stylesheet can compute with it. */
export interface CustomPropertyBinding extends BindingBase {
  readonly kind: 'custom-property';
  readonly property: string;
  readonly toCss: (value: SettingValue) => string;
}

export interface ResolvedPresentation {
  readonly attributes: Readonly<Record<string, string>>;
  readonly customProperties: Readonly<Record<string, string>>;
}

/** `on`/`off` rather than `true`/`false`: CSS attribute selectors read better. */
function toggle(value: SettingValue): string {
  return value === true ? 'on' : 'off';
}

function text(value: SettingValue): string {
  return typeof value === 'string' ? value : String(value);
}

function ratio(value: SettingValue): string {
  return numberOf(value).toString();
}

function numberOf(value: SettingValue): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const presentationBindings: readonly PresentationBinding[] = [
  { kind: 'attribute', setting: 'themes.id', attribute: 'data-theme' },
  { kind: 'attribute', setting: 'styles.mode', attribute: 'data-style-mode' },
  { kind: 'attribute', setting: 'colors.accent', attribute: 'data-accent' },
  { kind: 'attribute', setting: 'layout.density', attribute: 'data-layout-density' },
  { kind: 'attribute', setting: 'backgrounds.kind', attribute: 'data-background-kind' },
  { kind: 'attribute', setting: 'patterns.focus', attribute: 'data-focus-pattern' },
  { kind: 'attribute', setting: 'tiles.presentation', attribute: 'data-tile-presentation' },
  {
    kind: 'attribute',
    setting: 'information.showOperationalContext',
    attribute: 'data-operational-context',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'diagnostics.verbosity',
    attribute: 'data-diagnostics-verbosity',
  },
  {
    kind: 'attribute',
    setting: 'accessibility.reducedMotion',
    attribute: 'data-reduced-motion',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'cameras.gridDensity',
    attribute: 'data-camera-density',
  },
  {
    kind: 'custom-property',
    setting: 'typography.scale',
    property: '--ops-type-scale-setting',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'sizes.scale',
    property: '--ops-size-scale-setting',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'animations.intensity',
    property: '--ops-animation-intensity',
    toCss: ratio,
  },
];

/**
 * Definitions that deliberately reach nothing in the document.
 *
 * Each entry states where the setting is read instead. An entry is a claim, not
 * an excuse: it says a consumer exists somewhere other than the shell root, and
 * it is wrong the moment that stops being true. What it prevents is the silence
 * that let sixteen definitions do nothing at all.
 */
export const settingsWithoutPresentation: Readonly<Record<string, string>> = {
  'general.localOnly': 'Read by the pairing surface: it decides whether a group is offered at all.',
  'tiles.hiddenIds': 'Read by TileGrid, which drops the named tiles before layout.',
  'tiles.order': 'Read by TileGrid, which orders tiles before layout.',
  'tiles.spans': 'Read by TileGrid, which sizes tiles before layout.',
  'tiles.hiddenCategories': 'Read by TileGrid, which drops whole groups before layout.',
  'backgrounds.imageSource': 'Resolved to a material URL by OperationsShell, not a token.',
  'backgrounds.videoSource': 'Resolved to a material URL by OperationsShell, not a token.',
  'animations.enabled': 'Combined with production and accessibility state into one motion gate.',
  'startup.enabled': 'Read by the startup sequence, which runs before the shell mounts.',
  'tables.pageSize': 'Read by useTablePageSize, which every data screen pages with.',
  'popups.longPress': 'Read by the pointer-menu runtime, which decides what opens a menu.',
  'player.defaultRate': 'Read by the player when it mounts; a rate is not a token.',
  'map.mode': 'Read by the tactical map, which chooses its own renderer.',
  'keybinds.scheme': 'Read by the keybind registry when it resolves a chord.',
  'localization.locale': 'Read by the locale runtime; addressed by F11.',
  'dateTime.mode': 'Read by the shared date formatter every screen calls.',
  'telemetry.source': 'Read by the system screen, which chooses what to sample.',
  'simulation.preset': 'Read by the simulation tick; addressed by F12.',
  'groups.authority': 'Read by the group surface; addressed by F10 with R27.',
  'materials.defaultCategory': 'Read by the material import dialog when it opens.',
  'titlebar.alignment': 'Read by the native titlebar; addressed by F13.',
  'performance.inactiveDecode': 'Read by the player, which pauses decode off-screen.',
  'privacy.copyDiagnostics': 'Read by the context menu, which offers or withholds the copy.',
  'github.draftOnly': 'Read by the issue draft builder when it composes the URL.',
  'advanced.liveEdit': 'Read by edit mode before it publishes anything to a group.',
};

/**
 * Turns the current values into the attributes and properties the shell root
 * carries.
 *
 * A missing or invalid value falls back to the definition's own default rather
 * than to a literal repeated at the call site: the schema already states what
 * the default is, and a second copy of it is a second thing to keep in step.
 */
export function resolvePresentation(values: SettingValues): ResolvedPresentation {
  const attributes: Record<string, string> = {};
  const customProperties: Record<string, string> = {};
  for (const binding of presentationBindings) {
    const value = resolveValue(values, binding.setting);
    if (value === undefined) continue;
    if (binding.kind === 'attribute') {
      attributes[binding.attribute] = (binding.toAttribute ?? text)(value);
    } else {
      customProperties[binding.property] = binding.toCss(value);
    }
  }
  return { attributes, customProperties };
}

function resolveValue(values: SettingValues, id: string): SettingValue | undefined {
  const definition = getSettingDefinition(id);
  if (definition === undefined) return undefined;
  const value = values[id];
  return value !== undefined && definition.validate(value) ? value : definition.defaultValue;
}

/** Every declared setting id, for the checks that compare the two lists. */
export const declaredSettingIds: readonly string[] = settingsDefinitions.map(
  (definition) => definition.id,
);
