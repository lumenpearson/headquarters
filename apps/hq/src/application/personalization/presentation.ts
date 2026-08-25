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

function px(value: SettingValue): string {
  return `${numberOf(value)}px`;
}

function percent(value: SettingValue): string {
  return `${(numberOf(value) * 100).toFixed(1)}%`;
}

/**
 * `terminal` is the curve the interface was drawn with; the rest exist because
 * R19 asks for the animation settings to be adjustable, and a curve nobody can
 * name is not adjustable.
 */
function easing(value: SettingValue): string {
  if (value === 'linear') return 'linear';
  if (value === 'ease-out') return 'cubic-bezier(0.16, 1, 0.3, 1)';
  if (value === 'snap') return 'cubic-bezier(0.85, 0, 0.15, 1)';
  return 'cubic-bezier(0.2, 0.8, 0.2, 1)';
}

function numberOf(value: SettingValue): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const presentationBindings: readonly PresentationBinding[] = [
  { kind: 'attribute', setting: 'themes.id', attribute: 'data-theme' },
  { kind: 'attribute', setting: 'styles.mode', attribute: 'data-style-mode' },
  { kind: 'attribute', setting: 'styles.panelCorners', attribute: 'data-panel-corners' },
  {
    kind: 'attribute',
    setting: 'styles.frameRules',
    attribute: 'data-frame-rules',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'styles.workspaceSeam',
    attribute: 'data-workspace-seam',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'themes.cameraSafeTokens',
    attribute: 'data-camera-safe-tokens',
    toAttribute: toggle,
  },
  {
    kind: 'custom-property',
    setting: 'styles.cornerLength',
    property: '--ops-corner-length',
    toCss: px,
  },
  {
    kind: 'custom-property',
    setting: 'styles.signalFieldOpacity',
    property: '--ops-signal-field-opacity',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'themes.cameraSafeBrightness',
    property: '--ops-camera-brightness',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'themes.cameraSafeContrast',
    property: '--ops-camera-contrast',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'themes.cameraSafeSaturation',
    property: '--ops-camera-saturation',
    toCss: ratio,
  },
  { kind: 'attribute', setting: 'colors.accent', attribute: 'data-accent' },
  { kind: 'attribute', setting: 'layout.density', attribute: 'data-layout-density' },
  { kind: 'attribute', setting: 'backgrounds.kind', attribute: 'data-background-kind' },
  { kind: 'attribute', setting: 'patterns.focus', attribute: 'data-focus-pattern' },
  { kind: 'attribute', setting: 'tiles.presentation', attribute: 'data-tile-presentation' },
  {
    kind: 'attribute',
    setting: 'general.brandTagline',
    attribute: 'data-brand-tagline',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'general.secureLinkBadge',
    attribute: 'data-secure-badge',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'dateTime.showModeLabel',
    attribute: 'data-clock-mode-label',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'dateTime.showClockRate',
    attribute: 'data-clock-rate',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'dateTime.showHeaderDate',
    attribute: 'data-header-date',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'diagnostics.showTransportProbe',
    attribute: 'data-transport-probe',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'diagnostics.showKeybindHints',
    attribute: 'data-keybind-hints',
    toAttribute: toggle,
  },
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
    kind: 'attribute',
    setting: 'cameras.feedOverlay',
    attribute: 'data-camera-overlay',
    toAttribute: toggle,
  },
  {
    kind: 'custom-property',
    setting: 'cameras.feedBrightness',
    property: '--ops-feed-brightness',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'map.shadeOpacity',
    property: '--ops-map-shade',
    toCss: ratio,
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
  // Geometry. Each of these is read by a rule in `operations.css`, so moving
  // one changes the shape of every panel rather than one screen's.
  {
    kind: 'custom-property',
    setting: 'sizes.panelHeader',
    property: '--ops-panel-header',
    toCss: px,
  },
  {
    kind: 'custom-property',
    setting: 'sizes.panelPadding',
    property: '--ops-panel-padding',
    toCss: px,
  },
  { kind: 'custom-property', setting: 'sizes.tileGap', property: '--ops-tile-gap', toCss: px },
  {
    kind: 'custom-property',
    setting: 'sizes.borderWidth',
    property: '--ops-border-width',
    toCss: px,
  },
  // `sizes.controlHeight` and `accessibility.tapPadding` are not bound
  // directly: they share one hook, computed below. Two declarations would each
  // have to be neutral on its own, and `min-height: 0` is not neutral — for a
  // flex item the initial value is `auto`, and replacing it changes the
  // automatic minimum size of every control in the shell.

  // Typography.
  {
    kind: 'custom-property',
    setting: 'typography.letterSpacing',
    property: '--ops-letter-spacing',
    toCss: (value) => `${numberOf(value)}em`,
  },
  {
    kind: 'custom-property',
    setting: 'typography.lineHeight',
    property: '--ops-line-height',
    toCss: ratio,
  },
  // Weight travels as an attribute, not a property, so the default emits no
  // rule at all. A `font-weight` declaration at the shell root outranks every
  // lower-specificity weight the design set, and writing the default as its
  // fallback would not help: the declaration would still exist. This is the
  // same lesson `cameras.gridDensity`'s `adaptive` taught — the default has to
  // be the absence of a rule.
  { kind: 'attribute', setting: 'typography.weight', attribute: 'data-font-weight' },
  { kind: 'attribute', setting: 'typography.accentWeight', attribute: 'data-accent-weight' },

  // Colour, as opacity rather than as a hex value: a theme owns the hues, and
  // letting a setting name one would be the way to break a theme R14 asks to
  // stay unbroken.
  {
    kind: 'custom-property',
    setting: 'colors.panelOpacity',
    property: '--ops-panel-opacity',
    toCss: percent,
  },
  {
    kind: 'custom-property',
    setting: 'colors.lineOpacity',
    property: '--ops-line-opacity',
    toCss: ratio,
  },

  // Motion.
  {
    kind: 'custom-property',
    setting: 'animations.easing',
    property: '--ops-motion-easing',
    toCss: easing,
  },
  {
    kind: 'attribute',
    setting: 'animations.tileEnter',
    attribute: 'data-tile-enter',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'animations.panelHover',
    attribute: 'data-panel-hover',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'animations.backgroundMotion',
    attribute: 'data-background-motion',
    toAttribute: toggle,
  },

  // Patterns and background wash.
  { kind: 'attribute', setting: 'patterns.background', attribute: 'data-background-pattern' },
  {
    kind: 'custom-property',
    setting: 'patterns.opacity',
    property: '--ops-pattern-opacity',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'patterns.scale',
    property: '--ops-pattern-scale',
    toCss: px,
  },
  {
    kind: 'custom-property',
    setting: 'backgrounds.overlayOpacity',
    property: '--ops-background-overlay',
    toCss: ratio,
  },
  {
    kind: 'custom-property',
    setting: 'backgrounds.blur',
    property: '--ops-background-blur',
    toCss: px,
  },
  {
    kind: 'custom-property',
    setting: 'backgrounds.motionSpeed',
    property: '--ops-background-speed',
    toCss: ratio,
  },

  // Tables.
  { kind: 'attribute', setting: 'tables.density', attribute: 'data-table-density' },
  {
    kind: 'attribute',
    setting: 'tables.zebra',
    attribute: 'data-table-zebra',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'tables.stickyHeader',
    attribute: 'data-table-sticky',
    toAttribute: toggle,
  },

  // Accessibility.
  {
    kind: 'custom-property',
    setting: 'accessibility.focusRingWidth',
    property: '--ops-focus-ring-width',
    toCss: px,
  },
  {
    kind: 'attribute',
    setting: 'accessibility.underlineLinks',
    attribute: 'data-underline-links',
    toAttribute: toggle,
  },

  // Information density in the shell chrome.
  {
    kind: 'attribute',
    setting: 'information.showSessionMetadata',
    attribute: 'data-session-metadata',
    toAttribute: toggle,
  },
  {
    kind: 'attribute',
    setting: 'information.showAsciiField',
    attribute: 'data-ascii-field',
    toAttribute: toggle,
  },
];

