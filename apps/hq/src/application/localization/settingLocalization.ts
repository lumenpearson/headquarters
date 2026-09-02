'use client';

import type { SettingDefinition, SettingId, SettingScope } from '@gremuchaya/settings-schema';

import { tilePresentationLabel } from './tileLabels';
import type { MessageId } from './messages';
import { messagesFor, sourceLocale, type AppLocale } from './messages';

/**
 * The setting definitions `packages/settings-schema` ships have no
 * localization key of their own -- `apps/control-plane/src/settings/schema.ts`
 * sends `localizationKey: ''` on the wire deliberately, because the registry
 * is a trust boundary and inventing a key on the server side would only add a
 * second source of truth no message catalogue answers. This is the
 * catalogue-side half of that decision: a lookup keyed by the definition's own
 * id, so a label, a description, a scope word or an enum option can be given a
 * Russian and an English reading without the schema learning either language
 * exists.
 *
 * A label and a description are covered for every one of the 169 definitions
 * `packages/settings-schema` currently declares -- `settingLabelIds` and
 * `settingDescriptionIds` below are typed `Readonly<Record<SettingId, MessageId>>`,
 * so a definition added later with no line in either table fails
 * `pnpm typecheck` rather than silently falling back at runtime the way a
 * missing entry used to. Enum options are not exhaustively typeable the same
 * way -- `SettingEditor`'s `options` is a plain `readonly string[]`, not one
 * literal union per definition -- so their coverage is proven by a test that
 * walks `settingsDefinitions` instead (`settingLocalization.test.ts`).
 */

function labelId(id: SettingId): MessageId {
  return `settingLabel.${id}` as MessageId;
}

function descriptionId(id: SettingId): MessageId {
  return `settingDescription.${id}` as MessageId;
}

function scopeId(scope: Exclude<SettingScope, 'factory'>): MessageId {
  return `settingScope.${scope}` as MessageId;
}

/**
 * Every definition's `settingLabel.<id>` message id, listed by hand rather
 * than derived from `settingsDefinitions` at runtime: a derived table would
 * be complete by construction for whatever the schema happens to declare,
 * which proves nothing about whether `settingLabelMessages.ts` actually
 * carries a translated line for it. Written as an object literal instead, its
 * keys are checked against the {@link SettingId} union the way any object
 * literal assigned a `Record<K, V>` type is -- a definition the schema gains
 * later with no corresponding line here is a key {@link SettingId} has and this
 * table does not, which `pnpm typecheck` refuses to build.
 */
