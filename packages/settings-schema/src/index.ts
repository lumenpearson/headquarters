import { isMaterialId, type CurveInterpolationKind } from '@gremuchaya/domain';

export const settingCategories = [
  'general',
  'information',
  'layout',
  'tiles',
  'themes',
  'styles',
  'colors',
  'typography',
  'sizes',
  'backgrounds',
  'patterns',
  'animations',
  'startup',
  'player',
  'cameras',
  'map',
  'tables',
  'popups',
  'keybinds',
  'localization',
  'dateTime',
  'telemetry',
  'simulation',
  'groups',
  'materials',
  'titlebar',
  'statusline',
  'accessibility',
  'performance',
  'privacy',
  'diagnostics',
  'github',
  'advanced',
] as const;

export type SettingCategory = (typeof settingCategories)[number];
export type SettingValue = boolean | number | string | readonly string[];
export type SettingValues = Readonly<Record<string, SettingValue>>;
/**
 * The layers a value can come from, in order of precedence.
 *
 * `'local-draft'` and `'session-preview'` were declared here and never
 * reached: no definition carried either, and nothing read them, so they
 * widened every `Exclude<SettingScope, 'factory'>` for no one. Removing them
 * makes that type say what it has always meant -- a definition belongs either
 * to the group or to the machine. Drafts are not a scope: they are held by
 * `PersonalizationState.draft` and resolved against these layers.
 */
export type SettingScope = 'factory' | 'group' | 'device';

/**
 * A serialisable description of the only controls the safe editor is allowed
 * to render. The editor deliberately has no arbitrary text/CSS/JS mode: each
 * value still has to pass the validator attached to its definition.
 */
export type SettingEditor =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly options: readonly string[] }
  | {
      readonly kind: 'number';
      readonly minimum: number;
      readonly maximum: number;
      readonly step: number;
      /**
       * `slider` asks the editor for a dragged control rather than a typed
       * field. Absent means a field: most numbers here are read as exact
       * values, and a slider is only the better control where the operator is
       * tuning by eye -- a gap, an opacity -- and the bounds are tight.
       */
      readonly control?: 'slider';
    }
  | { readonly kind: 'string-list'; readonly delimiter: ',' }
  /**
   * A file chosen from the material catalogue. `accept` lists the media-type
   * prefixes the picker may offer, so the operator selects material the
   * application already holds rather than naming a location. The stored value
   * is an opaque identifier -- never a path, a URL, or CSS.
   */
  | { readonly kind: 'material'; readonly accept: readonly string[] }
  /**
   * A curve the operator drags, stored as one entry per control point.
   *
   * Every bound the control needs is declared here rather than assumed at the
   * call site: `timeDomain` is the curve's own timeline, one period wide;
   * `valueDomain` is the scale a point is read on; `restingValue` is where a
   * channel with nothing drawn for it starts, which is the reading the domain
   * evaluator produces when it is handed no curve at all; `unit` is what the
   * value is measured in. A control that had to know those numbers itself
   * would be a second copy of them.
   */
  | {
      readonly kind: 'curve';
      readonly channels: readonly string[];
      readonly timeDomain: readonly [number, number];
      readonly valueDomain: readonly [number, number];
      readonly restingValue: number;
      readonly unit: string;
      readonly maximumPoints: number;
    };

export interface SettingDefinition {
  readonly id: string;
  readonly category: SettingCategory;
  readonly defaultValue: SettingValue;
  readonly scope: Exclude<SettingScope, 'factory'>;
  readonly description: string;
  readonly editor: SettingEditor;
  readonly validate: (value: unknown) => value is SettingValue;
}

export interface SettingsSnapshot {
  readonly revision: number;
  readonly values: SettingValues;
}

export interface SettingsDraft {
  readonly baseRevision: number;
  readonly values: SettingValues;
  readonly changedIds: readonly string[];
  readonly history: readonly SettingsHistoryEvent[];
}

/**
 * A schema-validated immutable draft state. Checkpoints intentionally contain
 * values only: they never carry executable CSS, HTML, JavaScript or secrets.
 */
export interface SettingsDraftCheckpoint {
  readonly values: SettingValues;
  readonly changedIds: readonly string[];
}

export interface SettingsHistoryEvent {
  readonly id: string;
  readonly at: string;
  readonly operation: 'patch' | 'reset-category' | 'reset-all' | 'import' | 'restore';
  readonly category?: SettingCategory;
  readonly changedIds: readonly string[];
}

export interface SettingsMutationMetadata {
  readonly id: string;
  readonly at: string;
}

export interface SettingsPatch {
  readonly id: string;
  readonly value: unknown;
}

type SettingValidator = ((value: unknown) => value is SettingValue) & {
  readonly editor: SettingEditor;
};

function withEditor(
  editor: SettingEditor,
  validate: (value: unknown) => value is SettingValue,
): SettingValidator {
  return Object.assign(validate, { editor });
}

const oneOf = <const Values extends readonly string[]>(values: Values): SettingValidator =>
  withEditor(
    { kind: 'enum', options: values },
    (value): value is Values[number] =>
      typeof value === 'string' && values.includes(value as Values[number]),
  );

/**
 * Accepts an identifier the material bridge issued, or the empty string, which
 * is how an operator clears the choice.
 *
 * `isMaterialId` is reused rather than re-expressed as a pattern here. That
 * same shape check had already been written out three separate times in the
 * application, and a fourth copy in another package is how the four begin to
 * disagree about what a valid reference is.
 */
const materialOf = (accept: readonly string[]): SettingValidator =>
  withEditor(
    { kind: 'material', accept },
    (value): value is string => typeof value === 'string' && (value === '' || isMaterialId(value)),
  );

const isBoolean = withEditor(
  { kind: 'boolean' },
  (value): value is boolean => typeof value === 'boolean',
);
/**
 * `step` is inferred from the bounds and can be overridden, because the
 * inference is a guess about the units and it is wrong whenever a scale that
 * runs between two whole numbers is nevertheless read in fractions -- a time
 * scale of 0 to 1000 that only ever steps by 1 cannot express half speed.
 */
const numberWithin = (minimum: number, maximum: number, step?: number) =>
  withEditor(
    {
      kind: 'number',
      minimum,
      maximum,
      step: step ?? (Number.isInteger(minimum) && Number.isInteger(maximum) ? 1 : 0.01),
    },
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum,
  );
/**
 * A number tuned by eye rather than typed: same contract as `numberWithin`,
 * rendered as a slider. The validator is identical -- the control is
 * presentation metadata, not a different acceptance rule.
 */
const sliderWithin = (minimum: number, maximum: number, step?: number) =>
  withEditor(
    {
      kind: 'number',
      minimum,
      maximum,
      step: step ?? (Number.isInteger(minimum) && Number.isInteger(maximum) ? 1 : 0.01),
      control: 'slider',
    },
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum,
  );
/**
 * A whole number within bounds, for the settings that mirror a `uint32` on the
 * wire. `numberWithin` would accept 1.5 seconds of period and hand the control
 * plane something its own field cannot carry.
 */
const integerWithin = (minimum: number, maximum: number) =>
  withEditor(
    { kind: 'number', minimum, maximum, step: 1 },
    (value): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum,
  );