/**
 * Definitions whose consumer is somewhere other than the shell root.
 *
 * Each entry names that consumer. An entry is a claim, not an excuse: it says a
 * consumer exists today, and it is wrong the moment that stops being true.
 */
export const settingsReadElsewhere: Readonly<Record<string, string>> = {
  'tiles.hiddenIds': 'Read by TileGrid, which drops the named tiles before layout.',
  'tiles.order': 'Read by TileGrid, which orders tiles before layout.',
  'tiles.spans': 'Read by TileGrid, which sizes tiles before layout.',
  'tiles.hiddenCategories': 'Read by TileGrid, which drops whole groups before layout.',
  'tiles.animations': 'Read by TileGrid, which gives a cell the motion its own entry names.',
  'tiles.categoryAnimations': 'Read by TileGrid, when no per-tile entry names a motion.',
  'backgrounds.imageSource': 'Resolved to a material URL by OperationsShell, not to a token.',
  'backgrounds.videoSource': 'Resolved to a material URL by OperationsShell, not to a token.',
  'animations.enabled': 'Combined with production and accessibility state into one motion gate.',
  'startup.enabled': 'Read by the startup sequence, which runs before the shell mounts.',
  'tables.pageSize': 'Read by useTablePageSize, which every data screen pages with.',
  'popups.longPress': 'Read by the pointer-menu runtime, which decides what opens a menu.',
  'player.defaultRate': 'Read by VideoScreen, which starts the media player at this rate.',
  'player.seekStep': 'Read by VideoScreen and LocalMaterialPlayer, whose skip controls move by it.',
  'player.defaultVolume': 'Read by VideoScreen, which opens the media surface at this volume.',
  'player.loopDemo': 'Read by VideoScreen, which repeats a finite source when it ends.',
  'player.snapshotGrayscale':
    'Read by VideoScreen, which grades the canvas a snapshot is drawn on.',
  'cameras.gridPageSize': 'Read by VideoScreen, which pages the camera registry by it.',
  'cameras.defaultFilter': 'Read by VideoScreen, which seeds the registry filter from it.',
  'cameras.ptzStep': 'Read by PtzPanel, whose pad moves pan and tilt by it.',
  'player.startMuted': 'Read by VideoScreen, which opens a camera feed muted or not.',
  'privacy.webcamCapture': 'Read inside toggleWebcam, which refuses the machine camera without it.',
  'privacy.frameCapture': 'Read inside takeSnapshot, which refuses to write a frame without it.',
  'performance.webcamResolution': 'Read by VideoScreen, which asks getUserMedia for that size.',
  'performance.webcamFrameRate': 'Read by VideoScreen, which asks getUserMedia for that rate.',
  'performance.inactiveDecode': 'Read by VideoScreen, which stops decoding a stream nobody sees.',
  'map.mode': 'Read by TacticalMapScreen, which seeds the representation it opens in.',
  'map.zoomStep': 'Read by TacticalMapScreen, whose zoom controls move by it.',
  'map.resetZoom': 'Read by TacticalMapScreen, which returns the map to it on reset.',
  'map.alertRows': 'Read by TacticalMapScreen, which lists that many alerts before stopping.',
  'telemetry.source': 'Read by SystemScreen, which chooses what its host counters sample.',
  'telemetry.loadWarningPercent': 'Read by SystemScreen, which tones the load counters against it.',
  'telemetry.nodeTemperatureLimit': 'Read by SystemScreen, which marks a hotter node critical.',
  'telemetry.signalFloorPercent': 'Read by SystemScreen, which tones a channel bar against it.',
  'telemetry.showCharts': 'Read by SystemScreen, which draws or omits the resource sparklines.',
  'diagnostics.auditRows': 'Read by SystemScreen, which lists that many audit entries.',
  'general.hiddenRoutes': 'Read by OpsNavigation, which drops the named routes from the rail.',
  'keybinds.scheme': 'Read by the keybind registry, which resolves a chord through the scheme.',
  'dateTime.mode': 'Read by the shared date formatter the shell clock and status line use.',
  'dateTime.showSeconds':
    'Read by the shared date formatter, which drops seconds from both clocks.',
  'materials.defaultCategory': 'Read by the FilesScreen import dialog when it opens.',
  'privacy.copyDiagnostics': 'Read by the context menu, which offers or withholds the copy.',
  'github.draftOnly': 'Read by the issue draft builder when it composes the URL.',
  'advanced.liveEdit':
    'Read by the live-edit bus, which decides whether a patch leaves the session.',
};

