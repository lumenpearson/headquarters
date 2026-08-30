import type { CatalogModule } from './catalogTypes';

/**
 * A label and a description for every setting the schema declares, plus the
 * two words `SchemaSetting` prints beside each row for its scope.
 *
 * `settingLabel.<id>` replaces `settingLabel()`'s id-surgery (`tiles.presentation`
 * -> `TILES / PRESENTATION`) for every one of the 169 definitions
 * `packages/settings-schema` currently declares; that function stays as the
 * last-resort fallback in `settingLocalization.ts` for an id this table has
 * not yet caught up with, the same shape `localizedEnumOptionLabel` already
 * falls back to `option.toUpperCase()` with.
 *
 * `settingDescription.<id>` covers every definition this table's companion,
 * `settingLocalization.ts`'s `settingDescriptionIds`, does not find already
 * covered by `settingsMessages.ts` (20 ids, from before this pass) -- so the
 * two files never carry the same id twice, which the catalogue's own
 * duplicate-id test would refuse to build.
 *
 * `settingScope.*` is the two-word vocabulary `definition.scope` draws from
 * (`device` or `group`); `SchemaSetting`'s detail line used to print the raw
 * English scope word uppercased on every row.
 */
export const settingLabelMessages = {
  'settingLabel.general.localOnly': { ru: 'ТОЛЬКО ЛОКАЛЬНО', en: 'LOCAL ONLY' },
  'settingLabel.general.brandTagline': { ru: 'СЛОГАН ОПЕРАЦИИ', en: 'OPERATION TAGLINE' },
  'settingLabel.general.secureLinkBadge': {
    ru: 'ЗНАЧОК ЗАЩИЩЁННОГО КАНАЛА',
    en: 'SECURE LINK BADGE',
  },
  'settingLabel.dateTime.showSeconds': { ru: 'ПОКАЗЫВАТЬ СЕКУНДЫ', en: 'SHOW SECONDS' },
  'settingLabel.dateTime.showModeLabel': { ru: 'ПОКАЗЫВАТЬ РЕЖИМ ЧАСОВ', en: 'SHOW CLOCK MODE' },
  'settingLabel.dateTime.showClockRate': { ru: 'ПОКАЗЫВАТЬ СКОРОСТЬ ЧАСОВ', en: 'SHOW CLOCK RATE' },
  'settingLabel.dateTime.showHeaderDate': { ru: 'ПОКАЗЫВАТЬ ДАТУ В ШАПКЕ', en: 'SHOW HEADER DATE' },
  'settingLabel.diagnostics.showTransportProbe': {
    ru: 'ПОКАЗЫВАТЬ ИНДИКАТОР ТРАНСПОРТА',
    en: 'SHOW TRANSPORT PROBE',
  },
  'settingLabel.diagnostics.showKeybindHints': {
    ru: 'ПОКАЗЫВАТЬ ПОДСКАЗКУ КЛАВИШ',
    en: 'SHOW KEYBIND HINT',
  },
  'settingLabel.information.showOperationalContext': {
    ru: 'ПОКАЗЫВАТЬ ОПЕРАТИВНЫЙ КОНТЕКСТ',
    en: 'SHOW OPERATIONAL CONTEXT',
  },
  'settingLabel.layout.density': { ru: 'ПЛОТНОСТЬ ЭКРАНА', en: 'SCREEN DENSITY' },
  'settingLabel.layout.settingsNavSide': {
    ru: 'СТОРОНА НАВИГАЦИИ НАСТРОЕК',
    en: 'SETTINGS NAV SIDE',
  },
  'settingLabel.tiles.hiddenIds': { ru: 'СКРЫТЫЕ ПЛИТКИ', en: 'HIDDEN TILES' },
  'settingLabel.tiles.order': { ru: 'ПОРЯДОК ПЛИТОК', en: 'TILE ORDER' },
  'settingLabel.tiles.spans': { ru: 'РАЗМЕРЫ ПЛИТОК', en: 'TILE SPANS' },
  'settingLabel.tiles.hiddenCategories': {
    ru: 'ОТКЛЮЧЁННЫЕ ГРУППЫ ПЛИТОК',
    en: 'HIDDEN TILE GROUPS',
  },
  'settingLabel.tiles.presentation': { ru: 'УРОВЕНЬ ДЕТАЛИЗАЦИИ ПЛИТКИ', en: 'TILE DETAIL LEVEL' },
  'settingLabel.themes.id': { ru: 'ЦВЕТОВАЯ ТЕМА', en: 'COLOR THEME' },
  'settingLabel.styles.panelCorners': { ru: 'УГЛОВЫЕ СКОБКИ ПАНЕЛИ', en: 'PANEL CORNER BRACKETS' },
  'settingLabel.styles.iconSet': { ru: 'НАБОР ИКОНОК', en: 'ICON SET' },
  'settingLabel.styles.cornerLength': { ru: 'ДЛИНА УГЛОВОЙ СКОБКИ', en: 'CORNER BRACKET LENGTH' },
  'settingLabel.styles.signalFieldOpacity': {
    ru: 'ПРОЗРАЧНОСТЬ ПОЛЯ СИГНАЛА',
    en: 'SIGNAL FIELD OPACITY',
  },
  'settingLabel.styles.frameRules': { ru: 'РАМОЧНЫЕ ЛИНИИ', en: 'FRAME RULES' },
  'settingLabel.styles.workspaceSeam': { ru: 'ЦЕНТРАЛЬНЫЙ ШОВ', en: 'WORKSPACE SEAM' },
  'settingLabel.themes.cameraSafeBrightness': {
    ru: 'ЯРКОСТЬ ЩАДЯЩЕГО РЕЖИМА',
    en: 'CAMERA-SAFE BRIGHTNESS',
  },
  'settingLabel.themes.cameraSafeContrast': {
    ru: 'КОНТРАСТ ЩАДЯЩЕГО РЕЖИМА',
    en: 'CAMERA-SAFE CONTRAST',
  },
  'settingLabel.themes.cameraSafeSaturation': {
    ru: 'НАСЫЩЕННОСТЬ ЩАДЯЩЕГО РЕЖИМА',
    en: 'CAMERA-SAFE SATURATION',
  },
  'settingLabel.themes.cameraSafeTokens': { ru: 'ЦВЕТА ЩАДЯЩЕГО РЕЖИМА', en: 'CAMERA-SAFE TOKENS' },
  'settingLabel.styles.mode': { ru: 'СТИЛЬ ОТОБРАЖЕНИЯ', en: 'PRESENTATION STYLE' },
  'settingLabel.colors.accent': { ru: 'АКЦЕНТНЫЙ ЦВЕТ', en: 'ACCENT COLOR' },
  'settingLabel.typography.scale': { ru: 'МАСШТАБ ШРИФТА', en: 'TYPOGRAPHY SCALE' },
  'settingLabel.sizes.scale': { ru: 'МАСШТАБ ЭЛЕМЕНТОВ', en: 'ELEMENT SCALE' },
  'settingLabel.backgrounds.kind': { ru: 'ФОН ПРИЛОЖЕНИЯ', en: 'APPLICATION BACKGROUND' },
  'settingLabel.backgrounds.imageSource': { ru: 'ИСТОЧНИК ИЗОБРАЖЕНИЯ', en: 'IMAGE SOURCE' },
  'settingLabel.backgrounds.videoSource': { ru: 'ИСТОЧНИК ВИДЕО', en: 'VIDEO SOURCE' },
  'settingLabel.patterns.focus': { ru: 'ПАТТЕРН ФОКУСА', en: 'FOCUS PATTERN' },
  'settingLabel.animations.enabled': { ru: 'ВКЛЮЧИТЬ АНИМАЦИЮ', en: 'ENABLE ANIMATION' },
  'settingLabel.animations.intensity': { ru: 'ИНТЕНСИВНОСТЬ АНИМАЦИИ', en: 'ANIMATION INTENSITY' },
  'settingLabel.startup.stageHold': { ru: 'ДЛИТЕЛЬНОСТЬ ЭТАПОВ ЗАПУСКА', en: 'STARTUP STAGE HOLD' },
  'settingLabel.startup.restoreWorld': { ru: 'ВОССТАНАВЛИВАТЬ СЕССИЮ', en: 'RESTORE SESSION' },
  'settingLabel.startup.productionPanel': {
    ru: 'ОТКРЫВАТЬ ПАНЕЛЬ РЕЖИССЁРА',
    en: 'OPEN PRODUCTION PANEL',
  },
  'settingLabel.keybinds.prefixWindow': { ru: 'ОКНО ПРЕФИКСА', en: 'PREFIX WINDOW' },
  'settingLabel.keybinds.firedHighlight': { ru: 'ПОДСВЕТКА СОЧЕТАНИЯ', en: 'FIRED HIGHLIGHT' },
  'settingLabel.keybinds.introOnLaunch': {
    ru: 'ПОДСКАЗКА ПРИ ПЕРВОМ ЗАПУСКЕ',
    en: 'INTRO ON LAUNCH',
  },
  'settingLabel.keybinds.hiddenCategories': {
    ru: 'СКРЫТЫЕ КАТЕГОРИИ КЛАВИШ',
    en: 'HIDDEN KEYBIND CATEGORIES',
  },
  'settingLabel.startup.enabled': { ru: 'ПОСЛЕДОВАТЕЛЬНОСТЬ ЗАПУСКА', en: 'STARTUP SEQUENCE' },
  'settingLabel.startup.launchOnLogin': { ru: 'ЗАПУСК ПРИ ВХОДЕ В СИСТЕМУ', en: 'LAUNCH ON LOGIN' },
  'settingLabel.startup.autoUpdate': { ru: 'АВТООБНОВЛЕНИЕ', en: 'AUTO UPDATE' },
  'settingLabel.layout.settingsLanding': {
    ru: 'ГЛАВНАЯ СТРАНИЦА НАСТРОЕК',
    en: 'SETTINGS LANDING',
  },
  'settingLabel.player.defaultRate': { ru: 'СКОРОСТЬ ВОСПРОИЗВЕДЕНИЯ', en: 'PLAYBACK RATE' },
  'settingLabel.player.startMuted': { ru: 'СТАРТ БЕЗ ЗВУКА', en: 'START MUTED' },
  'settingLabel.player.seekStep': { ru: 'ШАГ ПЕРЕМОТКИ', en: 'SEEK STEP' },
  'settingLabel.player.defaultVolume': { ru: 'ГРОМКОСТЬ ПО УМОЛЧАНИЮ', en: 'DEFAULT VOLUME' },
  'settingLabel.player.loopDemo': { ru: 'ЗАЦИКЛИВАТЬ ИСТОЧНИК', en: 'LOOP SOURCE' },
  'settingLabel.player.snapshotGrayscale': {
    ru: 'СНИМОК В ОТТЕНКАХ СЕРОГО',
    en: 'GRAYSCALE SNAPSHOT',
  },
  'settingLabel.player.controlsHideDelayMs': {
    ru: 'ЗАДЕРЖКА СКРЫТИЯ ЭЛЕМЕНТОВ',
    en: 'CONTROLS HIDE DELAY',
  },
  'settingLabel.cameras.gridDensity': { ru: 'ПЛОТНОСТЬ СЕТКИ КАМЕР', en: 'CAMERA GRID DENSITY' },
  'settingLabel.cameras.gridPageSize': { ru: 'РАЗМЕР СТРАНИЦЫ РЕЕСТРА', en: 'GRID PAGE SIZE' },
  'settingLabel.cameras.defaultFilter': {
    ru: 'ФИЛЬТР РЕЕСТРА КАМЕР',
    en: 'CAMERA REGISTRY FILTER',
  },
  'settingLabel.cameras.ptzStep': { ru: 'ШАГ PTZ', en: 'PTZ STEP' },
  'settingLabel.map.zoomStep': { ru: 'ШАГ МАСШТАБА КАРТЫ', en: 'MAP ZOOM STEP' },
  'settingLabel.map.resetZoom': { ru: 'МАСШТАБ ПРИ СБРОСЕ', en: 'RESET ZOOM LEVEL' },
  'settingLabel.map.shadeOpacity': { ru: 'ЗАТЕНЕНИЕ КАРТЫ', en: 'MAP SHADE OPACITY' },
  'settingLabel.map.alertRows': { ru: 'СТРОК ТРЕВОГ НА КАРТЕ', en: 'MAP ALERT ROWS' },
  'settingLabel.cameras.feedOverlay': { ru: 'НАЛОЖЕНИЕ ТЕЛЕМЕТРИИ', en: 'TELEMETRY OVERLAY' },
  'settingLabel.cameras.feedBrightness': { ru: 'ЯРКОСТЬ ПОТОКА', en: 'FEED BRIGHTNESS' },
  'settingLabel.map.mode': { ru: 'РЕЖИМ КАРТЫ', en: 'MAP MODE' },
  'settingLabel.tables.pageSize': { ru: 'РАЗМЕР СТРАНИЦЫ ТАБЛИЦЫ', en: 'TABLE PAGE SIZE' },
  'settingLabel.popups.longPressDelay': { ru: 'ЗАДЕРЖКА ДОЛГОГО НАЖАТИЯ', en: 'LONG PRESS DELAY' },
  'settingLabel.popups.fieldMenu': { ru: 'МЕНЮ ПОЛЯ ВВОДА', en: 'FIELD MENU' },
  'settingLabel.popups.drawerWidth': { ru: 'ШИРИНА ШТОРКИ', en: 'DRAWER WIDTH' },
  'settingLabel.popups.drawerScrim': { ru: 'ЗАТЕМНЕНИЕ ЗА ШТОРКОЙ', en: 'DRAWER SCRIM' },
  'settingLabel.popups.overlayBlur': { ru: 'РАЗМЫТИЕ ФОНА ОКНА', en: 'OVERLAY BLUR' },
  'settingLabel.materials.defaultSort': { ru: 'СОРТИРОВКА МАТЕРИАЛОВ', en: 'MATERIALS SORT' },
  'settingLabel.materials.rememberImportCategory': {
    ru: 'ЗАПОМИНАТЬ КАТЕГОРИЮ ИМПОРТА',
    en: 'REMEMBER IMPORT CATEGORY',
  },
  'settingLabel.materials.previewLimitMb': { ru: 'ПРЕДЕЛ ПРЕДПРОСМОТРА', en: 'PREVIEW SIZE LIMIT' },
  'settingLabel.materials.textPreviewLimitMb': {
    ru: 'ПРЕДЕЛ ПРЕДПРОСМОТРА ТЕКСТА',
    en: 'TEXT PREVIEW LIMIT',
  },
  'settingLabel.materials.autoplayPreview': { ru: 'АВТОВОСПРОИЗВЕДЕНИЕ', en: 'AUTOPLAY PREVIEW' },
  'settingLabel.materials.loopPreview': { ru: 'ЗАЦИКЛИВАТЬ ПРЕДПРОСМОТР', en: 'LOOP PREVIEW' },
  'settingLabel.materials.rememberPreviewPosition': {
    ru: 'ЗАПОМИНАТЬ ПОЗИЦИЮ',
    en: 'REMEMBER PREVIEW POSITION',
  },
  'settingLabel.performance.playbackLeadMs': {
    ru: 'УПРЕЖДЕНИЕ ВОСПРОИЗВЕДЕНИЯ',
    en: 'PLAYBACK LEAD',
  },
  'settingLabel.performance.streamRetryBackoff': {
    ru: 'ПОВТОР ПОТЕРЯННОГО ПОТОКА',
    en: 'STREAM RETRY BACKOFF',
  },
  'settingLabel.popups.longPress': { ru: 'ДОЛГОЕ НАЖАТИЕ', en: 'LONG PRESS' },
  'settingLabel.keybinds.scheme': { ru: 'СХЕМА КЛАВИШ', en: 'KEYBIND SCHEME' },
  'settingLabel.localization.locale': { ru: 'ЯЗЫК ПРИЛОЖЕНИЯ', en: 'APPLICATION LOCALE' },
  'settingLabel.localization.elementOverrides': { ru: 'ПОДПИСИ ЭЛЕМЕНТОВ', en: 'ELEMENT CAPTIONS' },
  'settingLabel.dateTime.mode': { ru: 'РЕЖИМ ЧАСОВ', en: 'CLOCK MODE' },
  'settingLabel.telemetry.loadWarningPercent': {
    ru: 'ПОРОГ ПРЕДУПРЕЖДЕНИЯ НАГРУЗКИ',
    en: 'LOAD WARNING THRESHOLD',
  },
  'settingLabel.telemetry.nodeTemperatureLimit': {
    ru: 'ПОРОГ ТЕМПЕРАТУРЫ УЗЛА',
    en: 'NODE TEMPERATURE LIMIT',
  },
  'settingLabel.telemetry.signalFloorPercent': { ru: 'ПОРОГ СИГНАЛА КАНАЛА', en: 'SIGNAL FLOOR' },
  'settingLabel.telemetry.showCharts': { ru: 'ГРАФИКИ РЕСУРСОВ', en: 'SHOW RESOURCE CHARTS' },
  'settingLabel.diagnostics.auditRows': { ru: 'СТРОК ЖУРНАЛА АУДИТА', en: 'AUDIT LOG ROWS' },
  'settingLabel.general.hiddenRoutes': { ru: 'СКРЫТЫЕ РАЗДЕЛЫ', en: 'HIDDEN ROUTES' },
  'settingLabel.telemetry.source': { ru: 'ИСТОЧНИК ТЕЛЕМЕТРИИ', en: 'TELEMETRY SOURCE' },
  'settingLabel.simulation.preset': { ru: 'ПРЕСЕТ СИМУЛЯЦИИ', en: 'SIMULATION PRESET' },
  'settingLabel.simulation.channel': { ru: 'КАНАЛ СИМУЛЯЦИИ', en: 'SIMULATION CHANNEL' },
  'settingLabel.simulation.valueCurve': { ru: 'КРИВАЯ ЗНАЧЕНИЙ', en: 'VALUE CURVE' },
  'settingLabel.simulation.criticalityCurve': { ru: 'КРИВАЯ КРИТИЧНОСТИ', en: 'CRITICALITY CURVE' },
  'settingLabel.simulation.interpolation': { ru: 'ИНТЕРПОЛЯЦИЯ', en: 'INTERPOLATION' },
  'settingLabel.simulation.loop': { ru: 'ЗАЦИКЛИВАТЬ КРИВЫЕ', en: 'LOOP CURVES' },
  'settingLabel.simulation.periodSeconds': { ru: 'ПЕРИОД КРИВЫХ', en: 'CURVE PERIOD' },
  'settingLabel.simulation.updateIntervalMs': { ru: 'ИНТЕРВАЛ ОБНОВЛЕНИЯ', en: 'UPDATE INTERVAL' },
  'settingLabel.simulation.timeScale': { ru: 'МАСШТАБ ВРЕМЕНИ', en: 'TIME SCALE' },
  'settingLabel.simulation.noise': { ru: 'ШУМ', en: 'NOISE' },
  'settingLabel.simulation.smoothing': { ru: 'СГЛАЖИВАНИЕ', en: 'SMOOTHING' },
  'settingLabel.simulation.seed': { ru: 'СЕМЯ ШУМА', en: 'NOISE SEED' },
  'settingLabel.groups.authority': { ru: 'СТРАТЕГИЯ АВТОРИТЕТА', en: 'SESSION AUTHORITY' },
  'settingLabel.materials.defaultCategory': {
    ru: 'КАТЕГОРИЯ ПО УМОЛЧАНИЮ',
    en: 'DEFAULT CATEGORY',
  },
  'settingLabel.titlebar.alignment': { ru: 'ВЫРАВНИВАНИЕ ШАПКИ', en: 'TITLEBAR ALIGNMENT' },
  'settingLabel.titlebar.elements': { ru: 'ЭЛЕМЕНТЫ ВЕРХНЕЙ ПАНЕЛИ', en: 'TITLEBAR ELEMENTS' },
  'settingLabel.titlebar.information': {
    ru: 'ИНФОРМАЦИОННЫЙ СЛОТ ШАПКИ',
    en: 'TITLEBAR INFORMATION',
  },
  'settingLabel.statusline.elements': { ru: 'ЭЛЕМЕНТЫ НИЖНЕЙ ПАНЕЛИ', en: 'STATUS LINE ELEMENTS' },
  'settingLabel.titlebar.dragRegion': { ru: 'ОБЛАСТЬ ПЕРЕТАСКИВАНИЯ', en: 'DRAG REGION' },
  'settingLabel.accessibility.reducedMotion': { ru: 'УМЕНЬШЕННОЕ ДВИЖЕНИЕ', en: 'REDUCED MOTION' },
  'settingLabel.performance.inactiveDecode': {
    ru: 'ОСТАНОВКА НЕВИДИМЫХ ПОТОКОВ',
    en: 'STOP INACTIVE DECODE',
  },
  'settingLabel.performance.webcamResolution': {
    ru: 'РАЗРЕШЕНИЕ ВЕБ-КАМЕРЫ',
    en: 'WEBCAM RESOLUTION',
  },
  'settingLabel.performance.webcamFrameRate': {
    ru: 'ЧАСТОТА КАДРОВ ВЕБ-КАМЕРЫ',
    en: 'WEBCAM FRAME RATE',
  },
  'settingLabel.privacy.copyDiagnostics': { ru: 'КОПИРОВАНИЕ ДИАГНОСТИКИ', en: 'COPY DIAGNOSTICS' },
  'settingLabel.privacy.webcamCapture': { ru: 'ЗАХВАТ С ВЕБ-КАМЕРЫ', en: 'WEBCAM CAPTURE' },
  'settingLabel.privacy.frameCapture': { ru: 'ЗАПИСЬ КАДРА НА ДИСК', en: 'FRAME CAPTURE' },
  'settingLabel.diagnostics.verbosity': {
    ru: 'ПОДРОБНОСТЬ ДИАГНОСТИКИ',
    en: 'DIAGNOSTIC VERBOSITY',
  },
  'settingLabel.github.draftOnly': { ru: 'ТОЛЬКО ЧЕРНОВИКИ', en: 'DRAFT ONLY' },
  'settingLabel.advanced.undoDepth': { ru: 'ГЛУБИНА ОТМЕНЫ', en: 'UNDO DEPTH' },
  'settingLabel.advanced.historyDepth': { ru: 'ГЛУБИНА ИСТОРИИ НАСТРОЕК', en: 'HISTORY DEPTH' },
  'settingLabel.advanced.demoRotationSeconds': {
    ru: 'ДЛИТЕЛЬНОСТЬ ДЕМО-ЦИКЛА',
    en: 'DEMO ROTATION',
  },
  'settingLabel.advanced.worldSync': { ru: 'СИНХРОНИЗАЦИЯ МИРА', en: 'WORLD SYNC' },
  'settingLabel.github.includeDescriptions': {
    ru: 'ОПИСАНИЯ НАСТРОЕК В ЧЕРНОВИКЕ',
    en: 'INCLUDE DESCRIPTIONS',
  },
  'settingLabel.github.includeBaseRevision': {
    ru: 'БАЗОВАЯ РЕВИЗИЯ В ЧЕРНОВИКЕ',
    en: 'INCLUDE BASE REVISION',
  },
  'settingLabel.github.changeFormat': { ru: 'ФОРМАТ ИЗМЕНЕНИЙ', en: 'CHANGE FORMAT' },
  'settingLabel.github.attachDiagnostics': {
    ru: 'ПРИКЛАДЫВАТЬ ДИАГНОСТИКУ',
    en: 'ATTACH DIAGNOSTICS',
  },
  'settingLabel.privacy.diagnosticsRecordCounts': {
    ru: 'СЧЁТЧИКИ ЗАПИСЕЙ В ОТЧЁТЕ',
    en: 'DIAGNOSTICS RECORD COUNTS',
  },
  'settingLabel.privacy.diagnosticsSettingIds': {
    ru: 'ИМЕНА НАСТРОЕК В ОТЧЁТЕ',
    en: 'DIAGNOSTICS SETTING IDS',
  },
  'settingLabel.privacy.persistAudit': { ru: 'ХРАНИТЬ ЖУРНАЛ АУДИТА', en: 'PERSIST AUDIT TRAIL' },
  'settingLabel.advanced.liveEdit': { ru: 'СИНХРОННОЕ РЕДАКТИРОВАНИЕ', en: 'LIVE EDIT' },
  'settingLabel.sizes.panelHeader': { ru: 'ВЫСОТА ЗАГОЛОВКА ПАНЕЛИ', en: 'PANEL HEADER HEIGHT' },
  'settingLabel.sizes.panelPadding': { ru: 'ВНУТРЕННИЙ ОТСТУП ПАНЕЛИ', en: 'PANEL PADDING' },
  'settingLabel.sizes.tileGap': { ru: 'ЗАЗОР МЕЖДУ ПЛИТКАМИ', en: 'TILE GAP' },
  'settingLabel.sizes.contentGap': { ru: 'ЗАЗОР МЕЖДУ БЛОКАМИ', en: 'CONTENT GAP' },
  'settingLabel.sizes.borderWidth': { ru: 'ТОЛЩИНА РАМКИ', en: 'BORDER WIDTH' },
  'settingLabel.sizes.controlHeight': { ru: 'ВЫСОТА ЭЛЕМЕНТА УПРАВЛЕНИЯ', en: 'CONTROL HEIGHT' },
  'settingLabel.typography.letterSpacing': { ru: 'МЕЖБУКВЕННЫЙ ИНТЕРВАЛ', en: 'LETTER SPACING' },
  'settingLabel.typography.lineHeight': { ru: 'ВЫСОТА СТРОКИ', en: 'LINE HEIGHT' },
  'settingLabel.typography.weight': { ru: 'НАСЫЩЕННОСТЬ ШРИФТА', en: 'TEXT WEIGHT' },
  'settingLabel.typography.accentWeight': { ru: 'НАСЫЩЕННОСТЬ АКЦЕНТА', en: 'ACCENT WEIGHT' },
  'settingLabel.colors.panelOpacity': { ru: 'НЕПРОЗРАЧНОСТЬ ПАНЕЛИ', en: 'PANEL OPACITY' },
  'settingLabel.colors.lineOpacity': { ru: 'НЕПРОЗРАЧНОСТЬ ЛИНИЙ', en: 'LINE OPACITY' },
  'settingLabel.animations.easing': { ru: 'ФУНКЦИЯ СГЛАЖИВАНИЯ', en: 'EASING' },
  'settingLabel.animations.tileEnter': {
    ru: 'АНИМИРОВАТЬ ПОЯВЛЕНИЕ ПЛИТКИ',
    en: 'ANIMATE TILE ENTER',
  },
  'settingLabel.animations.panelHover': {
    ru: 'АНИМИРОВАТЬ ПАНЕЛЬ ПРИ НАВЕДЕНИИ',
    en: 'ANIMATE PANEL HOVER',
  },
  'settingLabel.animations.backgroundMotion': { ru: 'ДВИЖЕНИЕ ФОНА', en: 'BACKGROUND MOTION' },
  'settingLabel.patterns.background': { ru: 'ПАТТЕРН ФОНА', en: 'BACKGROUND PATTERN' },
  'settingLabel.patterns.opacity': { ru: 'НЕПРОЗРАЧНОСТЬ ПАТТЕРНА', en: 'PATTERN OPACITY' },
  'settingLabel.patterns.scale': { ru: 'МАСШТАБ ПАТТЕРНА', en: 'PATTERN SCALE' },
  'settingLabel.backgrounds.overlayOpacity': {
    ru: 'НЕПРОЗРАЧНОСТЬ ЗАТЕМНЕНИЯ',
    en: 'BACKGROUND OVERLAY OPACITY',
  },
  'settingLabel.backgrounds.blur': { ru: 'РАЗМЫТИЕ ФОНА', en: 'BACKGROUND BLUR' },
  'settingLabel.backgrounds.motionSpeed': { ru: 'СКОРОСТЬ ФОНА', en: 'BACKGROUND MOTION SPEED' },
  'settingLabel.tables.density': { ru: 'ПЛОТНОСТЬ ТАБЛИЦЫ', en: 'TABLE DENSITY' },
  'settingLabel.tables.zebra': { ru: 'ПОЛОСАТАЯ ЗАЛИВКА', en: 'ZEBRA STRIPES' },
  'settingLabel.tables.stickyHeader': { ru: 'ЗАКРЕПЛЁННЫЙ ЗАГОЛОВОК', en: 'STICKY HEADER' },
  'settingLabel.accessibility.focusRingWidth': {
    ru: 'ТОЛЩИНА КОНТУРА ФОКУСА',
    en: 'FOCUS RING WIDTH',
  },
  'settingLabel.accessibility.tapPadding': {
    ru: 'ДОПОЛНИТЕЛЬНЫЙ ОТСТУП КАСАНИЯ',
    en: 'TAP PADDING',
  },
  'settingLabel.accessibility.underlineLinks': { ru: 'ПОДЧЁРКИВАТЬ ССЫЛКИ', en: 'UNDERLINE LINKS' },
  'settingLabel.information.showSessionMetadata': {
    ru: 'ПОКАЗЫВАТЬ ДАННЫЕ СЕССИИ',
    en: 'SHOW SESSION METADATA',
  },
  'settingLabel.information.showAsciiField': {
    ru: 'ПОЛЕ СИГНАЛА НА ФОНЕ',
    en: 'SIGNAL FIELD BACKDROP',
  },
  'settingLabel.tiles.animations': { ru: 'АНИМАЦИЯ ПОЯВЛЕНИЯ ПЛИТОК', en: 'TILE ENTER ANIMATION' },
  'settingLabel.tiles.categoryAnimations': {
    ru: 'АНИМАЦИЯ ПО ГРУППАМ ПЛИТОК',
    en: 'TILE GROUP ANIMATION',
  },
  'settingLabel.layout.tileMinimumWidth': {
    ru: 'МИНИМАЛЬНАЯ ШИРИНА ПЛИТКИ',
    en: 'TILE MINIMUM WIDTH',
  },
  'settingLabel.tiles.presentationOverrides': {
    ru: 'ПОДРОБНОСТЬ ПО ПЛИТКАМ',
    en: 'TILE PRESENTATION OVERRIDES',
  },
  'settingLabel.tiles.categoryPresentation': {
    ru: 'ПОДРОБНОСТЬ ПО ГРУППАМ ПЛИТОК',
    en: 'TILE GROUP PRESENTATION',
  },

  'settingDescription.layout.density': {
    ru: 'Заготовленный профиль плотности экрана.',
    en: 'Screen density preset.',
  },
  'settingDescription.layout.settingsNavSide': {
    ru: 'На какой стороне экрана настроек расположена навигация по разделам.',
    en: 'Which side of the settings screen holds its section navigation.',
  },
  'settingDescription.tiles.hiddenIds': {
    ru: 'Плитки, скрытые оператором, в виде `экран:плитка` -- `registry` встречается на четырёх экранах.',
    en: 'Tiles hidden by the operator, as `screen:tile` -- `registry` exists on four screens.',
  },
  'settingDescription.tiles.order': {
    ru: 'Плитки в порядке, заданном оператором, в виде `экран:плитка`, от самой подробной.',
    en: 'Tiles in the order the operator arranged them, as `screen:tile`, richest first.',
  },
  'settingDescription.tiles.spans': {
    ru: 'Размеры плиток, заданные оператором, в виде записей `экран:плитка=колонкиXстроки`.',
    en: 'Tile sizes the operator set, as `screen:tile=columnsXrows` entries.',
  },
  'settingDescription.tiles.hiddenCategories': {
    ru: 'Группы плиток, отключённые оператором: сводка, реестры, карточки, навигация, телеметрия, события, география.',
    en: 'Tile groups the operator switched off: summary, records, detail, navigation, telemetry, events, geo.',
  },
  'settingDescription.themes.id': {
    ru: 'Активная цветовая тема терминала.',
    en: 'Active terminal color theme.',
  },
  'settingDescription.styles.panelCorners': {
    ru: 'Когда панель показывает угловые скобки.',
    en: 'When a panel shows its corner brackets.',
  },
  'settingDescription.styles.iconSet': {
    ru: 'Какая библиотека рисует иконки интерфейса.',
    en: "Which library draws the shell's icons.",
  },
  'settingDescription.styles.cornerLength': {
    ru: 'Длина угловой скобки панели, в пикселях.',
    en: "Length of a panel's corner bracket, in pixels.",
  },
  'settingDescription.styles.signalFieldOpacity': {
    ru: 'Непрозрачность поля сигнала, рисуемого на фоне интерфейса.',
    en: 'Opacity of the signal field drawn behind the shell.',
  },
  'settingDescription.styles.frameRules': {
    ru: 'Рисовать вертикальные линии, ограничивающие ширину содержимого интерфейса.',
    en: "Draw the vertical rules that bound the shell's content width.",
  },
  'settingDescription.styles.workspaceSeam': {
    ru: 'Рисовать центральный шов вдоль рабочей области.',
    en: 'Draw the centre seam down the work area.',
  },
  'settingDescription.themes.cameraSafeBrightness': {
    ru: 'Яркость режима, безопасного для съёмки камерой, как коэффициент.',
    en: 'Brightness of the camera-safe grade, as a multiplier.',
  },
  'settingDescription.themes.cameraSafeContrast': {
    ru: 'Контраст режима, безопасного для съёмки камерой, как коэффициент.',
    en: 'Contrast of the camera-safe grade, as a multiplier.',
  },
  'settingDescription.themes.cameraSafeSaturation': {
    ru: 'Насыщенность режима, безопасного для съёмки камерой, как коэффициент.',
    en: 'Saturation of the camera-safe grade, as a multiplier.',
  },
  'settingDescription.themes.cameraSafeTokens': {
    ru: 'Разрешить режиму, безопасному для съёмки камерой, переопределять цвета текста и акцента темы.',
    en: "Let camera-safe mode override the theme's text and accent tokens.",
  },
  'settingDescription.styles.mode': {
    ru: 'Стиль отображения терминала.',
    en: 'Terminal presentation style.',
  },
  'settingDescription.colors.accent': {
    ru: 'Семейство акцентных цветовых токенов; никогда не произвольный CSS.',
    en: 'Accent token family, never arbitrary CSS.',
  },
  'settingDescription.typography.scale': {
    ru: 'Масштаб шрифта относительно выбранной плотности.',
    en: 'Typography scale relative to the selected density.',
  },
  'settingDescription.sizes.scale': {
    ru: 'Масштаб плиток и элементов управления в безопасных пределах макета.',
    en: 'Tile and control scale within safe layout bounds.',
  },
  'settingDescription.backgrounds.kind': {
    ru: 'Слой фона приложения.',
    en: 'Application background layer.',
  },
  'settingDescription.backgrounds.imageSource': {
    ru: 'Материал, показываемый фоном «изображение». Пусто -- материал не выбран.',
    en: 'Material shown by the `image` background. Empty means no material chosen.',
  },
  'settingDescription.backgrounds.videoSource': {
    ru: 'Материал, воспроизводимый фоном «видео». Пусто -- материал не выбран.',
    en: 'Material played by the `video` background. Empty means no material chosen.',
  },
  'settingDescription.patterns.focus': {
    ru: 'Терминальный паттерн элемента в фокусе.',
    en: 'Focused-element terminal pattern.',
  },
  'settingDescription.animations.enabled': {
    ru: 'Разрешить движение в пределах, допустимых настройками доступности.',
    en: 'Enable motion allowed by accessibility settings.',
  },
  'settingDescription.animations.intensity': {
    ru: 'Общая интенсивность анимации.',
    en: 'Global animation intensity.',
  },
  'settingDescription.startup.stageHold': {
    ru: 'Коэффициент длительности удержания каждого этапа последовательности запуска.',
    en: 'Multiplier on how long the startup sequence holds each stage.',
  },
  'settingDescription.startup.restoreWorld': {
    ru: 'Восстанавливать тревоги, задачи и журнал аудита из прошлой сессии.',
    en: 'Restore alerts, tasks and the audit trail from the last session.',
  },
  'settingDescription.startup.productionPanel': {
    ru: 'Открывать панель режиссёра при запуске приложения.',
    en: 'Open the production panel when the application starts.',
  },
  'settingDescription.keybinds.prefixWindow': {
    ru: 'Сколько префиксная клавиша ждёт клавишу, завершающую сочетание, в миллисекундах.',
    en: 'How long a prefix key waits for the key that completes it, in milliseconds.',
  },
  'settingDescription.keybinds.firedHighlight': {
    ru: 'Сколько сработавшее сочетание остаётся подсвеченным в списке, в миллисекундах.',
    en: 'How long a fired chord stays highlighted in the list, in milliseconds.',
  },
  'settingDescription.keybinds.introOnLaunch': {
    ru: 'Предлагать карточку сочетаний клавиш при первом запуске.',
    en: 'Offer the keybind card on a first launch.',
  },
  'settingDescription.keybinds.hiddenCategories': {
    ru: 'Категории сочетаний клавиш, скрытые из списка, по идентификатору.',
    en: 'Keybind categories hidden from the list, by identifier.',
  },
  'settingDescription.startup.enabled': {
    ru: 'Показывать оптимизированную последовательность запуска.',
    en: 'Show the optimized startup sequence.',
  },
  'settingDescription.player.defaultRate': {
    ru: 'Скорость воспроизведения медиа по умолчанию.',
    en: 'Default media playback speed.',
  },
  'settingDescription.player.startMuted': {
    ru: 'Запускать поток камеры без звука.',
    en: 'Start a camera feed muted.',
  },
  'settingDescription.player.seekStep': {
    ru: 'На сколько секунд одно нажатие перемотки сдвигает воспроизведение.',
    en: 'Seconds one press of a skip control moves playback.',
  },
  'settingDescription.player.defaultVolume': {
    ru: 'Громкость, с которой начинает воспроизводить медиа, в процентах.',
    en: 'Volume a media surface starts at, as a percentage.',
  },
  'settingDescription.player.loopDemo': {
    ru: 'Повторять конечный источник камеры по достижении конца.',
    en: 'Repeat a finite camera source when it reaches its end.',
  },
  'settingDescription.player.snapshotGrayscale': {
    ru: 'Сохранять снимок в оттенках серого, как отрисован поток.',
    en: 'Write a snapshot in grayscale, as the feed is drawn.',
  },
  'settingDescription.cameras.gridDensity': {
    ru: 'Режим отображения сетки камер.',
    en: 'Camera-grid presentation mode.',
  },
  'settingDescription.cameras.gridPageSize': {
    ru: 'Сколько миниатюр камер вмещает одна страница реестра.',
    en: 'Number of camera thumbnails one page of the registry holds.',
  },
  'settingDescription.cameras.defaultFilter': {
    ru: 'Фильтр реестра камер, с которым открывается видеоэкран.',
    en: 'Camera-registry filter a video screen opens with.',
  },
  'settingDescription.cameras.ptzStep': {
    ru: 'На сколько градусов панорамирования или наклона сдвигает одно нажатие площадки PTZ.',
    en: 'Degrees of pan or tilt one press of the PTZ pad applies.',
  },
  'settingDescription.map.zoomStep': {
    ru: 'На сколько уровней масштаба сдвигает одно нажатие управления масштабом карты.',
    en: 'Zoom levels one press of the map zoom control moves.',
  },
  'settingDescription.map.resetZoom': {
    ru: 'Уровень масштаба, к которому возвращается карта при сбросе.',
    en: 'Zoom level the map returns to on reset.',
  },
  'settingDescription.map.shadeOpacity': {
    ru: 'Непрозрачность терминальной заливки поверх карты.',
    en: 'Opacity of the terminal shade drawn over the map.',
  },
  'settingDescription.map.alertRows': {
    ru: 'Сколько тревог перечисляет плитка тревог карты, прежде чем остановиться.',
    en: 'Alerts the map alert tile lists before it stops.',
  },
  'settingDescription.cameras.feedOverlay': {
    ru: 'Рисовать наложение телеметрии камеры поверх прямого эфира.',
    en: 'Draw the camera telemetry overlay over the live feed.',
  },
  'settingDescription.cameras.feedBrightness': {
    ru: 'Яркость, с которой отрисовывается видеопоток, как коэффициент.',
    en: 'Brightness the video feed is drawn at, as a multiplier.',
  },
  'settingDescription.map.mode': {
    ru: 'Начальное представление карты.',
    en: 'Initial map representation.',
  },
  'settingDescription.tables.pageSize': {
    ru: 'Размер страницы виртуализированной таблицы.',
    en: 'Virtualized table page size.',
  },
  'settingDescription.popups.longPressDelay': {
    ru: 'Сколько удерживать нажатие, прежде чем откроется меню, в миллисекундах.',
    en: 'How long a press is held before it opens a menu, in milliseconds.',
  },
  'settingDescription.popups.fieldMenu': {
    ru: 'Какое меню открывает щелчок правой кнопкой внутри текстового поля.',
    en: 'Which menu a right click inside a text field opens.',
  },
  'settingDescription.popups.drawerWidth': {
    ru: 'Насколько широко открывается шторка.',
    en: 'How wide a drawer opens.',
  },
  'settingDescription.popups.drawerScrim': {
    ru: 'Насколько подложка за шторкой затемняет экран.',
    en: 'How much the scrim behind a drawer dims the screen.',
  },
  'settingDescription.materials.defaultSort': {
    ru: 'Как сортируется список материалов при открытии экрана.',
    en: 'How the material list is sorted when a screen opens.',
  },
  'settingDescription.materials.rememberImportCategory': {
    ru: 'Сохранять последнюю выбранную категорию импорта вместо сброса.',
    en: 'Keep the last chosen import category instead of resetting it.',
  },
  'settingDescription.materials.previewLimitMb': {
    ru: 'Наибольший двоичный материал, который просматривается на месте, в мебибайтах.',
    en: 'Largest binary material previewed in place, in mebibytes.',
  },
  'settingDescription.materials.textPreviewLimitMb': {
    ru: 'Наибольший текстовый материал, который просматривается на месте, в мебибайтах.',
    en: 'Largest text material previewed in place, in mebibytes.',
  },
  'settingDescription.performance.playbackLeadMs': {
    ru: 'На сколько заранее планируется синхронизированная команда воспроизведения, в миллисекундах.',
    en: 'How far ahead a synchronised playback command is scheduled, in milliseconds.',
  },
  'settingDescription.performance.streamRetryBackoff': {
    ru: 'Насколько терпеливо повторяется попытка восстановить потерянный поток камеры.',
    en: 'How patiently a lost camera stream is retried.',
  },
  'settingDescription.popups.longPress': {
    ru: 'Включить контекстные действия по долгому нажатию.',
    en: 'Enable long-press contextual actions.',
  },
  'settingDescription.keybinds.scheme': {
    ru: 'Именованный набор сочетаний клавиш.',
    en: 'Named keybind collection.',
  },
  'settingDescription.localization.locale': { ru: 'Язык приложения.', en: 'Application locale.' },
  'settingDescription.localization.elementOverrides': {
    ru: 'Подписи, написанные оператором для отдельных элементов, в виде записей `язык:экран:элемент=текст`, где текст в percent-encoding.',
    en: 'Captions the operator wrote for individual elements, as `locale:screen:element=text` entries with the text percent-encoded.',
  },
  'settingDescription.telemetry.loadWarningPercent': {
    ru: 'Загрузка процессора и памяти, которая считается предупреждением, в процентах.',
    en: 'Processor and memory load that counts as a warning, as a percentage.',
  },
  'settingDescription.telemetry.nodeTemperatureLimit': {
    ru: 'Температура узла, которая считается критической, в градусах.',
    en: 'Node temperature that counts as critical, in degrees.',
  },
  'settingDescription.telemetry.signalFloorPercent': {
    ru: 'Уровень сигнала канала, ниже которого шкала читается как критическая, в процентах.',
    en: 'Channel signal below which a bar reads as critical, as a percentage.',
  },
  'settingDescription.telemetry.showCharts': {
    ru: 'Рисовать мини-графики ресурсов на экране системы.',
    en: 'Draw the resource sparklines on the system screen.',
  },
  'settingDescription.diagnostics.auditRows': {
    ru: 'Сколько записей журнала аудита показывается при полном виде плитки.',
    en: 'Audit entries the journal lists at full presentation.',
  },
  'settingDescription.general.hiddenRoutes': {
    ru: 'Разделы навигационной панели, скрытые оператором, по идентификатору.',
    en: 'Routes hidden from the navigation rail, by identifier.',
  },
  'settingDescription.telemetry.source': {
    ru: 'Выбор источника телеметрии.',
    en: 'Telemetry source selection.',
  },
  'settingDescription.simulation.preset': {
    ru: 'Отмеченный пресет симуляции.',
    en: 'Marked simulation preset.',
  },
  'settingDescription.simulation.channel': {
    ru: 'Канал, чьи две кривые показывает редактор; у остальных сохраняются уже нарисованные точки.',
    en: 'Channel whose two curves the editor shows; the others keep the points already drawn for them.',
  },
  'settingDescription.simulation.valueCurve': {
    ru: 'Показание по каждому каналу за один период, в виде записи `канал=время,значение,вход_касательной,выход_касательной`; значение -- это процент от диапазона канала, поэтому одна кривая читается одинаково для любого канала.',
    en: 'Reading per channel over one period, as `channel=time,value,inTangent,outTangent`; the value is a percentage of that channel’s own range, so one curve reads the same on every channel.',
  },
  'settingDescription.simulation.criticalityCurve': {
    ru: 'Критичность по каждому каналу на той же временной шкале, в том же формате записи. Она задаёт полосу серьёзности и ограничивает, насколько высоко может подняться показание в пределах диапазона канала.',
    en: 'Criticality per channel on the same timeline, in the same entry form. It sets the severity band and caps how high a reading may climb within the channel’s range.',
  },
  'settingDescription.simulation.interpolation': {
    ru: 'Как обе кривые читаются между точками.',
    en: 'How both curves are read between their points.',
  },
  'settingDescription.simulation.loop': {
    ru: 'Повторять обе кривые по их собственному промежутку вместо удержания конечных точек.',
    en: 'Repeat both curves over their own span instead of holding their end points.',
  },
  'settingDescription.simulation.periodSeconds': {
    ru: 'Сколько длится один проход кривых, в секундах. Ограничен так же, как `TelemetryService` ограничивает `period_seconds`.',
    en: 'How long one pass of the curves takes, in seconds. Bounded as `TelemetryService` bounds `period_seconds`.',
  },
  'settingDescription.simulation.updateIntervalMs': {
    ru: 'Как часто берётся новое показание, в миллисекундах. Ограничен так же, как `TelemetryService` ограничивает `update_interval_ms`.',
    en: 'How often a new reading is taken, in milliseconds. Bounded as `TelemetryService` bounds `update_interval_ms`.',
  },
  'settingDescription.simulation.timeScale': {
    ru: 'Насколько быстро временная шкала кривой идёт относительно часов. Ограничен так же, как `TelemetryService` ограничивает `time_scale`.',
    en: 'How fast the curve timeline runs against the clock. Bounded as `TelemetryService` bounds `time_scale`.',
  },
  'settingDescription.simulation.noise': {
    ru: 'Разброс, добавляемый вокруг кривой, как доля диапазона канала.',
    en: 'Scatter added around the curve, as a fraction of the channel range.',
  },
  'settingDescription.simulation.smoothing': {
    ru: 'Вес предыдущего показания; 0 -- точно следует кривой, 1 -- никогда не меняется.',
    en: 'Weight the previous reading keeps; 0 follows the curve exactly and 1 never moves.',
  },
  'settingDescription.simulation.seed': {
    ru: 'Семя разброса, чтобы один профиль давал одинаковый ряд на любой машине.',
    en: 'Seed of the scatter, so one profile produces the same series on every machine.',
  },
  'settingDescription.groups.authority': {
    ru: 'Стратегия авторитета сессии.',
    en: 'Session authority strategy.',
  },
  'settingDescription.materials.defaultCategory': {
    ru: 'Категория по умолчанию для импортированных файлов.',
    en: 'Default category for imported files.',
  },
  'settingDescription.titlebar.alignment': {
    ru: 'Выравнивание информации в верхней панели.',
    en: 'Titlebar information alignment.',
  },
  'settingDescription.titlebar.elements': {
    ru: 'Элементы верхней панели, сохранённые оператором, в порядке отрисовки: заголовок, информация, свернуть, развернуть, закрыть.',
    en: 'Titlebar elements the operator kept, in the order drawn: title, information, minimize, maximize, close.',
  },
  'settingDescription.titlebar.information': {
    ru: 'Что показывает информационный слот верхней панели.',
    en: 'What the titlebar information slot reports.',
  },
  'settingDescription.statusline.elements': {
    ru: 'Элементы нижней панели, сохранённые оператором, в порядке отрисовки: система, маршрут, процессор, память, сеть, транспорт, тревоги, кодирование, часы, подсказки.',
    en: 'Status line elements the operator kept, in the order drawn: system, route, cpu, ram, net, probe, alerts, encoding, clock, hints.',
  },
  'settingDescription.titlebar.dragRegion': {
    ru: 'Какая часть верхней панели перетаскивает окно: вся панель, только заголовок или ничего.',
    en: 'How much of the titlebar drags the window: the whole bar, the title alone, or nothing.',
  },
  'settingDescription.accessibility.reducedMotion': {
    ru: 'Принудительно уменьшать движение независимо от системной настройки.',
    en: 'Force reduced motion independently of system preference.',
  },
  'settingDescription.performance.inactiveDecode': {
    ru: 'Прекращать декодирование невидимых медиапотоков.',
    en: 'Stop decoding invisible media streams.',
  },
  'settingDescription.performance.webcamResolution': {
    ru: 'Разрешение, запрашиваемое у камеры устройства.',
    en: 'Resolution requested from the machine camera.',
  },
  'settingDescription.performance.webcamFrameRate': {
    ru: 'Частота кадров, запрашиваемая у камеры устройства.',
    en: 'Frame rate requested from the machine camera.',
  },
  'settingDescription.privacy.copyDiagnostics': {
    ru: 'Разрешить копирование явно очищенной от лишнего диагностики.',
    en: 'Allow explicitly redacted diagnostic copy.',
  },
  'settingDescription.privacy.webcamCapture': {
    ru: 'Разрешить использовать камеру этого устройства как источник видео.',
    en: "Allow this machine's camera to be used as a video source.",
  },
  'settingDescription.privacy.frameCapture': {
    ru: 'Разрешить сохранять кадр камеры на диск.',
    en: 'Allow a camera frame to be written to disk.',
  },
  'settingDescription.diagnostics.verbosity': {
    ru: 'Подробность локального структурированного диагностического журнала.',
    en: 'Local structured diagnostic verbosity.',
  },
  'settingDescription.github.draftOnly': {
    ru: 'Создавать пул-реквесты как черновики и требовать подтверждение для issue.',
    en: 'Create draft pull requests and require confirmation for issues.',
  },
  'settingDescription.advanced.undoDepth': {
    ru: 'Сколько обратимых шагов хранит стек отмены.',
    en: 'How many reversible steps the undo stack keeps.',
  },
  'settingDescription.advanced.historyDepth': {
    ru: 'Сколько записей истории настроек хранится.',
    en: 'How many settings-history entries are kept.',
  },
  'settingDescription.advanced.demoRotationSeconds': {
    ru: 'Сколько демонстрационный цикл удерживает каждый экран, в секундах.',
    en: 'How long the demo loop holds each screen, in seconds.',
  },
  'settingDescription.advanced.worldSync': {
    ru: 'Делиться состоянием мира с другими сессиями этого приложения.',
    en: 'Share world state with other sessions of this application.',
  },
  'settingDescription.github.includeDescriptions': {
    ru: 'Включать описание каждой настройки в черновик issue.',
    en: "Include each setting's description in the issue draft.",
  },
  'settingDescription.github.includeBaseRevision': {
    ru: 'Включать строку базовой ревизии в черновик issue.',
    en: 'Include the base revision line in the issue draft.',
  },
  'settingDescription.github.changeFormat': {
    ru: 'Как изменённые настройки записываются в черновике issue.',
    en: 'How the changed settings are written in the issue draft.',
  },
  'settingDescription.github.attachDiagnostics': {
    ru: 'Прикладывать диагностический отчёт к черновику issue.',
    en: 'Attach the diagnostic report to the issue draft.',
  },
  'settingDescription.privacy.diagnosticsRecordCounts': {
    ru: 'Включать счётчики записей в диагностический отчёт.',
    en: 'Include record counts in the diagnostic report.',
  },
  'settingDescription.privacy.diagnosticsSettingIds': {
    ru: 'Называть изменённые настройки в диагностическом отчёте.',
    en: 'Name the changed settings in the diagnostic report.',
  },
  'settingDescription.privacy.persistAudit': {
    ru: 'Хранить журнал аудита в браузере между сессиями.',
    en: 'Keep the audit trail in browser storage between sessions.',
  },
  'settingDescription.advanced.liveEdit': {
    ru: 'Включить синхронное редактирование только после явного согласия.',
    en: 'Enable synchronized live edit only after explicit opt-in.',
  },
  'settingDescription.sizes.panelHeader': {
    ru: 'Высота заголовка панели, в пикселях.',
    en: 'Height of a panel header, in pixels.',
  },
  'settingDescription.sizes.panelPadding': {
    ru: 'Внутренний отступ тела панели, в пикселях.',
    en: 'Padding inside a panel body, in pixels.',
  },
  'settingDescription.sizes.tileGap': {
    ru: 'Зазор между плитками на размеченном экране, в пикселях.',
    en: 'Gap between tiles on a laid-out screen, in pixels.',
  },
  'settingDescription.sizes.contentGap': {
    ru: 'Зазор между блоками содержимого макета экрана, в пикселях.',
    en: 'Gap between the content blocks of a screen layout, in pixels.',
  },
  'settingDescription.sizes.borderWidth': {
    ru: 'Толщина рамок панелей и элементов управления, в пикселях.',
    en: 'Thickness of panel and control borders, in pixels.',
  },
  'settingDescription.sizes.controlHeight': {
    ru: 'Минимальная высота кнопки, поля или списка, в пикселях.',
    en: 'Minimum height of a button, field or select, in pixels.',
  },
  'settingDescription.typography.letterSpacing': {
    ru: 'Межбуквенный интервал текста интерфейса, в em.',
    en: 'Letter spacing of interface text, in em.',
  },
  'settingDescription.typography.lineHeight': {
    ru: 'Высота строки текста интерфейса.',
    en: 'Line height of interface text.',
  },
  'settingDescription.typography.weight': {
    ru: 'Насыщенность текста интерфейса.',
    en: 'Weight of interface text.',
  },
  'settingDescription.typography.accentWeight': {
    ru: 'Насыщенность, которую интерфейс придаёт акцентированному значению.',
    en: 'Weight the interface gives an accented value.',
  },
  'settingDescription.colors.panelOpacity': {
    ru: 'Непрозрачность панели над фоном приложения.',
    en: 'Opacity of a panel over the application background.',
  },
  'settingDescription.colors.lineOpacity': {
    ru: 'Непрозрачность контуров панелей и элементов управления.',
    en: 'Opacity of panel and control outlines.',
  },
  'settingDescription.animations.easing': {
    ru: 'Функция сглаживания, которую использует каждый переход интерфейса.',
    en: 'Easing every interface transition uses.',
  },
  'settingDescription.animations.tileEnter': {
    ru: 'Анимировать плитку при её появлении в макете.',
    en: 'Animate a tile as it enters the layout.',
  },
  'settingDescription.animations.panelHover': {
    ru: 'Анимировать панель под курсором.',
    en: 'Animate a panel under the pointer.',
  },
  'settingDescription.animations.backgroundMotion': {
    ru: 'Разрешить движение фона приложения.',
    en: 'Let the application background move.',
  },
  'settingDescription.patterns.background': {
    ru: 'Паттерн, рисуемый поверх фона приложения.',
    en: 'Pattern drawn over the application background.',
  },
  'settingDescription.patterns.opacity': {
    ru: 'Непрозрачность фонового паттерна.',
    en: 'Opacity of the background pattern.',
  },
  'settingDescription.patterns.scale': {
    ru: 'Размер одного повтора фонового паттерна, в пикселях.',
    en: 'Size of one repeat of the background pattern, in pixels.',
  },
  'settingDescription.backgrounds.overlayOpacity': {
    ru: 'Непрозрачность затемняющей заливки поверх фона-изображения или видео.',
    en: 'Opacity of the wash over an image or video background.',
  },
  'settingDescription.backgrounds.blur': {
    ru: 'Размытие, применяемое к видеофону, в пикселях.',
    en: 'Blur applied to a video background, in pixels.',
  },
  'settingDescription.backgrounds.motionSpeed': {
    ru: 'Насколько быстро движется анимированный фон, как коэффициент.',
    en: 'How fast an animated background moves, as a multiplier.',
  },
  'settingDescription.tables.density': {
    ru: 'Высота строки таблицы данных.',
    en: 'Row height of a data table.',
  },
  'settingDescription.tables.zebra': {
    ru: 'Заливать через строку строки таблицы данных.',
    en: 'Shade alternating rows of a data table.',
  },
  'settingDescription.tables.stickyHeader': {
    ru: 'Удерживать заголовок таблицы на месте, пока прокручиваются строки.',
    en: 'Keep a table header in place while its rows scroll.',
  },
  'settingDescription.accessibility.focusRingWidth': {
    ru: 'Толщина контура фокуса, в пикселях.',
    en: 'Thickness of the focus outline, in pixels.',
  },
  'settingDescription.accessibility.tapPadding': {
    ru: 'Дополнительный отступ, добавляемый к каждому элементу управления, в пикселях.',
    en: 'Extra padding added to every control, in pixels.',
  },
  'settingDescription.accessibility.underlineLinks': {
    ru: 'Подчёркивать ссылки, а не полагаться только на цвет.',
    en: 'Underline links rather than relying on colour alone.',
  },
  'settingDescription.information.showSessionMetadata': {
    ru: 'Показывать сессию и уровень допуска в шапке.',
    en: 'Show session and clearance in the header.',
  },
  'settingDescription.information.showAsciiField': {
    ru: 'Рисовать поле сигнала на фоне интерфейса.',
    en: 'Draw the signal field behind the shell.',
  },
  'settingDescription.tiles.animations': {
    ru: 'Анимация появления, выбранная оператором для каждой плитки, в виде записей `экран:плитка=анимация`.',
    en: 'Entering animation the operator chose per tile, as `screen:tile=motion` entries.',
  },
  'settingDescription.tiles.categoryAnimations': {
    ru: 'Анимация появления по группам плиток: сводка, реестры, карточки, навигация, телеметрия, события, география -- в виде записи `группа=анимация`.',
    en: 'Entering animation per tile group: summary, records, detail, navigation, telemetry, events, geo, as `group=motion`.',
  },
  'settingDescription.layout.tileMinimumWidth': {
    ru: 'Наименьшая ширина плитки, при которой макет ещё не сдвигает её, в пикселях.',
    en: 'Narrowest a tile may be before the layout moves it, in pixels.',
  },
  'settingDescription.tiles.presentationOverrides': {
    ru: 'Граница подробности, выбранная оператором для отдельных плиток, в виде записей `экран:плитка=full|compact|minimal`; имеет приоритет над группой и над общим пределом приложения.',
    en: 'Presentation cap the operator chose per tile, as `screen:tile=full|compact|minimal` entries; overrides the category and the application ceiling.',
  },
  'settingDescription.tiles.categoryPresentation': {
    ru: 'Граница подробности по группам плиток, в виде записи `группа=full|compact|minimal`: сводка, реестры, карточки, навигация, телеметрия, события, география.',
    en: 'Presentation cap per tile group, as `group=full|compact|minimal`: summary, records, detail, navigation, telemetry, events, geo.',
  },

  'settingScope.device': { ru: 'УСТРОЙСТВО', en: 'DEVICE' },
  'settingScope.group': { ru: 'ГРУППА', en: 'GROUP' },
} as const satisfies CatalogModule;