const isStringList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string'),
);
/**
 * The groups a tile can belong to, so an operator can switch off a kind of
 * panel rather than naming each one. Declared here with the rest of the
 * vocabulary the safe editor is allowed to offer -- the same way theme ids and
 * accent names are.
 */
export const tileCategories = [
  'summary',
  'records',
  'detail',
  'navigation',
  'telemetry',
  'events',
  'geo',
] as const;

export type TileCategory = (typeof tileCategories)[number];

const isTileCategoryList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    value.every((item) => (tileCategories as readonly string[]).includes(item as string)),
);

const spanEntry = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*=[1-9][0-9]?x[1-9][0-9]?$/;
/**
 * `screen:tile=motion` and `category=motion`. Both carry the screen or the
 * group in the key for the same reason spans do: a tile identifier is unique
 * only within a screen, and `registry` is the table on four of them.
 */
const tileMotionEntry = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*=(none|fade|rise|scan)$/;
const categoryMotionEntry = /^[a-z][a-z0-9-]*=(none|fade|rise|scan)$/;
const isTileMotionList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && tileMotionEntry.test(item)),
);
const isCategoryMotionList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        categoryMotionEntry.test(item) &&
        (tileCategories as readonly string[]).includes(item.split('=')[0] ?? ''),
    ),
);
const isSpanList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string' && spanEntry.test(item)),
);

/**
 * `screen:tile=full|compact|minimal` and `category=full|compact|minimal`. The
 * per-tile and per-category ceiling on how rich a tile may be drawn, in the
 * shape `tiles.animations`/`tiles.categoryAnimations` already carry: a tile
 * identifier is unique only within a screen, so a per-tile entry has to name
 * the screen, and a per-category entry does not. `auto` has no spelling here
 * -- the entry is simply absent, the way an inherited tile motion is.
 */
const tilePresentationEntry = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*=(full|compact|minimal)$/;
const categoryPresentationEntry = /^[a-z][a-z0-9-]*=(full|compact|minimal)$/;
const isTilePresentationList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && tilePresentationEntry.test(item)),
);
const isCategoryPresentationList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        categoryPresentationEntry.test(item) &&
        (tileCategories as readonly string[]).includes(item.split('=')[0] ?? ''),
    ),
);

/**
 * The languages the application ships a catalogue for.
 *
 * Written once rather than at each of the two definitions that need it:
 * `localization.locale` names one of them, and a `localization.elementOverrides`
 * entry is addressed to one of them. A roster spelled out twice inside a single
 * file is a roster that will be extended once.
 *
 * `apps/hq` repeats these names in its own catalogue and `locale.test.ts` binds
 * the two lists together, exactly as `schemes.test.ts` binds `keybindSchemes` to
 * `keybinds.scheme`. The schema stays the trust boundary: it decides which
 * locale an entry may be stored under, and it does not read the client's
 * message tables to do it.
 */
const applicationLocales = ['ru', 'en'] as const;

/**
 * `locale:screen:element=caption`, the caption percent-encoded.
 *
 * Three parts, and each is already paid for elsewhere. The screen is carried
 * for the reason spans and motions carry it -- a tile identifier is unique only
 * within a screen, and `registry` is the table on four of them. The locale is
 * carried because a caption that applied in every language is the one thing a
 * translation cannot mean: without it, writing an English caption would
 * overwrite the Russian one.
 *
 * The caption itself is matched as `\S+` rather than as free text because the
 * writer percent-encodes it. That escapes the `,` the string-list editor splits
 * on and the `=` and `:` this entry is split on, and it turns every space into
 * `%20` -- so an entry carrying whitespace is one that was hand-typed in a shape
 * that would not survive the next read, and is refused here rather than dropped
 * silently later.
 */
const elementCaptionEntry = /^([a-z]{2}):[a-z][a-z0-9-]*:[a-z][a-z0-9-]*=\S+$/u;
const isElementCaptionList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== 'string') return false;
      const locale = elementCaptionEntry.exec(item)?.[1];
      // The shape and the roster, the way a category motion is checked: a
      // caption filed under a language the application has no catalogue for
      // could never be drawn, and storing it would be storing a caption the
      // operator can no longer find.
      return locale !== undefined && (applicationLocales as readonly string[]).includes(locale);
    }),
);
/**
 * Everything the custom title bar can draw, in the order it draws them by
 * default (R25).
 *
 * Declared here with the rest of the vocabulary the safe editor is allowed to
 * offer, the way `tileCategories` is. `titlebar.elements` is an arrangement of
 * this roster and nothing else: an operator may drop a control or move it, and
 * cannot name an element the bar has no way to draw.
 */
export const titlebarElements = ['title', 'information', 'minimize', 'maximize', 'close'] as const;

export type TitlebarElement = (typeof titlebarElements)[number];

/**
 * An arrangement of the roster: each entry declared, and each at most once.
 *
 * Repetition is refused rather than tolerated because the bar keys its elements
 * by name, and two `close` entries would be one React key twice.
 */
const isTitlebarElementList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((item) => (titlebarElements as readonly string[]).includes(item as string)),
);
/**
 * Everything the status line can draw, in the order it draws them by default.
 *
 * The same contract as `titlebarElements`: `statusline.elements` is an
 * arrangement of this roster and nothing else, so an operator can drop or
 * reorder an entry and cannot name one the bar has no way to draw.
 */
export const statuslineElements = [
  'system',
  'route',
  'cpu',
  'ram',
  'net',
  'probe',
  'alerts',
  'encoding',
  'clock',
  'hints',
] as const;

export type StatuslineElement = (typeof statuslineElements)[number];

const isStatuslineElementList = withEditor(
  { kind: 'string-list', delimiter: ',' },
  (value): value is readonly string[] =>
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((item) => (statuslineElements as readonly string[]).includes(item as string)),
);
const oneOfNumbers = (values: readonly number[]) =>
  withEditor(
    { kind: 'enum', options: values.map(String) },
    (value): value is number => typeof value === 'number' && values.includes(value),
  );

/**
 * The readings the simulation drives, and the address a curve point carries.
 *
 * Declared here with the rest of the vocabulary the safe editor may offer, the
 * way `tileCategories` is. The list is the world the shell already simulates:
 * the seven session metrics, the two a system node reports, the four a comms
 * channel reports (load, latency, signal and packet loss), and the two
 * device-signal readings a sensor and a camera each report.
 */
export const simulationChannels = [
  'camera-signal',
  'cpu',
  'gpu',
  'link-latency',
  'link-load',
  'link-signal',
  'network-in',
  'network-out',
  'node-load',
  'node-temperature',
  'packet-loss',
  'ram',
  'readiness',
  'sensor-signal',
  'storage',
] as const;

export type SimulationChannelName = (typeof simulationChannels)[number];

/**
 * The named simulation presets an operator may mark, in the order the schema
 * offers them.
 *
 * Declared here, next to `simulationChannels`, for the reason that list is:
 * `simulation.preset`'s reader (`simulationCurves.ts`) has to name the exact
 * same vocabulary the definition validates, or a preset the schema accepts
 * could be one the reader has never heard of.
 */
export const simulationPresets = [
  'normal',
  'elevated',
  'degraded',
  'critical',
  'incident',
  'recovery',
  'network-attack',
  'storage-exhaustion',
  'cpu-overload',
] as const;