/**
 * Definitions that are declared and read by nothing yet, with the feature that
 * will read them.
 *
 * This list is a debt, not a design. It exists because writing "read by the
 * player" beside a setting no player reads would be worse than silence: the
 * next reader would believe it and stop looking. Every entry here is a
 * `SettingDefinition` an operator can already change, with no effect, and the
 * only honest thing to do is say so and name the address.
 */
export const settingsAwaitingTheirFeature: Readonly<Record<string, string>> = {
  // Moved here from `settingsReadElsewhere`, where it claimed to be "read by
  // the pairing surface, which decides whether a group is offered". No pairing
  // surface exists: outside the schema the identifier occurs twice, in this
  // file and in a negative assertion in `issueDraft.test.ts`. An excuse that
  // names an imaginary consumer is worse than no excuse, because the accounting
  // then reports the category as healthy.
  'general.localOnly': 'F10 with R27 — no pairing surface exists to offer or withhold a group.',
  // It was bound to `--ops-tile-min-width`, which no stylesheet and no module
  // read. Wiring it is not a matter of finding the missing rule: a screen's
  // `columns` is a coordinate system, not a pixel promise — `/cases` measures
  // tiles in twelfths — so capping the count makes every tile wider than the cap
  // unplaceable. Measured, not deduced: doing that emptied eleven routes and
  // failed four R10 cases. `resolveGridLayout` has to take the minimum width
  // itself and decide relocation against it.
  'layout.tileMinimumWidth':
    'Needs a minimum-width input in @gremuchaya/layout-engine; the resolver has none.',
  'localization.locale': 'F11 — no locale runtime exists; every label is a Russian literal.',
  'simulation.preset': 'F12 — the simulation formula reads no setting at all.',
  'groups.authority': 'F10 with R27 — the client has no SyncService client to send it through.',
  'titlebar.alignment': 'F13 — no custom titlebar exists in Rust or in TypeScript.',
};