const settingLabelIds: Readonly<Record<SettingId, MessageId>> = {
  'general.localOnly': labelId('general.localOnly'),
  'general.brandTagline': labelId('general.brandTagline'),
  'general.secureLinkBadge': labelId('general.secureLinkBadge'),
  'dateTime.showSeconds': labelId('dateTime.showSeconds'),
  'dateTime.showModeLabel': labelId('dateTime.showModeLabel'),
  'dateTime.showClockRate': labelId('dateTime.showClockRate'),
  'dateTime.showHeaderDate': labelId('dateTime.showHeaderDate'),
  'diagnostics.showTransportProbe': labelId('diagnostics.showTransportProbe'),
  'diagnostics.showKeybindHints': labelId('diagnostics.showKeybindHints'),
  'information.showOperationalContext': labelId('information.showOperationalContext'),
  'layout.density': labelId('layout.density'),
  'layout.settingsNavSide': labelId('layout.settingsNavSide'),
  'tiles.hiddenIds': labelId('tiles.hiddenIds'),
  'tiles.order': labelId('tiles.order'),
  'tiles.spans': labelId('tiles.spans'),
  'tiles.hiddenCategories': labelId('tiles.hiddenCategories'),
  'tiles.presentation': labelId('tiles.presentation'),
  'themes.id': labelId('themes.id'),
  'styles.panelCorners': labelId('styles.panelCorners'),
  'styles.iconSet': labelId('styles.iconSet'),
  'styles.cornerLength': labelId('styles.cornerLength'),
  'styles.signalFieldOpacity': labelId('styles.signalFieldOpacity'),
  'styles.frameRules': labelId('styles.frameRules'),
  'styles.workspaceSeam': labelId('styles.workspaceSeam'),
  'themes.cameraSafeBrightness': labelId('themes.cameraSafeBrightness'),
  'themes.cameraSafeContrast': labelId('themes.cameraSafeContrast'),
  'themes.cameraSafeSaturation': labelId('themes.cameraSafeSaturation'),
  'themes.cameraSafeTokens': labelId('themes.cameraSafeTokens'),
  'styles.mode': labelId('styles.mode'),
  'colors.accent': labelId('colors.accent'),
  'typography.scale': labelId('typography.scale'),
  'sizes.scale': labelId('sizes.scale'),
  'backgrounds.kind': labelId('backgrounds.kind'),
  'backgrounds.imageSource': labelId('backgrounds.imageSource'),
  'backgrounds.videoSource': labelId('backgrounds.videoSource'),
  'patterns.focus': labelId('patterns.focus'),
  'animations.enabled': labelId('animations.enabled'),
  'animations.intensity': labelId('animations.intensity'),
  'startup.stageHold': labelId('startup.stageHold'),
  'startup.restoreWorld': labelId('startup.restoreWorld'),
  'startup.productionPanel': labelId('startup.productionPanel'),
  'keybinds.prefixWindow': labelId('keybinds.prefixWindow'),
  'keybinds.firedHighlight': labelId('keybinds.firedHighlight'),
  'keybinds.introOnLaunch': labelId('keybinds.introOnLaunch'),
  'keybinds.hiddenCategories': labelId('keybinds.hiddenCategories'),
  'startup.enabled': labelId('startup.enabled'),
  'startup.launchOnLogin': labelId('startup.launchOnLogin'),
  'startup.autoUpdate': labelId('startup.autoUpdate'),
  'layout.settingsLanding': labelId('layout.settingsLanding'),
  'player.defaultRate': labelId('player.defaultRate'),
  'player.startMuted': labelId('player.startMuted'),
  'player.seekStep': labelId('player.seekStep'),
  'player.defaultVolume': labelId('player.defaultVolume'),
  'player.loopDemo': labelId('player.loopDemo'),
  'player.snapshotGrayscale': labelId('player.snapshotGrayscale'),
  'player.controlsHideDelayMs': labelId('player.controlsHideDelayMs'),
  'cameras.gridDensity': labelId('cameras.gridDensity'),
  'cameras.gridPageSize': labelId('cameras.gridPageSize'),
  'cameras.defaultFilter': labelId('cameras.defaultFilter'),
  'cameras.ptzStep': labelId('cameras.ptzStep'),
  'map.zoomStep': labelId('map.zoomStep'),
  'map.resetZoom': labelId('map.resetZoom'),
  'map.shadeOpacity': labelId('map.shadeOpacity'),
  'map.alertRows': labelId('map.alertRows'),
  'cameras.feedOverlay': labelId('cameras.feedOverlay'),
  'cameras.feedBrightness': labelId('cameras.feedBrightness'),
  'map.mode': labelId('map.mode'),
  'tables.pageSize': labelId('tables.pageSize'),
  'popups.longPressDelay': labelId('popups.longPressDelay'),
  'popups.fieldMenu': labelId('popups.fieldMenu'),
  'popups.drawerWidth': labelId('popups.drawerWidth'),
  'popups.drawerScrim': labelId('popups.drawerScrim'),
  'popups.overlayBlur': labelId('popups.overlayBlur'),
  'materials.defaultSort': labelId('materials.defaultSort'),
  'materials.rememberImportCategory': labelId('materials.rememberImportCategory'),
  'materials.previewLimitMb': labelId('materials.previewLimitMb'),
  'materials.textPreviewLimitMb': labelId('materials.textPreviewLimitMb'),
  'materials.autoplayPreview': labelId('materials.autoplayPreview'),
  'materials.loopPreview': labelId('materials.loopPreview'),
  'materials.rememberPreviewPosition': labelId('materials.rememberPreviewPosition'),
  'performance.playbackLeadMs': labelId('performance.playbackLeadMs'),
  'performance.streamRetryBackoff': labelId('performance.streamRetryBackoff'),
  'popups.longPress': labelId('popups.longPress'),
  'keybinds.scheme': labelId('keybinds.scheme'),
  'localization.locale': labelId('localization.locale'),
  'localization.elementOverrides': labelId('localization.elementOverrides'),
  'dateTime.mode': labelId('dateTime.mode'),
  'telemetry.loadWarningPercent': labelId('telemetry.loadWarningPercent'),
  'telemetry.nodeTemperatureLimit': labelId('telemetry.nodeTemperatureLimit'),
  'telemetry.signalFloorPercent': labelId('telemetry.signalFloorPercent'),
  'telemetry.showCharts': labelId('telemetry.showCharts'),
  'diagnostics.auditRows': labelId('diagnostics.auditRows'),
  'general.hiddenRoutes': labelId('general.hiddenRoutes'),
  'telemetry.source': labelId('telemetry.source'),
  'simulation.preset': labelId('simulation.preset'),
  'simulation.channel': labelId('simulation.channel'),
  'simulation.valueCurve': labelId('simulation.valueCurve'),
  'simulation.criticalityCurve': labelId('simulation.criticalityCurve'),
  'simulation.interpolation': labelId('simulation.interpolation'),
  'simulation.loop': labelId('simulation.loop'),
  'simulation.periodSeconds': labelId('simulation.periodSeconds'),
  'simulation.updateIntervalMs': labelId('simulation.updateIntervalMs'),
  'simulation.timeScale': labelId('simulation.timeScale'),
  'simulation.noise': labelId('simulation.noise'),
  'simulation.smoothing': labelId('simulation.smoothing'),
  'simulation.seed': labelId('simulation.seed'),
  'groups.authority': labelId('groups.authority'),
  'materials.defaultCategory': labelId('materials.defaultCategory'),
  'titlebar.alignment': labelId('titlebar.alignment'),
  'titlebar.elements': labelId('titlebar.elements'),
  'titlebar.information': labelId('titlebar.information'),
  'statusline.elements': labelId('statusline.elements'),
  'titlebar.dragRegion': labelId('titlebar.dragRegion'),
  'accessibility.reducedMotion': labelId('accessibility.reducedMotion'),
  'performance.inactiveDecode': labelId('performance.inactiveDecode'),
  'performance.webcamResolution': labelId('performance.webcamResolution'),
  'performance.webcamFrameRate': labelId('performance.webcamFrameRate'),
  'privacy.copyDiagnostics': labelId('privacy.copyDiagnostics'),
  'privacy.webcamCapture': labelId('privacy.webcamCapture'),
  'privacy.frameCapture': labelId('privacy.frameCapture'),
  'diagnostics.verbosity': labelId('diagnostics.verbosity'),
  'github.draftOnly': labelId('github.draftOnly'),
  'advanced.undoDepth': labelId('advanced.undoDepth'),
  'advanced.historyDepth': labelId('advanced.historyDepth'),
  'advanced.demoRotationSeconds': labelId('advanced.demoRotationSeconds'),
  'advanced.worldSync': labelId('advanced.worldSync'),
  'github.includeDescriptions': labelId('github.includeDescriptions'),
  'github.includeBaseRevision': labelId('github.includeBaseRevision'),
  'github.changeFormat': labelId('github.changeFormat'),
  'github.attachDiagnostics': labelId('github.attachDiagnostics'),
  'privacy.diagnosticsRecordCounts': labelId('privacy.diagnosticsRecordCounts'),
  'privacy.diagnosticsSettingIds': labelId('privacy.diagnosticsSettingIds'),
  'privacy.persistAudit': labelId('privacy.persistAudit'),
  'advanced.liveEdit': labelId('advanced.liveEdit'),
  'sizes.panelHeader': labelId('sizes.panelHeader'),
  'sizes.panelPadding': labelId('sizes.panelPadding'),
  'sizes.tileGap': labelId('sizes.tileGap'),
  'sizes.contentGap': labelId('sizes.contentGap'),
  'sizes.borderWidth': labelId('sizes.borderWidth'),
  'sizes.controlHeight': labelId('sizes.controlHeight'),
  'typography.letterSpacing': labelId('typography.letterSpacing'),
  'typography.lineHeight': labelId('typography.lineHeight'),
  'typography.weight': labelId('typography.weight'),
  'typography.accentWeight': labelId('typography.accentWeight'),
  'colors.panelOpacity': labelId('colors.panelOpacity'),
  'colors.lineOpacity': labelId('colors.lineOpacity'),
  'animations.easing': labelId('animations.easing'),
  'animations.tileEnter': labelId('animations.tileEnter'),
  'animations.panelHover': labelId('animations.panelHover'),
  'animations.backgroundMotion': labelId('animations.backgroundMotion'),
  'patterns.background': labelId('patterns.background'),
  'patterns.opacity': labelId('patterns.opacity'),
  'patterns.scale': labelId('patterns.scale'),
  'backgrounds.overlayOpacity': labelId('backgrounds.overlayOpacity'),
  'backgrounds.blur': labelId('backgrounds.blur'),
  'backgrounds.motionSpeed': labelId('backgrounds.motionSpeed'),
  'tables.density': labelId('tables.density'),
  'tables.zebra': labelId('tables.zebra'),
  'tables.stickyHeader': labelId('tables.stickyHeader'),
  'accessibility.focusRingWidth': labelId('accessibility.focusRingWidth'),
  'accessibility.tapPadding': labelId('accessibility.tapPadding'),
  'accessibility.underlineLinks': labelId('accessibility.underlineLinks'),
  'information.showSessionMetadata': labelId('information.showSessionMetadata'),
  'information.showAsciiField': labelId('information.showAsciiField'),
  'tiles.animations': labelId('tiles.animations'),
  'tiles.categoryAnimations': labelId('tiles.categoryAnimations'),
  'layout.tileMinimumWidth': labelId('layout.tileMinimumWidth'),
  'tiles.presentationOverrides': labelId('tiles.presentationOverrides'),
  'tiles.categoryPresentation': labelId('tiles.categoryPresentation'),
};