export type SimulationPresetName = (typeof simulationPresets)[number];

/**
 * The four interpolations `evaluateCurve` implements, offered by name.
 *
 * Constrained to the domain's own union rather than restated as free strings,
 * so a kind renamed there stops compiling here instead of becoming an option
 * that selects an interpolation no evaluator has.
 */
export const curveInterpolations = [
  'linear',
  'step',
  'hermite',
  'bezier',
] as const satisfies readonly CurveInterpolationKind[];

/**
 * The ceiling `TelemetryService.assertCurve` enforces on the wire, per curve.
 * Refused here too, so a curve an operator drew locally cannot be one the
 * control plane will later reject as too long to preview.
 */
export const maximumCurvePoints = 512;

/**
 * A control point, as `channel=time,value,inTangent,outTangent`.
 *
 * A point carries its channel for the same reason a tile span carries its
 * screen: a `SettingValue` is a flat list of strings, and anything addressed
 * per element has to state its address in the entry or lose it.
 *
 * The number shape is deliberately narrow -- at most seven whole digits and six
 * decimals -- because the list is the whole storage budget of a curve and an
 * unbounded literal is an unbounded entry.
 */
const curveNumber = String.raw`-?(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,6})?`;
const curvePointEntry = new RegExp(
  `^([a-z][a-z0-9-]*)=(${curveNumber}),(${curveNumber}),(${curveNumber}),(${curveNumber})$`,
);

export interface CurveEditorShape {
  readonly channels: readonly string[];
  readonly timeDomain: readonly [number, number];
  readonly valueDomain: readonly [number, number];
  readonly restingValue: number;
  readonly unit: string;
}

const within = (value: number, bounds: readonly [number, number]): boolean =>
  value >= bounds[0] && value <= bounds[1];

/**
 * Accepts a canonical curve: channels in ascending order, each channel's points
 * in ascending time with no two points sharing one, every coordinate inside the
 * declared domain, and no channel longer than the wire's own ceiling.
 *
 * Order is part of the contract rather than a courtesy of the writer. Two lists
 * that describe the same curve are then the same list, which is what lets undo,
 * the settings history and the issue draft treat a curve as one value instead
 * of as a set that happens to compare unequal.
 */
function isCurveList(value: unknown, shape: CurveEditorShape): boolean {
  if (!Array.isArray(value)) return false;
  let channel = '';
  let previousTime = Number.NEGATIVE_INFINITY;
  let points = 0;
  for (const entry of value) {
    if (typeof entry !== 'string') return false;
    const match = curvePointEntry.exec(entry);
    if (match === null) return false;
    const [, name, rawTime, rawValue] = match;
    if (name === undefined || rawTime === undefined || rawValue === undefined) return false;
    if (!shape.channels.includes(name)) return false;
    if (name < channel) return false;
    if (name !== channel) {
      channel = name;
      previousTime = Number.NEGATIVE_INFINITY;
      points = 0;
    }
    const time = Number(rawTime);
    if (time <= previousTime) return false;
    previousTime = time;
    points += 1;
    if (points > maximumCurvePoints) return false;
    if (!within(time, shape.timeDomain)) return false;
    if (!within(Number(rawValue), shape.valueDomain)) return false;
  }
  return true;
}

const curveOver = (shape: CurveEditorShape): SettingValidator =>
  withEditor(
    { kind: 'curve', ...shape, maximumPoints: maximumCurvePoints },
    (value): value is readonly string[] => isCurveList(value, shape),
  );

