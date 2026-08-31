import type { CatalogModule } from './catalogTypes';

/**
 * The option labels an enum setting's dropdown shows, for every option this
 * pass translates.
 *
 * Not all 173: four already live in `settingsMessages.ts` (`dateTime.mode`'s
 * `operation`/`system`, `layout.settingsLanding`'s `cards`/`unified`) and stay
 * there rather than being duplicated here. `tiles.presentation`'s four options
 * are drawn nowhere in this file either -- `localizedEnumOptionLabel` reuses
 * `tilePresentationLabel` for that one id, the same four phrases the per-tile
 * presentation picker already draws, so a second copy of that text here would
 * be the third.
 *
 * Eleven option values are deliberately absent, kept on
 * `localizedEnumOptionLabel`'s `option.toUpperCase()` fallback because they are
 * not words: `performance.webcamResolution`'s `1080p`/`720p`/`480p`,
 * `cameras.gridDensity`'s `3x4`/`3x3`/`2x2`, `player.defaultRate`'s
 * `0.5`/`1`/`1.5`/`2`, and `dateTime.mode`'s `utc` -- a resolution, an aspect
 * ratio and a playback multiplier read the same in every locale, and `UTC` is
 * the token `messages.ts` already documents as spelled the same everywhere.
 * Translating a number into a word was the one thing this pass was told not
 * to do.
 */