/** The same shape as {@link settingLabelIds}, for `settingDescription.<id>`. */
const settingDescriptionIds: Readonly<Record<SettingId, MessageId>> = {
  'general.localOnly': descriptionId('general.localOnly'),
  'general.brandTagline': descriptionId('general.brandTagline'),
  'general.secureLinkBadge': descriptionId('general.secureLinkBadge'),
  'dateTime.showSeconds': descriptionId('dateTime.showSeconds'),
  'dateTime.showModeLabel': descriptionId('dateTime.showModeLabel'),
  'dateTime.showClockRate': descriptionId('dateTime.showClockRate'),
  'dateTime.showHeaderDate': descriptionId('dateTime.showHeaderDate'),
  'diagnostics.showTransportProbe': descriptionId('diagnostics.showTransportProbe'),
  'diagnostics.showKeybindHints': descriptionId('diagnostics.showKeybindHints'),
  'information.showOperationalContext': descriptionId('information.showOperationalContext'),
  'layout.density': descriptionId('layout.density'),
  'layout.settingsNavSide': descriptionId('layout.settingsNavSide'),
  'tiles.hiddenIds': descriptionId('tiles.hiddenIds'),
  'tiles.order': descriptionId('tiles.order'),
  'tiles.spans': descriptionId('tiles.spans'),
  'tiles.hiddenCategories': descriptionId('tiles.hiddenCategories'),
  'tiles.presentation': descriptionId('tiles.presentation'),
  'themes.id': descriptionId('themes.id'),
  'styles.panelCorners': descriptionId('styles.panelCorners'),
  'styles.iconSet': descriptionId('styles.iconSet'),
  'styles.cornerLength': descriptionId('styles.cornerLength'),
  'styles.signalFieldOpacity': descriptionId('styles.signalFieldOpacity'),
  'styles.frameRules': descriptionId('styles.frameRules'),
  'styles.workspaceSeam': descriptionId('styles.workspaceSeam'),
  'themes.cameraSafeBrightness': descriptionId('themes.cameraSafeBrightness'),
  'themes.cameraSafeContrast': descriptionId('themes.cameraSafeContrast'),
  'themes.cameraSafeSaturation': descriptionId('themes.cameraSafeSaturation'),
  'themes.cameraSafeTokens': descriptionId('themes.cameraSafeTokens'),
  'styles.mode': descriptionId('styles.mode'),
  'colors.accent': descriptionId('colors.accent'),
  'typography.scale': descriptionId('typography.scale'),
  'sizes.scale': descriptionId('sizes.scale'),
  'backgrounds.kind': descriptionId('backgrounds.kind'),
  'backgrounds.imageSource': descriptionId('backgrounds.imageSource'),
  'backgrounds.videoSource': descriptionId('backgrounds.videoSource'),
  'patterns.focus': descriptionId('patterns.focus'),
  'animations.enabled': descriptionId('animations.enabled'),
  'animations.intensity': descriptionId('animations.intensity'),
  'startup.stageHold': descriptionId('startup.stageHold'),
  'startup.restoreWorld': descriptionId('startup.restoreWorld'),
  'startup.productionPanel': descriptionId('startup.productionPanel'),
  'keybinds.prefixWindow': descriptionId('keybinds.prefixWindow'),
  'keybinds.firedHighlight': descriptionId('keybinds.firedHighlight'),
  'keybinds.introOnLaunch': descriptionId('keybinds.introOnLaunch'),
  'keybinds.hiddenCategories': descriptionId('keybinds.hiddenCategories'),
  'startup.enabled': descriptionId('startup.enabled'),
  'startup.launchOnLogin': descriptionId('startup.launchOnLogin'),
  'startup.autoUpdate': descriptionId('startup.autoUpdate'),
  'layout.settingsLanding': descriptionId('layout.settingsLanding'),
  'player.defaultRate': descriptionId('player.defaultRate'),
  'player.startMuted': descriptionId('player.startMuted'),
  'player.seekStep': descriptionId('player.seekStep'),
  'player.defaultVolume': descriptionId('player.defaultVolume'),
  'player.loopDemo': descriptionId('player.loopDemo'),
  'player.snapshotGrayscale': descriptionId('player.snapshotGrayscale'),
  'player.controlsHideDelayMs': descriptionId('player.controlsHideDelayMs'),
  'cameras.gridDensity': descriptionId('cameras.gridDensity'),
  'cameras.gridPageSize': descriptionId('cameras.gridPageSize'),
  'cameras.defaultFilter': descriptionId('cameras.defaultFilter'),
  'cameras.ptzStep': descriptionId('cameras.ptzStep'),
  'map.zoomStep': descriptionId('map.zoomStep'),
  'map.resetZoom': descriptionId('map.resetZoom'),
  'map.shadeOpacity': descriptionId('map.shadeOpacity'),
  'map.alertRows': descriptionId('map.alertRows'),
  'cameras.feedOverlay': descriptionId('cameras.feedOverlay'),
  'cameras.feedBrightness': descriptionId('cameras.feedBrightness'),
  'map.mode': descriptionId('map.mode'),
  'tables.pageSize': descriptionId('tables.pageSize'),
  'popups.longPressDelay': descriptionId('popups.longPressDelay'),
  'popups.fieldMenu': descriptionId('popups.fieldMenu'),
  'popups.drawerWidth': descriptionId('popups.drawerWidth'),
  'popups.drawerScrim': descriptionId('popups.drawerScrim'),
  'popups.overlayBlur': descriptionId('popups.overlayBlur'),
  'materials.defaultSort': descriptionId('materials.defaultSort'),
  'materials.rememberImportCategory': descriptionId('materials.rememberImportCategory'),
  'materials.previewLimitMb': descriptionId('materials.previewLimitMb'),
  'materials.textPreviewLimitMb': descriptionId('materials.textPreviewLimitMb'),
  'materials.autoplayPreview': descriptionId('materials.autoplayPreview'),
  'materials.loopPreview': descriptionId('materials.loopPreview'),
  'materials.rememberPreviewPosition': descriptionId('materials.rememberPreviewPosition'),
  'performance.playbackLeadMs': descriptionId('performance.playbackLeadMs'),
  'performance.streamRetryBackoff': descriptionId('performance.streamRetryBackoff'),
  'popups.longPress': descriptionId('popups.longPress'),
  'keybinds.scheme': descriptionId('keybinds.scheme'),
  'localization.locale': descriptionId('localization.locale'),
  'localization.elementOverrides': descriptionId('localization.elementOverrides'),
  'dateTime.mode': descriptionId('dateTime.mode'),
  'telemetry.loadWarningPercent': descriptionId('telemetry.loadWarningPercent'),
  'telemetry.nodeTemperatureLimit': descriptionId('telemetry.nodeTemperatureLimit'),
  'telemetry.signalFloorPercent': descriptionId('telemetry.signalFloorPercent'),
  'telemetry.showCharts': descriptionId('telemetry.showCharts'),
  'diagnostics.auditRows': descriptionId('diagnostics.auditRows'),
  'general.hiddenRoutes': descriptionId('general.hiddenRoutes'),
  'telemetry.source': descriptionId('telemetry.source'),
  'simulation.preset': descriptionId('simulation.preset'),
  'simulation.channel': descriptionId('simulation.channel'),
  'simulation.valueCurve': descriptionId('simulation.valueCurve'),
  'simulation.criticalityCurve': descriptionId('simulation.criticalityCurve'),
  'simulation.interpolation': descriptionId('simulation.interpolation'),
  'simulation.loop': descriptionId('simulation.loop'),
  'simulation.periodSeconds': descriptionId('simulation.periodSeconds'),
  'simulation.updateIntervalMs': descriptionId('simulation.updateIntervalMs'),
  'simulation.timeScale': descriptionId('simulation.timeScale'),
  'simulation.noise': descriptionId('simulation.noise'),
  'simulation.smoothing': descriptionId('simulation.smoothing'),
  'simulation.seed': descriptionId('simulation.seed'),
  'groups.authority': descriptionId('groups.authority'),
  'materials.defaultCategory': descriptionId('materials.defaultCategory'),
  'titlebar.alignment': descriptionId('titlebar.alignment'),
  'titlebar.elements': descriptionId('titlebar.elements'),
  'titlebar.information': descriptionId('titlebar.information'),
  'statusline.elements': descriptionId('statusline.elements'),
  'titlebar.dragRegion': descriptionId('titlebar.dragRegion'),
  'accessibility.reducedMotion': descriptionId('accessibility.reducedMotion'),
  'performance.inactiveDecode': descriptionId('performance.inactiveDecode'),
  'performance.webcamResolution': descriptionId('performance.webcamResolution'),
  'performance.webcamFrameRate': descriptionId('performance.webcamFrameRate'),
  'privacy.copyDiagnostics': descriptionId('privacy.copyDiagnostics'),
  'privacy.webcamCapture': descriptionId('privacy.webcamCapture'),
  'privacy.frameCapture': descriptionId('privacy.frameCapture'),
  'diagnostics.verbosity': descriptionId('diagnostics.verbosity'),
  'github.draftOnly': descriptionId('github.draftOnly'),
  'advanced.undoDepth': descriptionId('advanced.undoDepth'),
  'advanced.historyDepth': descriptionId('advanced.historyDepth'),
  'advanced.demoRotationSeconds': descriptionId('advanced.demoRotationSeconds'),
  'advanced.worldSync': descriptionId('advanced.worldSync'),
  'github.includeDescriptions': descriptionId('github.includeDescriptions'),
  'github.includeBaseRevision': descriptionId('github.includeBaseRevision'),
  'github.changeFormat': descriptionId('github.changeFormat'),
  'github.attachDiagnostics': descriptionId('github.attachDiagnostics'),
  'privacy.diagnosticsRecordCounts': descriptionId('privacy.diagnosticsRecordCounts'),
  'privacy.diagnosticsSettingIds': descriptionId('privacy.diagnosticsSettingIds'),
  'privacy.persistAudit': descriptionId('privacy.persistAudit'),
  'advanced.liveEdit': descriptionId('advanced.liveEdit'),
  'sizes.panelHeader': descriptionId('sizes.panelHeader'),
  'sizes.panelPadding': descriptionId('sizes.panelPadding'),
  'sizes.tileGap': descriptionId('sizes.tileGap'),
  'sizes.contentGap': descriptionId('sizes.contentGap'),
  'sizes.borderWidth': descriptionId('sizes.borderWidth'),
  'sizes.controlHeight': descriptionId('sizes.controlHeight'),
  'typography.letterSpacing': descriptionId('typography.letterSpacing'),
  'typography.lineHeight': descriptionId('typography.lineHeight'),
  'typography.weight': descriptionId('typography.weight'),
  'typography.accentWeight': descriptionId('typography.accentWeight'),
  'colors.panelOpacity': descriptionId('colors.panelOpacity'),
  'colors.lineOpacity': descriptionId('colors.lineOpacity'),
  'animations.easing': descriptionId('animations.easing'),
  'animations.tileEnter': descriptionId('animations.tileEnter'),
  'animations.panelHover': descriptionId('animations.panelHover'),
  'animations.backgroundMotion': descriptionId('animations.backgroundMotion'),
  'patterns.background': descriptionId('patterns.background'),
  'patterns.opacity': descriptionId('patterns.opacity'),
  'patterns.scale': descriptionId('patterns.scale'),
  'backgrounds.overlayOpacity': descriptionId('backgrounds.overlayOpacity'),
  'backgrounds.blur': descriptionId('backgrounds.blur'),
  'backgrounds.motionSpeed': descriptionId('backgrounds.motionSpeed'),
  'tables.density': descriptionId('tables.density'),
  'tables.zebra': descriptionId('tables.zebra'),
  'tables.stickyHeader': descriptionId('tables.stickyHeader'),
  'accessibility.focusRingWidth': descriptionId('accessibility.focusRingWidth'),
  'accessibility.tapPadding': descriptionId('accessibility.tapPadding'),
  'accessibility.underlineLinks': descriptionId('accessibility.underlineLinks'),
  'information.showSessionMetadata': descriptionId('information.showSessionMetadata'),
  'information.showAsciiField': descriptionId('information.showAsciiField'),
  'tiles.animations': descriptionId('tiles.animations'),
  'tiles.categoryAnimations': descriptionId('tiles.categoryAnimations'),
  'layout.tileMinimumWidth': descriptionId('layout.tileMinimumWidth'),
  'tiles.presentationOverrides': descriptionId('tiles.presentationOverrides'),
  'tiles.categoryPresentation': descriptionId('tiles.categoryPresentation'),
};