export const settingsDefinitions: readonly SettingDefinition[] = [
  definition(
    'general.localOnly',
    'general',
    true,
    'device',
    'Keep this client usable without a group.',
    isBoolean,
  ),
  definition(
    'general.brandTagline',
    'general',
    true,
    'device',
    'Show the tagline under the operation mark.',
    isBoolean,
  ),
  definition(
    'general.secureLinkBadge',
    'general',
    true,
    'device',
    'Show the secure-link badge in the header.',
    isBoolean,
  ),
  definition(
    'dateTime.showSeconds',
    'dateTime',
    true,
    'device',
    'Show seconds in the shell clock and the status line.',
    isBoolean,
  ),
  definition(
    'dateTime.showModeLabel',
    'dateTime',
    true,
    'device',
    'Show which clock mode the status line is reading.',
    isBoolean,
  ),
  definition(
    'dateTime.showClockRate',
    'dateTime',
    true,
    'device',
    'Show the clock rate beside the header clock.',
    isBoolean,
  ),
  definition(
    'dateTime.showHeaderDate',
    'dateTime',
    true,
    'device',
    'Show the date in the header metadata.',
    isBoolean,
  ),
  definition(
    'diagnostics.showTransportProbe',
    'diagnostics',
    true,
    'device',
    'Show the transport probe in the status line.',
    isBoolean,
  ),
  definition(
    'diagnostics.showKeybindHints',
    'diagnostics',
    true,
    'device',
    'Show the keybind hint in the status line.',
    isBoolean,
  ),
  definition(
    'information.showOperationalContext',
    'information',
    true,
    'device',
    'Show operation and sector context in panels.',
    isBoolean,
  ),
  definition(
    'layout.density',
    'layout',
    'dense',
    'device',
    'Screen density preset.',
    oneOf(['comfortable', 'dense', 'mainframe']),
  ),
  definition(
    'layout.settingsNavSide',
    'layout',
    'left',
    'device',
    'Which side of the settings screen holds its section navigation.',
    oneOf(['left', 'right']),
  ),
  definition(
    'tiles.hiddenIds',
    'tiles',
    [],
    'device',
    'Tiles hidden by the operator, as `screen:tile` -- `registry` exists on four screens.',
    isStringList,
  ),
  definition(
    'tiles.order',
    'tiles',
    [],
    'device',
    'Tiles in the order the operator arranged them, as `screen:tile`, richest first.',
    isStringList,
  ),
  definition(
    'tiles.spans',
    'tiles',
    [],
    'device',
    'Tile sizes the operator set, as `screen:tile=columnsXrows` entries.',
    isSpanList,
  ),
  definition(
    'tiles.hiddenCategories',
    'tiles',
    [],
    'device',
    `Tile groups the operator switched off: ${tileCategories.join(', ')}.`,
    isTileCategoryList,
  ),
  definition(
    'tiles.presentation',
    'tiles',
    'auto',
    'device',
    'Cap on how rich a tile may be drawn; auto leaves the choice to the layout.',
    oneOf(['auto', 'full', 'compact', 'minimal']),
  ),
  definition(
    'themes.id',
    'themes',
    'terminal-red',
    'device',
    'Active terminal color theme.',
    oneOf([
      'terminal-red',
      'terminal-green',
      'amber-crt',
      'cold-cyan',
      'monochrome',
      'high-contrast-dark',
      'high-contrast-light',
      'light-operations',
    ]),
  ),
  definition(
    'styles.panelCorners',
    'styles',
    'hover',
    'device',
    'When a panel shows its corner brackets.',
    oneOf(['hover', 'always', 'never']),
  ),
  definition(
    'styles.iconSet',
    'styles',
    'terminal',
    'device',
    "Which library draws the shell's icons.",
    oneOf(['terminal', 'lucide', 'hugeicons', 'tabler']),
  ),
  definition(
    'styles.cornerLength',
    'styles',
    10,
    'device',
    "Length of a panel's corner bracket, in pixels.",
    numberWithin(4, 24),
  ),
  definition(
    'styles.signalFieldOpacity',
    'styles',
    0.055,
    'device',
    'Opacity of the signal field drawn behind the shell.',
    numberWithin(0, 0.25),
  ),
  definition(
    'styles.frameRules',
    'styles',
    true,
    'device',
    "Draw the vertical rules that bound the shell's content width.",
    isBoolean,
  ),
  definition(
    'styles.workspaceSeam',
    'styles',
    true,
    'device',
    'Draw the centre seam down the work area.',
    isBoolean,
  ),
  definition(
    'themes.cameraSafeBrightness',
    'themes',
    0.88,
    'device',
    'Brightness of the camera-safe grade, as a multiplier.',
    numberWithin(0.5, 1),
  ),
  definition(
    'themes.cameraSafeContrast',
    'themes',
    0.9,
    'device',
    'Contrast of the camera-safe grade, as a multiplier.',
    numberWithin(0.5, 1.2),
  ),
  definition(
    'themes.cameraSafeSaturation',
    'themes',
    0.86,
    'device',
    'Saturation of the camera-safe grade, as a multiplier.',
    numberWithin(0, 1),
  ),
  definition(
    'themes.cameraSafeTokens',
    'themes',
    true,
    'device',
    "Let camera-safe mode override the theme's text and accent tokens.",
    isBoolean,
  ),
  definition(
    'styles.mode',
    'styles',
    'strict-terminal',
    'device',
    'Terminal presentation style.',
    oneOf(['strict-terminal', 'dense-mainframe', 'tactical-grid', 'minimal-terminal']),
  ),
  definition(
    'colors.accent',
    'colors',
    'orange',
    'device',
    'Accent token family, never arbitrary CSS.',
    oneOf(['orange', 'green', 'amber', 'cyan', 'red']),
  ),
  definition(
    'typography.scale',
    'typography',
    1,
    'device',
    'Typography scale relative to the selected density.',
    numberWithin(0.85, 1.25),
  ),
  definition(
    'sizes.scale',
    'sizes',
    1,
    'device',
    'Tile and control scale within safe layout bounds.',
    numberWithin(0.85, 1.2),
  ),
  definition(
    'backgrounds.kind',
    'backgrounds',
    'terminal-grid',
    'device',
    'Application background layer.',
    oneOf([
      'solid',
      'gradient',
      'noise',
      'scanlines',
      'terminal-grid',
      'dotted-grid',
      'barber-lines',
      'radar',
      'particles',
      'image',
      'video',
    ]),
  ),
  definition(
    'backgrounds.imageSource',
    'backgrounds',
    '',
    'device',
    'Material shown by the `image` background. Empty means no material chosen.',
    materialOf(['image/']),
  ),
  definition(
    'backgrounds.videoSource',
    'backgrounds',
    '',
    'device',
    'Material played by the `video` background. Empty means no material chosen.',
    materialOf(['video/']),
  ),
  definition(
    'patterns.focus',
    'patterns',
    'brackets',
    'device',
    'Focused-element terminal pattern.',
    oneOf(['solid', 'dashed', 'dotted', 'brackets', 'barber', 'scan', 'glow']),
  ),
  definition(
    'animations.enabled',
    'animations',
    true,
    'device',
    'Enable motion allowed by accessibility settings.',
    isBoolean,
  ),
  definition(
    'animations.intensity',
    'animations',
    0.65,
    'device',
    'Global animation intensity.',
    numberWithin(0, 1),
  ),
  definition(
    'startup.stageHold',
    'startup',
    1,
    'device',
    'Multiplier on how long the startup sequence holds each stage.',
    numberWithin(0.25, 4),
  ),
  definition(
    'startup.restoreWorld',
    'startup',
    true,
    'device',
    'Restore alerts, tasks and the audit trail from the last session.',
    isBoolean,
  ),
  definition(
    'startup.productionPanel',
    'startup',
    false,
    'device',
    'Open the production panel when the application starts.',
    isBoolean,
  ),
  definition(
    'keybinds.prefixWindow',
    'keybinds',
    1200,
    'device',
    'How long a prefix key waits for the key that completes it, in milliseconds.',
    numberWithin(400, 4000),
  ),
  definition(
    'keybinds.firedHighlight',
    'keybinds',
    700,
    'device',
    'How long a fired chord stays highlighted in the list, in milliseconds.',
    numberWithin(200, 3000),
  ),
  definition(
    'keybinds.introOnLaunch',
    'keybinds',
    true,
    'device',
    'Offer the keybind card on a first launch.',
    isBoolean,
  ),
  definition(
    'keybinds.hiddenCategories',
    'keybinds',
    [],
    'device',
    'Keybind categories hidden from the list, by identifier.',
    isStringList,
  ),
  definition(
    'startup.enabled',
    'startup',
    true,
    'device',
    'Show the optimized startup sequence.',
    isBoolean,
  ),
  /*
   * Two device-scoped switches the maintenance surface owns, both off by
   * default on purpose: a shoot machine decides for itself when it restarts
   * for an update and whether it comes back on its own after a reboot.
   * Neither is a group setting -- one operator's machine cannot volunteer
   * another's for an install mid-take.
   */
  definition(
    'startup.launchOnLogin',
    'startup',
    false,
    'device',
    'Start the application when this machine signs in. Desktop only.',
    isBoolean,
  ),
  definition(
    'startup.autoUpdate',
    'startup',
    false,
    'device',
    'Check for an update on launch and download it without being asked. Desktop only.',
    isBoolean,
  ),
  definition(
    'layout.settingsLanding',
    'layout',
    'cards',
    'device',
    'Whether the settings screen opens as category cards or as one continuous list.',
    oneOf(['cards', 'unified']),
  ),
  definition(
    'player.defaultRate',
    'player',
    1,
    'device',
    'Default media playback speed.',
    oneOfNumbers([0.5, 1, 1.5, 2]),
  ),
  definition(
    'player.startMuted',
    'player',
    true,
    'device',
    'Start a camera feed muted.',
    isBoolean,
  ),
  definition(
    'player.seekStep',
    'player',
    10,
    'device',
    'Seconds one press of a skip control moves playback.',
    numberWithin(1, 60),
  ),
  definition(
    'player.defaultVolume',
    'player',
    35,
    'device',
    'Volume a media surface starts at, as a percentage.',
    numberWithin(0, 100),
  ),
  definition(
    'player.loopDemo',
    'player',
    true,
    'device',
    'Repeat a finite camera source when it reaches its end.',
    isBoolean,
  ),
  definition(
    'player.snapshotGrayscale',
    'player',
    true,
    'device',
    'Write a snapshot in grayscale, as the feed is drawn.',
    isBoolean,
  ),
  definition(
    'player.controlsHideDelayMs',
    'player',
    2500,
    'device',
    'How long a media surface waits, after the pointer leaves and no control holds focus, before its overlay controls hide.',
    numberWithin(500, 5000, 100),
  ),
  definition(
    'cameras.gridDensity',
    'cameras',
    'adaptive',
    'device',
    'Camera-grid presentation mode.',
    oneOf(['adaptive', '3x4', '3x3', '2x2']),
  ),
  definition(
    'cameras.gridPageSize',
    'cameras',
    12,
    'device',
    'Number of camera thumbnails one page of the registry holds.',
    numberWithin(4, 24),
  ),
  definition(
    'cameras.defaultFilter',
    'cameras',
    'all',
    'device',
    'Camera-registry filter a video screen opens with.',
    oneOf(['all', 'online', 'alert', 'lost']),
  ),
  definition(
    'cameras.ptzStep',
    'cameras',
    5,
    'device',
    'Degrees of pan or tilt one press of the PTZ pad applies.',
    numberWithin(1, 20),
  ),
  definition(
    'map.zoomStep',
    'map',
    1,
    'device',
    'Zoom levels one press of the map zoom control moves.',
    numberWithin(1, 4),
  ),
  definition(
    'map.resetZoom',
    'map',
    12,
    'device',
    'Zoom level the map returns to on reset.',
    numberWithin(3, 18),
  ),
  definition(
    'map.shadeOpacity',
    'map',
    1,
    'device',
    'Opacity of the terminal shade drawn over the map.',
    numberWithin(0, 1),
  ),
  definition(
    'map.alertRows',
    'map',
    6,
    'device',
    'Alerts the map alert tile lists before it stops.',
    numberWithin(3, 12),
  ),
  definition(
    'cameras.feedOverlay',
    'cameras',
    true,
    'device',
    'Draw the camera telemetry overlay over the live feed.',
    isBoolean,
  ),
  definition(
    'cameras.feedBrightness',
    'cameras',
    0.72,
    'device',
    'Brightness the video feed is drawn at, as a multiplier.',
    numberWithin(0.4, 1),
  ),
  definition(
    'map.mode',
    'map',
    'tactical',
    'device',
    'Initial map representation.',
    oneOf(['tactical', 'map', 'satellite']),
  ),
  definition(
    'tables.pageSize',
    'tables',
    50,
    'device',
    'Virtualized table page size.',
    numberWithin(10, 200),
  ),
  definition(
    'popups.longPressDelay',
    'popups',
    500,
    'device',
    'How long a press is held before it opens a menu, in milliseconds.',
    numberWithin(200, 1500),
  ),
  definition(
    'popups.fieldMenu',
    'popups',
    'native',
    'device',
    'Which menu a right click inside a text field opens.',
    oneOf(['native', 'application']),
  ),
  definition(
    'popups.drawerWidth',
    'popups',
    'standard',
    'device',
    'How wide a drawer opens.',
    oneOf(['narrow', 'standard', 'wide']),
  ),
  definition(
    'popups.drawerScrim',
    'popups',
    'standard',
    'device',
    'How much the scrim behind a drawer dims the screen.',
    oneOf(['clear', 'standard', 'opaque']),
  ),
  definition(
    'popups.overlayBlur',
    'popups',
    16,
    'device',
    'Backdrop blur behind a dialog, drawer or panel scrim, in pixels; 0 disables it.',
    sliderWithin(0, 24),
  ),
  definition(
    'materials.defaultSort',
    'materials',
    'createdAt',
    'device',
    'How the material list is sorted when a screen opens.',
    oneOf(['createdAt', 'title', 'kind', 'sizeLabel']),
  ),
  definition(
    'materials.rememberImportCategory',
    'materials',
    false,
    'device',
    'Keep the last chosen import category instead of resetting it.',
    isBoolean,
  ),
  definition(
    'materials.previewLimitMb',
    'materials',
    32,
    'device',
    'Largest binary material previewed in place, in mebibytes.',
    numberWithin(4, 128),
  ),
  definition(
    'materials.textPreviewLimitMb',
    'materials',
    2,
    'device',
    'Largest text material previewed in place, in mebibytes.',
    numberWithin(1, 32),
  ),
  definition(
    'materials.autoplayPreview',
    'materials',
    false,
    'device',
    'Start a selected material playing as soon as its local preview opens.',
    isBoolean,
  ),
  definition(
    'materials.loopPreview',
    'materials',
    false,
    'device',
    'Repeat a previewed material from the start once it ends.',
    isBoolean,
  ),
  definition(
    'materials.rememberPreviewPosition',
    'materials',
    false,
    'device',
    'Resume a previewed material where playback last left it, for this browser session.',
    isBoolean,
  ),
  definition(
    'performance.playbackLeadMs',
    'performance',
    40,
    'device',
    'How far ahead a synchronised playback command is scheduled, in milliseconds.',
    numberWithin(0, 400),
  ),
  definition(
    'performance.streamRetryBackoff',
    'performance',
    'standard',
    'device',
    'How patiently a lost camera stream is retried.',
    oneOf(['fast', 'standard', 'patient']),
  ),
  definition(
    'popups.longPress',
    'popups',
    true,
    'device',
    'Enable long-press contextual actions.',
    isBoolean,
  ),
  definition(
    'keybinds.scheme',
    'keybinds',
    'terminal-default',
    'device',
    'Named keybind collection.',
    oneOf(['terminal-default', 'vim-inspired', 'accessibility']),
  ),
  definition(
    'localization.locale',
    'localization',
    'ru',
    'device',
    'Application locale.',
    oneOf(applicationLocales),
  ),
  definition(
    'localization.elementOverrides',
    'localization',
    [],
    'device',
    'Captions the operator wrote for individual elements, as `locale:screen:element=text` entries with the text percent-encoded.',
    isElementCaptionList,
  ),
  definition(
    'dateTime.mode',
    'dateTime',
    'operation',
    'device',
    'Display operation or system time without changing the OS clock.',
    oneOf(['operation', 'system', 'utc']),
  ),
  definition(
    'telemetry.loadWarningPercent',
    'telemetry',
    80,
    'device',
    'Processor and memory load that counts as a warning, as a percentage.',
    numberWithin(50, 99),
  ),
  definition(
    'telemetry.nodeTemperatureLimit',
    'telemetry',
    65,
    'device',
    'Node temperature that counts as critical, in degrees.',
    numberWithin(40, 90),
  ),
  definition(
    'telemetry.signalFloorPercent',
    'telemetry',
    50,
    'device',
    'Channel signal below which a bar reads as critical, as a percentage.',
    numberWithin(10, 90),
  ),
  definition(
    'telemetry.showCharts',
    'telemetry',
    true,
    'device',
    'Draw the resource sparklines on the system screen.',
    isBoolean,
  ),
  definition(
    'diagnostics.auditRows',
    'diagnostics',
    14,
    'device',
    'Audit entries the journal lists at full presentation.',
    numberWithin(3, 40),
  ),
  definition(
    'general.hiddenRoutes',
    'general',
    [],
    'device',
    'Routes hidden from the navigation rail, by identifier.',
    isStringList,
  ),
  definition(
    'telemetry.source',
    'telemetry',
    'simulation',
    'group',
    'Telemetry source selection.',
    oneOf(['simulation', 'native', 'hybrid']),
  ),
  definition(
    'simulation.preset',
    'simulation',
    'normal',
    'group',
    'Marked simulation preset.',
    oneOf(simulationPresets),
  ),
  definition(
    'simulation.channel',
    'simulation',
    'cpu',
    'group',
    'Channel whose two curves the editor shows; the others keep the points already drawn for them.',
    oneOf(simulationChannels),
  ),
  definition(
    'simulation.valueCurve',
    'simulation',
    [],
    'group',
    'Reading per channel over one period, as `channel=time,value,inTangent,outTangent`; the value is a percentage of that channel’s own range, so one curve reads the same on every channel.',
    curveOver({
      channels: simulationChannels,
      timeDomain: [0, 1],
      valueDomain: [0, 100],
      restingValue: 50,
      unit: '%',
    }),
  ),
  definition(
    'simulation.criticalityCurve',
    'simulation',
    [],
    'group',
    'Criticality per channel on the same timeline, in the same entry form. It sets the severity band and caps how high a reading may climb within the channel’s range.',
    curveOver({
      channels: simulationChannels,
      timeDomain: [0, 1],
      valueDomain: [0, 1],
      restingValue: 0,
      unit: '',
    }),
  ),
  definition(
    'simulation.interpolation',
    'simulation',
    'hermite',
    'group',
    'How both curves are read between their points.',
    oneOf(curveInterpolations),
  ),
  definition(
    'simulation.loop',
    'simulation',
    true,
    'group',
    'Repeat both curves over their own span instead of holding their end points.',
    isBoolean,
  ),
  definition(
    'simulation.periodSeconds',
    'simulation',
    60,
    'group',
    'How long one pass of the curves takes, in seconds. Bounded as `TelemetryService` bounds `period_seconds`.',
    integerWithin(1, 86_400),
  ),
  definition(
    'simulation.updateIntervalMs',
    'simulation',
    1_000,
    'group',
    'How often a new reading is taken, in milliseconds. Bounded as `TelemetryService` bounds `update_interval_ms`.',
    integerWithin(1, 3_600_000),
  ),
  definition(
    'simulation.timeScale',
    'simulation',
    1,
    'group',
    'How fast the curve timeline runs against the clock. Bounded as `TelemetryService` bounds `time_scale`.',
    numberWithin(0, 1_000, 0.1),
  ),
  definition(
    'simulation.noise',
    'simulation',
    0.05,
    'group',
    'Scatter added around the curve, as a fraction of the channel range.',
    numberWithin(0, 1, 0.01),
  ),
  definition(
    'simulation.smoothing',
    'simulation',
    0.5,
    'group',
    'Weight the previous reading keeps; 0 follows the curve exactly and 1 never moves.',
    numberWithin(0, 1, 0.01),
  ),
  definition(
    'simulation.seed',
    'simulation',
    1,
    'group',
    'Seed of the scatter, so one profile produces the same series on every machine.',
    integerWithin(0, 4_294_967_295),
  ),
  definition(
    'groups.authority',
    'groups',
    'leader',
    'group',
    'Session authority strategy.',
    oneOf(['leader', 'multi-authority']),
  ),
  definition(
    'materials.defaultCategory',
    'materials',
    'other',
    'device',
    'Default category for imported files.',
    oneOf([
      'video',
      'camera',
      'photo',
      'audio',
      'document',
      'map',
      'intercept',
      'dossier',
      'report',
      'archive',
      'technical',
      'other',
    ]),
  ),
  definition(
    'titlebar.alignment',
    'titlebar',
    'split',
    'device',
    'Titlebar information alignment.',
    oneOf(['left', 'center', 'split', 'right']),
  ),
  definition(
    'titlebar.elements',
    'titlebar',
    [...titlebarElements],
    'device',
    `Titlebar elements the operator kept, in the order drawn: ${titlebarElements.join(', ')}.`,
    isTitlebarElementList,
  ),
  definition(
    'titlebar.information',
    'titlebar',
    'route',
    'device',
    'What the titlebar information slot reports.',
    oneOf(['route', 'clock', 'operation', 'connection', 'none']),
  ),
  definition(
    'statusline.elements',
    'statusline',
    [...statuslineElements],
    'device',
    `Status line elements the operator kept, in the order drawn: ${statuslineElements.join(', ')}.`,
    isStatuslineElementList,
  ),
  definition(
    'titlebar.dragRegion',
    'titlebar',
    'full',
    'device',
    'How much of the titlebar drags the window: the whole bar, the title alone, or nothing.',
    oneOf(['full', 'title', 'none']),
  ),
  definition(
    'accessibility.reducedMotion',
    'accessibility',
    false,
    'device',
    'Force reduced motion independently of system preference.',
    isBoolean,
  ),
  definition(
    'performance.inactiveDecode',
    'performance',
    true,
    'device',
    'Stop decoding invisible media streams.',
    isBoolean,
  ),
  definition(
    'performance.webcamResolution',
    'performance',
    '1080p',
    'device',
    'Resolution requested from the machine camera.',
    oneOf(['1080p', '720p', '480p']),
  ),
  definition(
    'performance.webcamFrameRate',
    'performance',
    25,
    'device',
    'Frame rate requested from the machine camera.',
    numberWithin(10, 30),
  ),
  definition(
    'privacy.copyDiagnostics',
    'privacy',
    false,
    'device',
    'Allow explicitly redacted diagnostic copy.',
    isBoolean,
  ),
  definition(
    'privacy.webcamCapture',
    'privacy',
    true,
    'device',
    "Allow this machine's camera to be used as a video source.",
    isBoolean,
  ),
  definition(
    'privacy.frameCapture',
    'privacy',
    true,
    'device',
    'Allow a camera frame to be written to disk.',
    isBoolean,
  ),
  definition(
    'diagnostics.verbosity',
    'diagnostics',
    'standard',
    'device',
    'Local structured diagnostic verbosity.',
    oneOf(['minimal', 'standard', 'verbose']),
  ),
  definition(
    'github.draftOnly',
    'github',
    true,
    'group',
    'Create draft pull requests and require confirmation for issues.',
    isBoolean,
  ),
  definition(
    'advanced.undoDepth',
    'advanced',
    100,
    'device',
    'How many reversible steps the undo stack keeps.',
    numberWithin(20, 300),
  ),
  definition(
    'advanced.historyDepth',
    'advanced',
    200,
    'device',
    'How many settings-history entries are kept.',
    numberWithin(50, 500),
  ),
  definition(
    'advanced.demoRotationSeconds',
    'advanced',
    12,
    'device',
    'How long the demo loop holds each screen, in seconds.',
    numberWithin(4, 60),
  ),
  definition(
    'advanced.worldSync',
    'advanced',
    true,
    'device',
    'Share world state with other sessions of this application.',
    isBoolean,
  ),
  definition(
    'github.includeDescriptions',
    'github',
    true,
    'device',
    "Include each setting's description in the issue draft.",
    isBoolean,
  ),
  definition(
    'github.includeBaseRevision',
    'github',
    true,
    'device',
    'Include the base revision line in the issue draft.',
    isBoolean,
  ),
  definition(
    'github.changeFormat',
    'github',
    'list',
    'device',
    'How the changed settings are written in the issue draft.',
    oneOf(['list', 'checklist']),
  ),
  definition(
    'github.attachDiagnostics',
    'github',
    false,
    'device',
    'Attach the diagnostic report to the issue draft.',
    isBoolean,
  ),
  definition(
    'privacy.diagnosticsRecordCounts',
    'privacy',
    true,
    'device',
    'Include record counts in the diagnostic report.',
    isBoolean,
  ),
  definition(
    'privacy.diagnosticsSettingIds',
    'privacy',
    true,
    'device',
    'Name the changed settings in the diagnostic report.',
    isBoolean,
  ),
  definition(
    'privacy.persistAudit',
    'privacy',
    true,
    'device',
    'Keep the audit trail in browser storage between sessions.',
    isBoolean,
  ),
  definition(
    'advanced.liveEdit',
    'advanced',
    false,
    'group',
    'Enable synchronized live edit only after explicit opt-in.',
    isBoolean,
  ),
  definition(
    'sizes.panelHeader',
    'sizes',
    42,
    'device',
    'Height of a panel header, in pixels.',
    numberWithin(24, 48),
  ),
  definition(
    'sizes.panelPadding',
    'sizes',
    12,
    'device',
    'Padding inside a panel body, in pixels.',
    numberWithin(2, 20),
  ),
  definition(
    'sizes.tileGap',
    'sizes',
    4,
    'device',
    'Gap between tiles on a laid-out screen, in pixels.',
    sliderWithin(0, 20),
  ),
  definition(
    'sizes.contentGap',
    'sizes',
    6,
    'device',
    'Gap between the content blocks of a screen layout, in pixels.',
    sliderWithin(0, 24),
  ),
  definition(
    'sizes.borderWidth',
    'sizes',
    1,
    'device',
    'Thickness of panel and control borders, in pixels.',
    numberWithin(1, 3),
  ),
  definition(
    'sizes.controlHeight',
    'sizes',
    22,
    'device',
    'Minimum height of a button, field or select, in pixels.',
    numberWithin(18, 40),
  ),
  definition(
    'typography.letterSpacing',
    'typography',
    0.05,
    'device',
    'Letter spacing of interface text, in em.',
    numberWithin(0, 0.2),
  ),
  definition(
    'typography.lineHeight',
    'typography',
    1.2,
    'device',
    'Line height of interface text.',
    numberWithin(1, 1.8),
  ),
  definition(
    'typography.weight',
    'typography',
    'regular',
    'device',
    'Weight of interface text.',
    oneOf(['regular', 'medium', 'bold']),
  ),
  definition(
    'typography.accentWeight',
    'typography',
    'bold',
    'device',
    'Weight the interface gives an accented value.',
    oneOf(['regular', 'medium', 'bold']),
  ),
  definition(
    'colors.panelOpacity',
    'colors',
    0.92,
    'device',
    'Opacity of a panel over the application background.',
    numberWithin(0.5, 1),
  ),
  definition(
    'colors.lineOpacity',
    'colors',
    1,
    'device',
    'Opacity of panel and control outlines.',
    numberWithin(0.3, 1),
  ),
  definition(
    'animations.easing',
    'animations',
    'terminal',
    'device',
    'Easing every interface transition uses.',
    oneOf(['terminal', 'linear', 'ease-out', 'snap']),
  ),
  definition(
    'animations.tileEnter',
    'animations',
    true,
    'device',
    'Animate a tile as it enters the layout.',
    isBoolean,
  ),
  definition(
    'animations.panelHover',
    'animations',
    true,
    'device',
    'Animate a panel under the pointer.',
    isBoolean,
  ),
  definition(
    'animations.backgroundMotion',
    'animations',
    true,
    'device',
    'Let the application background move.',
    isBoolean,
  ),
  definition(
    'patterns.background',
    'patterns',
    'none',
    'device',
    'Pattern drawn over the application background.',
    oneOf(['none', 'grid', 'dots', 'barber', 'scanlines']),
  ),
  definition(
    'patterns.opacity',
    'patterns',
    0.35,
    'device',
    'Opacity of the background pattern.',
    numberWithin(0, 1),
  ),
  definition(
    'patterns.scale',
    'patterns',
    12,
    'device',
    'Size of one repeat of the background pattern, in pixels.',
    numberWithin(4, 48),
  ),
  definition(
    'backgrounds.overlayOpacity',
    'backgrounds',
    0.55,
    'device',
    'Opacity of the wash over an image or video background.',
    numberWithin(0, 1),
  ),
  definition(
    'backgrounds.blur',
    'backgrounds',
    0,
    'device',
    'Blur applied to a video background, in pixels.',
    numberWithin(0, 24),
  ),
  definition(
    'backgrounds.motionSpeed',
    'backgrounds',
    1,
    'device',
    'How fast an animated background moves, as a multiplier.',
    numberWithin(0.25, 3),
  ),
  definition(
    'tables.density',
    'tables',
    'compact',
    'device',
    'Row height of a data table.',
    oneOf(['comfortable', 'compact']),
  ),
  definition(
    'tables.zebra',
    'tables',
    false,
    'device',
    'Shade alternating rows of a data table.',
    isBoolean,
  ),
  definition(
    'tables.stickyHeader',
    'tables',
    true,
    'device',
    'Keep a table header in place while its rows scroll.',
    isBoolean,
  ),
  definition(
    'accessibility.focusRingWidth',
    'accessibility',
    1,
    'device',
    'Thickness of the focus outline, in pixels.',
    numberWithin(1, 4),
  ),
  definition(
    'accessibility.tapPadding',
    'accessibility',
    0,
    'device',
    'Extra padding added to every control, in pixels.',
    numberWithin(0, 12),
  ),
  definition(
    'accessibility.underlineLinks',
    'accessibility',
    false,
    'device',
    'Underline links rather than relying on colour alone.',
    isBoolean,
  ),
  definition(
    'information.showSessionMetadata',
    'information',
    true,
    'device',
    'Show session and clearance in the header.',
    isBoolean,
  ),
  definition(
    'information.showAsciiField',
    'information',
    true,
    'device',
    'Draw the signal field behind the shell.',
    isBoolean,
  ),
  definition(
    'tiles.animations',
    'tiles',
    [],
    'device',
    'Entering animation the operator chose per tile, as `screen:tile=motion` entries.',
    isTileMotionList,
  ),
  definition(
    'tiles.categoryAnimations',
    'tiles',
    [],
    'device',
    `Entering animation per tile group: ${tileCategories.join(', ')}, as \`group=motion\`.`,
    isCategoryMotionList,
  ),
  definition(
    'layout.tileMinimumWidth',
    'layout',
    // The range floor on purpose: the default must not move a single stock
    // tile at any supported viewport, and 240 displaced the reports-kinds
    // and map-layers tiles at 1440x900 the day the resolver gained this
    // reader. Raising the floor is the operator's call for their monitor.
    160,
    'device',
    'Narrowest a tile may be before the layout moves it, in pixels.',
    numberWithin(160, 480),
  ),
  definition(
    'tiles.presentationOverrides',
    'tiles',
    [],
    'device',
    'Presentation cap the operator chose per tile, as `screen:tile=full|compact|minimal` entries; overrides the category and the application ceiling.',
    isTilePresentationList,
  ),
  definition(
    'tiles.categoryPresentation',
    'tiles',
    [],
    'device',
    `Presentation cap per tile group, as \`group=full|compact|minimal\`: ${tileCategories.join(', ')}.`,
    isCategoryPresentationList,
  ),
] as const;