/**
 * Definitions that reach the document, but through a value computed from more
 * than one of them.
 *
 * They are listed separately from {@link settingsReadElsewhere} because they
 * are presentational — the accounting would be wrong to call them read
 * somewhere else — and separately from the bindings because a binding maps one
 * setting to one property, which is precisely what these two cannot do.
 */
export const settingsDerivedIntoPresentation: Readonly<Record<string, string>> = {
  'sizes.controlHeight': 'Summed with the tap padding into `--ops-control-floor`.',
  'accessibility.tapPadding': 'Summed with the control height into `--ops-control-floor`.',
  // It used to be bound to `--ops-animation-intensity` as well, which no
  // stylesheet and no module ever read: the shell takes the value itself and
  // spends it as two durations. The binding was accounting, not a consumer.
  'animations.intensity':
    'Spent by OperationsShell as `--ops-motion-duration` and `--ops-background-duration`.',
};

/** Every definition that is not bound to the document one-to-one. */
export const settingsWithoutPresentation: Readonly<Record<string, string>> = {
  ...settingsReadElsewhere,
  ...settingsAwaitingTheirFeature,
  ...settingsDerivedIntoPresentation,
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
    const definition = getSettingDefinition(binding.setting);
    if (definition === undefined) continue;
    const value = resolveValue(values, binding.setting);
    if (value === undefined) continue;
    if (binding.kind === 'attribute') {
      // Always emitted. CSS keys off these, and an absent attribute is a
      // different selector match rather than a default one.
      attributes[binding.attribute] = (binding.toAttribute ?? text)(value);
      continue;
    }
    // A custom property is emitted only when the operator moved it. Declaring
    // every default would inherit a value where the design had none — setting
    // `letter-spacing` at the shell root, for one, changes the metrics of every
    // line of text in the application, which is a redesign rather than a
    // default. Leaving the property unset is what makes a fresh profile render
    // exactly as the build before these settings existed did.
    if (sameValue(value, definition.defaultValue)) continue;
    customProperties[binding.property] = binding.toCss(value);
  }
  const controlFloor = resolveControlFloor(values);
  if (controlFloor !== undefined) {
    customProperties['--ops-control-floor'] = controlFloor;
    // The attribute is what makes the rule exist at all. A `min-height`
    // declaration on the primitives outranks the heights they set themselves,
    // and an unset variable resolves to `unset` rather than falling back to
    // those — so at defaults the rule must not be written, not merely be given
    // a neutral value.
    attributes['data-control-sizing'] = 'custom';
  }
  return { attributes, customProperties };
}

/**
 * The minimum height a control may have, from the two settings that raise it.
 *
 * They share one hook because neither can be neutral alone. `min-height: 0` is
 * not "no opinion": the initial value for a flex item is `auto`, and replacing
 * it changes the automatic minimum size of every control in the shell. And a
 * `padding-block` declaration would replace the padding the primitives already
 * carry rather than adding to it. One property, emitted only when an operator
 * moved one of the two, leaves the design untouched until they do.
 */
function resolveControlFloor(values: SettingValues): string | undefined {
  const height = resolveValue(values, 'sizes.controlHeight');
  const padding = resolveValue(values, 'accessibility.tapPadding');
  const heightDefault = getSettingDefinition('sizes.controlHeight')?.defaultValue;
  const paddingDefault = getSettingDefinition('accessibility.tapPadding')?.defaultValue;
  if (height === undefined || padding === undefined) return undefined;
  if (height === heightDefault && padding === paddingDefault) return undefined;
  return `${numberOf(height) + numberOf(padding) * 2}px`;
}

function sameValue(left: SettingValue, right: SettingValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
  }
  return left === right;
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