/**
 * The id-surgery reading `SchemaSetting` drew inline before this module's
 * label table existed (`tiles.presentation` -> `TILES / PRESENTATION`), kept
 * as the last-resort fallback for an id `settingLabelIds` has not caught up
 * with -- the same shape {@link localizedEnumOptionLabel} already falls back to
 * `option.toUpperCase()` with. `EditPanel.test.tsx` and `SchemaSetting.test.tsx`
 * import this directly to name a row without duplicating the surgery.
 */
export function settingLabel(id: string): string {
  return id
    .replaceAll('.', ' / ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase();
}

/** A definition's row label, in the operator's language. */
export function localizedSettingLabel(definition: SettingDefinition, locale: AppLocale): string {
  const id = settingLabelIds[definition.id as SettingId];
  return messagesFor(locale)[id] ?? messagesFor(sourceLocale)[id] ?? settingLabel(definition.id);
}

/**
 * A definition's description, in the operator's language.
 *
 * Coverage is total as of this pass: every id in {@link settingDescriptionIds}
 * has a `settingDescription.<id>` entry in either `settingLabelMessages.ts` or
 * `settingsMessages.ts`, never both -- the catalogue's own duplicate-id test
 * would refuse a build that carried one twice. The schema's own
 * `definition.description` stays the fallback below anyway, for the same
 * reason {@link localizedSettingLabel} keeps `settingLabel()`: a definition
 * added later without a translated line should read as English, not as a
 * bracketed missing-id marker on an otherwise Russian screen.
 */
export function localizedSettingDescription(
  definition: SettingDefinition,
  locale: AppLocale,
): string {
  const id = settingDescriptionIds[definition.id as SettingId];
  return messagesFor(locale)[id] ?? messagesFor(sourceLocale)[id] ?? definition.description;
}

/**
 * The word `SchemaSetting`'s detail line prints for a definition's scope
 * (`device` or `group`). `SettingScope` also carries `'factory'`, which no
 * definition is ever scoped to (`SettingDefinition.scope` excludes it), so
 * this reads the narrower type rather than the whole union.
 */
export function localizedSettingScope(
  scope: Exclude<SettingScope, 'factory'>,
  locale: AppLocale,
): string {
  const id = scopeId(scope);
  return messagesFor(locale)[id] ?? messagesFor(sourceLocale)[id] ?? scope.toUpperCase();
}

/**
 * The label an `enum` setting's dropdown shows for one of its options.
 *
 * The first lookup is `settingOption.<id>.<option>` in the catalogue --
 * `dateTime.mode`'s clocks live there as full words, because the
 * 4-character status-line markers (`dateTime.ts`'s `dateTimeModeLabel`) are
 * abbreviations a surface paying for every character earns and a dropdown
 * does not. `tiles.presentation` reuses the same four phrases the per-tile
 * presentation picker draws (`tileLabels.ts`'s `tilePresentationLabel`).
 *
 * Every other enum option is covered too, except the eleven that are not
 * words -- a resolution (`1080p`/`720p`/`480p`), an aspect ratio
 * (`3x4`/`3x3`/`2x2`), a playback multiplier (`0.5`/`1`/`1.5`/`2`) and
 * `dateTime.mode`'s `utc`, which is the token `messages.ts` already spells the
 * same in every locale. Those keep the fallback below, `option.toUpperCase()`,
 * the same reading `SchemaSetting` drew inline before this module existed.
 */
export function localizedEnumOptionLabel(
  definition: SettingDefinition,
  option: string,
  locale: AppLocale,
): string {
  const id = `settingOption.${definition.id}.${option}` as MessageId;
  const translated = messagesFor(locale)[id] ?? messagesFor(sourceLocale)[id];
  if (translated !== undefined) return translated;
  if (definition.id === 'tiles.presentation' && isTilePresentationOption(option)) {
    return tilePresentationLabel(option);
  }
  return option.toUpperCase();
}

function isTilePresentationOption(value: string): value is 'auto' | 'full' | 'compact' | 'minimal' {
  return value === 'auto' || value === 'full' || value === 'compact' || value === 'minimal';
}