const definitionById = new Map(
  settingsDefinitions.map((definition) => [definition.id, definition]),
);

/** Returns the schema entry without exposing the mutable implementation map. */
export function getSettingDefinition(id: string): SettingDefinition | undefined {
  return definitionById.get(id);
}

/** Stable schema order is also the render order used by the settings catalogue. */
export function getSettingsDefinitionsForCategory(
  category: SettingCategory,
): readonly SettingDefinition[] {
  return settingsDefinitions.filter((definition) => definition.category === category);
}

export function createFactorySnapshot(): SettingsSnapshot {
  return {
    revision: 0,
    values: Object.fromEntries(
      settingsDefinitions.map((definition) => [definition.id, cloneValue(definition.defaultValue)]),
    ),
  };
}

export function createSettingsDraft(snapshot: SettingsSnapshot): SettingsDraft {
  assertSnapshot(snapshot);
  return {
    baseRevision: snapshot.revision,
    values: cloneValues(snapshot.values),
    changedIds: [],
    history: [],
  };
}

export function createSettingsDraftCheckpoint(draft: SettingsDraft): SettingsDraftCheckpoint {
  return {
    values: cloneValues(draft.values),
    changedIds: [...draft.changedIds],
  };
}

/**
 * Restores a previously captured safe checkpoint into the current draft. It
 * preserves the current optimistic base revision so callers must still publish
 * a new revision rather than mutating historical published state in place.
 */