export const settingOptionMessages = {
  'settingOption.layout.density.comfortable': { ru: 'ПРОСТОРНАЯ', en: 'COMFORTABLE' },
  'settingOption.layout.density.dense': { ru: 'ПЛОТНАЯ', en: 'DENSE' },
  'settingOption.layout.density.mainframe': { ru: 'МЕЙНФРЕЙМ', en: 'MAINFRAME' },
  'settingOption.layout.settingsNavSide.left': { ru: 'СЛЕВА', en: 'LEFT' },
  'settingOption.layout.settingsNavSide.right': { ru: 'СПРАВА', en: 'RIGHT' },
  'settingOption.themes.id.terminal-red': { ru: 'ТЕРМИНАЛ КРАСНЫЙ', en: 'TERMINAL RED' },
  'settingOption.themes.id.terminal-green': { ru: 'ТЕРМИНАЛ ЗЕЛЁНЫЙ', en: 'TERMINAL GREEN' },
  'settingOption.themes.id.amber-crt': { ru: 'ЯНТАРНЫЙ ЭЛТ', en: 'AMBER CRT' },
  'settingOption.themes.id.cold-cyan': { ru: 'ХОЛОДНЫЙ ГОЛУБОЙ', en: 'COLD CYAN' },
  'settingOption.themes.id.monochrome': { ru: 'МОНОХРОМ', en: 'MONOCHROME' },
  'settingOption.themes.id.high-contrast-dark': {
    ru: 'ВЫСОКИЙ КОНТРАСТ, ТЁМНАЯ',
    en: 'HIGH CONTRAST DARK',
  },
  'settingOption.themes.id.high-contrast-light': {
    ru: 'ВЫСОКИЙ КОНТРАСТ, СВЕТЛАЯ',
    en: 'HIGH CONTRAST LIGHT',
  },
  'settingOption.themes.id.light-operations': { ru: 'СВЕТЛЫЙ ОПЕРАТИВНЫЙ', en: 'LIGHT OPERATIONS' },
  'settingOption.styles.panelCorners.hover': { ru: 'ПРИ НАВЕДЕНИИ', en: 'ON HOVER' },
  'settingOption.styles.panelCorners.always': { ru: 'ВСЕГДА', en: 'ALWAYS' },
  'settingOption.styles.panelCorners.never': { ru: 'НИКОГДА', en: 'NEVER' },
  /*
   * Only `terminal` is named here. `lucide`, `hugeicons` and `tabler` are the
   * libraries' own names: a proper noun reads the same in every locale, so an
   * entry for one would hold a single spelling twice and claim a translation
   * that does not exist. They take the documented `option.toUpperCase()`
   * fallback, as the resolutions and aspect ratios do. `terminal` is not a
   * name but a description -- the marks this repository draws itself -- and so
   * it has a Russian word.
   */
  'settingOption.styles.iconSet.terminal': { ru: 'ТЕРМИНАЛЬНЫЙ', en: 'TERMINAL' },
  'settingOption.styles.mode.strict-terminal': { ru: 'СТРОГИЙ ТЕРМИНАЛ', en: 'STRICT TERMINAL' },
  'settingOption.styles.mode.dense-mainframe': { ru: 'ПЛОТНЫЙ МЕЙНФРЕЙМ', en: 'DENSE MAINFRAME' },
  'settingOption.styles.mode.tactical-grid': { ru: 'ТАКТИЧЕСКАЯ СЕТКА', en: 'TACTICAL GRID' },
  'settingOption.styles.mode.minimal-terminal': {
    ru: 'МИНИМАЛЬНЫЙ ТЕРМИНАЛ',
    en: 'MINIMAL TERMINAL',
  },
  'settingOption.colors.accent.orange': { ru: 'ОРАНЖЕВЫЙ', en: 'ORANGE' },
  'settingOption.colors.accent.green': { ru: 'ЗЕЛЁНЫЙ', en: 'GREEN' },
  'settingOption.colors.accent.amber': { ru: 'ЯНТАРНЫЙ', en: 'AMBER' },
  'settingOption.colors.accent.cyan': { ru: 'ГОЛУБОЙ', en: 'CYAN' },
  'settingOption.colors.accent.red': { ru: 'КРАСНЫЙ', en: 'RED' },
  'settingOption.backgrounds.kind.solid': { ru: 'СПЛОШНОЙ', en: 'SOLID' },
  'settingOption.backgrounds.kind.gradient': { ru: 'ГРАДИЕНТ', en: 'GRADIENT' },
  'settingOption.backgrounds.kind.noise': { ru: 'ШУМ', en: 'NOISE' },
  'settingOption.backgrounds.kind.scanlines': { ru: 'СТРОЧНАЯ РАЗВЁРТКА', en: 'SCANLINES' },
  'settingOption.backgrounds.kind.terminal-grid': { ru: 'ТЕРМИНАЛЬНАЯ СЕТКА', en: 'TERMINAL GRID' },
  'settingOption.backgrounds.kind.dotted-grid': { ru: 'ТОЧЕЧНАЯ СЕТКА', en: 'DOTTED GRID' },
  'settingOption.backgrounds.kind.barber-lines': { ru: 'ДИАГОНАЛЬНЫЕ ПОЛОСЫ', en: 'BARBER LINES' },
  'settingOption.backgrounds.kind.radar': { ru: 'РАДАР', en: 'RADAR' },
  'settingOption.backgrounds.kind.particles': { ru: 'ЧАСТИЦЫ', en: 'PARTICLES' },
  'settingOption.backgrounds.kind.image': { ru: 'ИЗОБРАЖЕНИЕ', en: 'IMAGE' },
  'settingOption.backgrounds.kind.video': { ru: 'ВИДЕО', en: 'VIDEO' },
  'settingOption.backgrounds.kind.bitmap-shader': {
    ru: 'РАСТРОВЫЙ ШЕЙДЕР',
    en: 'BITMAP SHADER',
  },
  'settingOption.patterns.focus.solid': { ru: 'СПЛОШНОЙ', en: 'SOLID' },
  'settingOption.patterns.focus.dashed': { ru: 'ПУНКТИРНЫЙ', en: 'DASHED' },
  'settingOption.patterns.focus.dotted': { ru: 'ТОЧЕЧНЫЙ', en: 'DOTTED' },
  'settingOption.patterns.focus.brackets': { ru: 'СКОБКИ', en: 'BRACKETS' },
  'settingOption.patterns.focus.barber': { ru: 'ДИАГОНАЛЬНЫЙ', en: 'BARBER' },
  'settingOption.patterns.focus.scan': { ru: 'РАЗВЁРТКА', en: 'SCAN' },
  'settingOption.patterns.focus.glow': { ru: 'СВЕЧЕНИЕ', en: 'GLOW' },
  'settingOption.cameras.gridDensity.adaptive': { ru: 'АДАПТИВНАЯ', en: 'ADAPTIVE' },
  'settingOption.cameras.defaultFilter.all': { ru: 'ВСЕ', en: 'ALL' },
  'settingOption.cameras.defaultFilter.online': { ru: 'В СЕТИ', en: 'ONLINE' },
  'settingOption.cameras.defaultFilter.alert': { ru: 'ТРЕВОГА', en: 'ALERT' },
  'settingOption.cameras.defaultFilter.lost': { ru: 'ПОТЕРЯНА', en: 'LOST' },
  'settingOption.map.mode.tactical': { ru: 'ТАКТИЧЕСКАЯ', en: 'TACTICAL' },
  'settingOption.map.mode.map': { ru: 'КАРТА', en: 'MAP' },
  'settingOption.map.mode.satellite': { ru: 'СПУТНИК', en: 'SATELLITE' },
  'settingOption.popups.fieldMenu.native': { ru: 'СИСТЕМНОЕ', en: 'NATIVE' },
  'settingOption.popups.fieldMenu.application': { ru: 'ПРИЛОЖЕНИЯ', en: 'APPLICATION' },
  'settingOption.popups.drawerWidth.narrow': { ru: 'УЗКАЯ', en: 'NARROW' },
  'settingOption.popups.drawerWidth.standard': { ru: 'СТАНДАРТНАЯ', en: 'STANDARD' },
  'settingOption.popups.drawerWidth.wide': { ru: 'ШИРОКАЯ', en: 'WIDE' },
  'settingOption.popups.drawerScrim.clear': { ru: 'ПРОЗРАЧНАЯ', en: 'CLEAR' },
  'settingOption.popups.drawerScrim.standard': { ru: 'СТАНДАРТНАЯ', en: 'STANDARD' },
  'settingOption.popups.drawerScrim.opaque': { ru: 'НЕПРОЗРАЧНАЯ', en: 'OPAQUE' },
  'settingOption.materials.defaultSort.createdAt': { ru: 'ПО ДАТЕ СОЗДАНИЯ', en: 'CREATED AT' },
  'settingOption.materials.defaultSort.title': { ru: 'ПО НАЗВАНИЮ', en: 'TITLE' },
  'settingOption.materials.defaultSort.kind': { ru: 'ПО ТИПУ', en: 'KIND' },
  'settingOption.materials.defaultSort.sizeLabel': { ru: 'ПО РАЗМЕРУ', en: 'SIZE' },
  'settingOption.performance.streamRetryBackoff.fast': { ru: 'БЫСТРО', en: 'FAST' },
  'settingOption.performance.streamRetryBackoff.standard': { ru: 'СТАНДАРТНО', en: 'STANDARD' },
  'settingOption.performance.streamRetryBackoff.patient': { ru: 'ТЕРПЕЛИВО', en: 'PATIENT' },
  'settingOption.keybinds.scheme.terminal-default': {
    ru: 'ТЕРМИНАЛ ПО УМОЛЧАНИЮ',
    en: 'TERMINAL DEFAULT',
  },
  'settingOption.keybinds.scheme.vim-inspired': { ru: 'НА ОСНОВЕ VIM', en: 'VIM-INSPIRED' },
  'settingOption.keybinds.scheme.accessibility': { ru: 'ДОСТУПНОСТЬ', en: 'ACCESSIBILITY' },
  'settingOption.localization.locale.ru': { ru: 'РУССКИЙ', en: 'RUSSIAN' },
  'settingOption.localization.locale.en': { ru: 'АНГЛИЙСКИЙ', en: 'ENGLISH' },
  'settingOption.telemetry.source.simulation': { ru: 'СИМУЛЯЦИЯ', en: 'SIMULATION' },
  'settingOption.telemetry.source.native': { ru: 'НАТИВНЫЙ', en: 'NATIVE' },
  'settingOption.telemetry.source.hybrid': { ru: 'ГИБРИДНЫЙ', en: 'HYBRID' },
  'settingOption.simulation.preset.normal': { ru: 'НОРМА', en: 'NORMAL' },
  'settingOption.simulation.preset.elevated': { ru: 'ПОВЫШЕННЫЙ', en: 'ELEVATED' },
  'settingOption.simulation.preset.degraded': { ru: 'ДЕГРАДАЦИЯ', en: 'DEGRADED' },
  'settingOption.simulation.preset.critical': { ru: 'КРИТИЧЕСКИЙ', en: 'CRITICAL' },
  'settingOption.simulation.preset.incident': { ru: 'ИНЦИДЕНТ', en: 'INCIDENT' },
  'settingOption.simulation.preset.recovery': { ru: 'ВОССТАНОВЛЕНИЕ', en: 'RECOVERY' },
  'settingOption.simulation.preset.network-attack': { ru: 'СЕТЕВАЯ АТАКА', en: 'NETWORK ATTACK' },
  'settingOption.simulation.preset.storage-exhaustion': {
    ru: 'ИСЧЕРПАНИЕ ХРАНИЛИЩА',
    en: 'STORAGE EXHAUSTION',
  },
  'settingOption.simulation.preset.cpu-overload': {
    ru: 'ПЕРЕГРУЗКА ПРОЦЕССОРА',
    en: 'CPU OVERLOAD',
  },
  'settingOption.simulation.channel.camera-signal': { ru: 'СИГНАЛ КАМЕРЫ', en: 'CAMERA SIGNAL' },
  'settingOption.simulation.channel.cpu': { ru: 'ПРОЦЕССОР', en: 'CPU' },
  'settingOption.simulation.channel.gpu': { ru: 'ВИДЕОКАРТА', en: 'GPU' },
  'settingOption.simulation.channel.link-latency': { ru: 'ЗАДЕРЖКА КАНАЛА', en: 'LINK LATENCY' },
  'settingOption.simulation.channel.link-load': { ru: 'НАГРУЗКА КАНАЛА', en: 'LINK LOAD' },
  'settingOption.simulation.channel.link-signal': { ru: 'СИГНАЛ КАНАЛА', en: 'LINK SIGNAL' },
  'settingOption.simulation.channel.network-in': { ru: 'ВХОДЯЩИЙ ТРАФИК', en: 'NETWORK IN' },
  'settingOption.simulation.channel.network-out': { ru: 'ИСХОДЯЩИЙ ТРАФИК', en: 'NETWORK OUT' },
  'settingOption.simulation.channel.node-load': { ru: 'НАГРУЗКА УЗЛА', en: 'NODE LOAD' },
  'settingOption.simulation.channel.node-temperature': {
    ru: 'ТЕМПЕРАТУРА УЗЛА',
    en: 'NODE TEMPERATURE',
  },
  'settingOption.simulation.channel.packet-loss': { ru: 'ПОТЕРЯ ПАКЕТОВ', en: 'PACKET LOSS' },
  'settingOption.simulation.channel.ram': { ru: 'ПАМЯТЬ', en: 'RAM' },
  'settingOption.simulation.channel.readiness': { ru: 'ГОТОВНОСТЬ', en: 'READINESS' },
  'settingOption.simulation.channel.sensor-signal': { ru: 'СИГНАЛ ДАТЧИКА', en: 'SENSOR SIGNAL' },
  'settingOption.simulation.channel.storage': { ru: 'ХРАНИЛИЩЕ', en: 'STORAGE' },
  'settingOption.simulation.interpolation.linear': { ru: 'ЛИНЕЙНАЯ', en: 'LINEAR' },
  'settingOption.simulation.interpolation.step': { ru: 'СТУПЕНЧАТАЯ', en: 'STEP' },
  'settingOption.simulation.interpolation.hermite': { ru: 'ЭРМИТОВА', en: 'HERMITE' },
  'settingOption.simulation.interpolation.bezier': { ru: 'БЕЗЬЕ', en: 'BEZIER' },
  'settingOption.groups.authority.leader': { ru: 'ЛИДЕР', en: 'LEADER' },
  'settingOption.groups.authority.multi-authority': {
    ru: 'НЕСКОЛЬКО АВТОРИТЕТОВ',
    en: 'MULTI-AUTHORITY',
  },
  'settingOption.materials.defaultCategory.video': { ru: 'ВИДЕО', en: 'VIDEO' },
  'settingOption.materials.defaultCategory.camera': { ru: 'КАМЕРА', en: 'CAMERA' },
  'settingOption.materials.defaultCategory.photo': { ru: 'ФОТО', en: 'PHOTO' },
  'settingOption.materials.defaultCategory.audio': { ru: 'АУДИО', en: 'AUDIO' },
  'settingOption.materials.defaultCategory.document': { ru: 'ДОКУМЕНТ', en: 'DOCUMENT' },
  'settingOption.materials.defaultCategory.map': { ru: 'КАРТА', en: 'MAP' },
  'settingOption.materials.defaultCategory.intercept': { ru: 'ПЕРЕХВАТ', en: 'INTERCEPT' },
  'settingOption.materials.defaultCategory.dossier': { ru: 'ДОСЬЕ', en: 'DOSSIER' },
  'settingOption.materials.defaultCategory.report': { ru: 'ОТЧЁТ', en: 'REPORT' },
  'settingOption.materials.defaultCategory.archive': { ru: 'АРХИВ', en: 'ARCHIVE' },
  'settingOption.materials.defaultCategory.technical': { ru: 'ТЕХНИЧЕСКОЕ', en: 'TECHNICAL' },
  'settingOption.materials.defaultCategory.other': { ru: 'ДРУГОЕ', en: 'OTHER' },
  'settingOption.titlebar.alignment.left': { ru: 'СЛЕВА', en: 'LEFT' },
  'settingOption.titlebar.alignment.center': { ru: 'ПО ЦЕНТРУ', en: 'CENTER' },
  'settingOption.titlebar.alignment.split': { ru: 'РАЗДЕЛЬНО', en: 'SPLIT' },
  'settingOption.titlebar.alignment.right': { ru: 'СПРАВА', en: 'RIGHT' },
  'settingOption.titlebar.information.route': { ru: 'МАРШРУТ', en: 'ROUTE' },
  'settingOption.titlebar.information.clock': { ru: 'ЧАСЫ', en: 'CLOCK' },
  'settingOption.titlebar.information.operation': { ru: 'ОПЕРАЦИЯ', en: 'OPERATION' },
  'settingOption.titlebar.information.connection': { ru: 'СОЕДИНЕНИЕ', en: 'CONNECTION' },
  'settingOption.titlebar.information.none': { ru: 'НЕТ', en: 'NONE' },
  'settingOption.titlebar.dragRegion.full': { ru: 'ВСЯ ПАНЕЛЬ', en: 'FULL' },
  'settingOption.titlebar.dragRegion.title': { ru: 'ТОЛЬКО ЗАГОЛОВОК', en: 'TITLE' },
  'settingOption.titlebar.dragRegion.none': { ru: 'НИЧЕГО', en: 'NONE' },
  'settingOption.diagnostics.verbosity.minimal': { ru: 'МИНИМАЛЬНАЯ', en: 'MINIMAL' },
  'settingOption.diagnostics.verbosity.standard': { ru: 'СТАНДАРТНАЯ', en: 'STANDARD' },
  'settingOption.diagnostics.verbosity.verbose': { ru: 'ПОДРОБНАЯ', en: 'VERBOSE' },
  'settingOption.github.changeFormat.list': { ru: 'СПИСОК', en: 'LIST' },
  'settingOption.github.changeFormat.checklist': { ru: 'ЧЕК-ЛИСТ', en: 'CHECKLIST' },
  'settingOption.typography.weight.regular': { ru: 'ОБЫЧНАЯ', en: 'REGULAR' },
  'settingOption.typography.weight.medium': { ru: 'СРЕДНЯЯ', en: 'MEDIUM' },
  'settingOption.typography.weight.bold': { ru: 'ЖИРНАЯ', en: 'BOLD' },
  'settingOption.typography.accentWeight.regular': { ru: 'ОБЫЧНАЯ', en: 'REGULAR' },
  'settingOption.typography.accentWeight.medium': { ru: 'СРЕДНЯЯ', en: 'MEDIUM' },
  'settingOption.typography.accentWeight.bold': { ru: 'ЖИРНАЯ', en: 'BOLD' },
  'settingOption.animations.easing.terminal': { ru: 'ТЕРМИНАЛЬНАЯ', en: 'TERMINAL' },
  'settingOption.animations.easing.linear': { ru: 'ЛИНЕЙНАЯ', en: 'LINEAR' },
  'settingOption.animations.easing.ease-out': { ru: 'ЗАМЕДЛЕНИЕ', en: 'EASE-OUT' },
  'settingOption.animations.easing.snap': { ru: 'РЕЗКАЯ', en: 'SNAP' },
  'settingOption.patterns.background.none': { ru: 'НЕТ', en: 'NONE' },
  'settingOption.patterns.background.grid': { ru: 'СЕТКА', en: 'GRID' },
  'settingOption.patterns.background.dots': { ru: 'ТОЧКИ', en: 'DOTS' },
  'settingOption.patterns.background.barber': { ru: 'ДИАГОНАЛЬНЫЙ', en: 'BARBER' },
  'settingOption.patterns.background.scanlines': { ru: 'СТРОЧНАЯ РАЗВЁРТКА', en: 'SCANLINES' },
  'settingOption.tables.density.comfortable': { ru: 'ПРОСТОРНАЯ', en: 'COMFORTABLE' },
  'settingOption.tables.density.compact': { ru: 'КОМПАКТНАЯ', en: 'COMPACT' },
} as const satisfies CatalogModule;