export function restoreSettingsDraft(
  draft: SettingsDraft,
  checkpoint: SettingsDraftCheckpoint,
  metadata: SettingsMutationMetadata,
): SettingsDraft {
  const snapshot = parseSettingsSnapshot({
    revision: draft.baseRevision,
    values: checkpoint.values,
  });
  const changedIds = unique(checkpoint.changedIds);
  for (const id of changedIds) {
    if (!definitionById.has(id)) throw new UnknownSettingError(id);
  }
  return appendHistory(draft, snapshot.values, new Set(changedIds), {
    ...metadata,
    operation: 'restore',
    changedIds,
  });
}

export function applyDraftPatch(
  draft: SettingsDraft,
  patches: readonly SettingsPatch[],
  metadata: SettingsMutationMetadata,
): SettingsDraft {
  const values = cloneValues(draft.values);
  const changedIds = new Set(draft.changedIds);
  const patchIds: string[] = [];
  for (const patch of patches) {
    const definition = definitionById.get(patch.id);
    if (definition === undefined) throw new UnknownSettingError(patch.id);
    if (!definition.validate(patch.value)) throw new InvalidSettingValueError(patch.id);
    values[patch.id] = cloneValue(patch.value);
    changedIds.add(patch.id);
    patchIds.push(patch.id);
  }
  return appendHistory(draft, values, changedIds, {
    ...metadata,
    operation: 'patch',
    changedIds: unique(patchIds),
  });
}

export function resetDraftCategory(
  draft: SettingsDraft,
  category: SettingCategory,
  metadata: SettingsMutationMetadata,
): SettingsDraft {
  const values = cloneValues(draft.values);
  const changedIds = new Set(draft.changedIds);
  const resetIds = settingsDefinitions
    .filter((definition) => definition.category === category)
    .map((definition) => {
      values[definition.id] = cloneValue(definition.defaultValue);
      changedIds.add(definition.id);
      return definition.id;
    });
  return appendHistory(draft, values, changedIds, {
    ...metadata,
    operation: 'reset-category',
    category,
    changedIds: resetIds,
  });
}

export function resetDraftAll(
  draft: SettingsDraft,
  metadata: SettingsMutationMetadata,
): SettingsDraft {
  const factory = createFactorySnapshot();
  return appendHistory(draft, factory.values, new Set(Object.keys(factory.values)), {
    ...metadata,
    operation: 'reset-all',
    changedIds: Object.keys(factory.values),
  });
}

export function importDraft(
  draft: SettingsDraft,
  serialized: string,
  metadata: SettingsMutationMetadata,
): SettingsDraft {
  const parsed: unknown = JSON.parse(serialized);
  const imported = parseSettingsSnapshot(parsed);
  return appendHistory(draft, imported.values, new Set(Object.keys(imported.values)), {
    ...metadata,
    operation: 'import',
    changedIds: Object.keys(imported.values),
  });
}

export function exportDraft(draft: SettingsDraft): string {
  return JSON.stringify({ revision: draft.baseRevision, values: draft.values }, null, 2);
}

export function publishDraft(draft: SettingsDraft): SettingsSnapshot {
  return { revision: draft.baseRevision + 1, values: cloneValues(draft.values) };
}

export function parseSettingsSnapshot(value: unknown): SettingsSnapshot {
  if (!isRecord(value) || !isRecord(value.values)) {
    throw new Error(
      'Settings import must contain a non-negative integer revision and a values object.',
    );
  }
  const revision = value.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new Error(
      'Settings import must contain a non-negative integer revision and a values object.',
    );
  }
  const values: Record<string, SettingValue> = {};
  for (const definition of settingsDefinitions) {
    const imported = value.values[definition.id];
    /*
     * A setting the file does not mention takes its declared default; a setting
     * it does mention must still pass that setting's own validator.
     *
     * Absence and invalidity are different facts and used to be one. Every
     * definition was required to be present, so the day a definition was added
     * every settings file an operator had already exported stopped importing --
     * `[!] IMPORT REJECTED: SCHEMA VALIDATION FAILED`, for a file that was
     * correct when it was written. R6 adds definitions by the dozen, which
     * would have made that the normal outcome rather than the rare one.
     *
     * This is not a loosened validator, and the distinction is the whole point.
     * Nothing an operator supplies skips `validate`: a value that is present and
     * wrong is still refused by name. What fills the gap is the schema's own
     * `defaultValue`, which is the same thing a fresh draft would hold, so an
     * older file imports as "everything it says, and the defaults for what it
     * predates".
     */
    if (imported === undefined) {
      values[definition.id] = cloneValue(definition.defaultValue);
      continue;
    }
    if (!definition.validate(imported)) throw new InvalidSettingValueError(definition.id);
    values[definition.id] = cloneValue(imported);
  }
  return { revision, values };
}

export class UnknownSettingError extends Error {
  constructor(id: string) {
    super(`Unknown setting: ${id}`);
    this.name = 'UnknownSettingError';
  }
}

export class InvalidSettingValueError extends Error {
  constructor(id: string) {
    super(`Invalid value for setting: ${id}`);
    this.name = 'InvalidSettingValueError';
  }
}

function definition(
  id: string,
  category: SettingCategory,
  defaultValue: SettingValue,
  scope: Exclude<SettingScope, 'factory'>,
  description: string,
  validate: SettingValidator,
): SettingDefinition {
  return { id, category, defaultValue, scope, description, editor: validate.editor, validate };
}

function appendHistory(
  draft: SettingsDraft,
  values: SettingValues,
  changedIds: ReadonlySet<string>,
  event: SettingsHistoryEvent,
): SettingsDraft {
  return {
    baseRevision: draft.baseRevision,
    values,
    changedIds: [...changedIds].sort(),
    history: [...draft.history, event],
  };
}

function assertSnapshot(snapshot: SettingsSnapshot): void {
  parseSettingsSnapshot(snapshot);
}

function cloneValues(values: SettingValues): Record<string, SettingValue> {
  return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, cloneValue(value)]));
}

function cloneValue(value: SettingValue): SettingValue {
  return Array.isArray(value) ? [...value] : value;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
