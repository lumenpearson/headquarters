import type { CatalogModule } from './catalogTypes';

/**
 * The settings surface: group and category headings, the landing, and the
 * descriptions and option labels a definition does not carry itself.
 *
 * `settingDescription.*` and `settingOption.*` are deliberately incomplete
 * here -- 20 of 168 definitions and 4 of 169 options. The rest still fall back
 * to the schema's English `description` and to `option.toUpperCase()`, which
 * is the largest single block of untranslated text the application draws.
 */
export const settingsMessages = {
  'settingDescription.dateTime.mode': {
    ru: 'Показывать оперативное или системное время, не трогая часы ОС.',
    en: 'Display operation or system time without changing the OS clock.',
  },
  'settingDescription.dateTime.showClockRate': {
    ru: 'Показывать скорость хода часов рядом с часами шапки.',
    en: 'Show the clock rate beside the header clock.',
  },
  'settingDescription.dateTime.showHeaderDate': {
    ru: 'Показывать дату в метаданных шапки.',
    en: 'Show the date in the header metadata.',
  },
  'settingDescription.dateTime.showModeLabel': {
    ru: 'Показывать в нижней панели, какой режим часов сейчас показан.',
    en: 'Show which clock mode the status line is reading.',
  },
  'settingDescription.dateTime.showSeconds': {
    ru: 'Показывать секунды на часах шапки и в нижней панели.',
    en: 'Show seconds in the shell clock and the status line.',
  },
  'settingDescription.diagnostics.showKeybindHints': {
    ru: 'Показывать подсказку сочетаний клавиш в нижней панели.',
    en: 'Show the keybind hint in the status line.',
  },
  'settingDescription.diagnostics.showTransportProbe': {
    ru: 'Показывать индикатор транспорта в нижней панели.',
    en: 'Show the transport probe in the status line.',
  },
  'settingDescription.general.brandTagline': {
    ru: 'Показывать слоган под маркой операции.',
    en: 'Show the tagline under the operation mark.',
  },
  'settingDescription.general.localOnly': {
    ru: 'Клиент остаётся работоспособным без группы.',
    en: 'Keep this client usable without a group.',
  },
  'settingDescription.general.secureLinkBadge': {
    ru: 'Показывать значок защищённого канала в шапке.',
    en: 'Show the secure-link badge in the header.',
  },
  'settingDescription.information.showOperationalContext': {
    ru: 'Показывать контекст операции и сектора на панелях.',
    en: 'Show operation and sector context in panels.',
  },
  'settingDescription.layout.settingsLanding': {
    ru: 'Чем открываются настройки: карточками разделов или единым списком.',
    en: 'Whether the settings screen opens as category cards or as one continuous list.',
  },
  'settingDescription.materials.autoplayPreview': {
    ru: 'Запускать воспроизведение материала сразу при открытии его предпросмотра.',
    en: 'Start a material playing as soon as its preview opens.',
  },
  'settingDescription.materials.loopPreview': {
    ru: 'Повторять просматриваемый материал с начала по его окончании.',
    en: 'Repeat a previewed material from the start once it ends.',
  },
  'settingDescription.materials.rememberPreviewPosition': {
    ru: 'Возобновлять материал с той позиции, на которой воспроизведение было прервано, в рамках сессии.',
    en: 'Resume a material where playback last left it, for this session.',
  },
  'settingDescription.player.controlsHideDelayMs': {
    ru: 'Сколько ждать после ухода курсора и потери фокуса, прежде чем скрыть элементы управления плеера.',
    en: 'How long to wait, after the pointer leaves and no control holds focus, before hiding the player controls.',
  },
  'settingDescription.popups.overlayBlur': {
    ru: 'Размытие фона за диалогом, шторкой или панелью, в пикселях; 0 отключает его.',
    en: 'Backdrop blur behind a dialog, drawer or panel scrim, in pixels; 0 disables it.',
  },
  'settingDescription.startup.autoUpdate': {
    ru: 'Проверять обновление при запуске и скачивать его без запроса. Только на десктопе.',
    en: 'Check for an update on launch and download it without being asked. Desktop only.',
  },
  'settingDescription.startup.launchOnLogin': {
    ru: 'Запускать приложение при входе в систему. Только на десктопе.',
    en: 'Start the application when this machine signs in. Desktop only.',
  },
  'settingDescription.tiles.presentation': {
    ru: 'Верхняя граница подробности отрисовки плитки; «как у группы» оставляет выбор макету.',
    en: 'Cap on how rich a tile may be drawn; auto leaves the choice to the layout.',
  },
  'settingOption.dateTime.mode.operation': { ru: 'ОПЕРАТИВНОЕ', en: 'OPERATION' },
  'settingOption.dateTime.mode.system': { ru: 'СИСТЕМНОЕ', en: 'SYSTEM' },
  'settingOption.layout.settingsLanding.cards': { ru: 'КАРТОЧКИ', en: 'CARDS' },
  'settingOption.layout.settingsLanding.unified': { ru: 'ЕДИНЫЙ СПИСОК', en: 'ONE LIST' },
  'settings.awaitingFeature': {
    ru: 'ПОКА НЕ ДЕЙСТВУЕТ — изменение ни на что не влияет',
    en: 'NOT WIRED YET — changing this has no effect',
  },
  'settingsCategory.accessibility': { ru: 'ДОСТУПНОСТЬ', en: 'ACCESSIBILITY' },
  'settingsCategory.advanced': { ru: 'РАСШИРЕННЫЕ', en: 'ADVANCED' },
  'settingsCategory.animations': { ru: 'АНИМАЦИИ', en: 'ANIMATIONS' },
  'settingsCategory.backgrounds': { ru: 'ФОНЫ', en: 'BACKGROUNDS' },
  'settingsCategory.cameras': { ru: 'КАМЕРЫ', en: 'CAMERAS' },
  'settingsCategory.colors': { ru: 'ЦВЕТА', en: 'COLORS' },
  'settingsCategory.dateTime': { ru: 'ДАТА И ВРЕМЯ', en: 'DATE AND TIME' },
  'settingsCategory.diagnostics': { ru: 'ДИАГНОСТИКА', en: 'DIAGNOSTICS' },
  'settingsCategory.general': { ru: 'ОБЩИЕ', en: 'GENERAL' },
  'settingsCategory.github': { ru: 'ИНТЕГРАЦИЯ GITHUB', en: 'GITHUB INTEGRATION' },
  'settingsCategory.groups': { ru: 'ГРУППЫ', en: 'GROUPS' },
  'settingsCategory.information': { ru: 'ИНФОРМАЦИЯ', en: 'INFORMATION' },
  'settingsCategory.keybinds': { ru: 'КЛАВИШИ', en: 'KEYBINDS' },
  'settingsCategory.layout': { ru: 'МАКЕТ', en: 'LAYOUT' },
  'settingsCategory.localization': { ru: 'ЛОКАЛИЗАЦИЯ', en: 'LOCALIZATION' },
  'settingsCategory.map': { ru: 'КАРТА', en: 'MAP' },
  'settingsCategory.materials': { ru: 'МАТЕРИАЛЫ', en: 'MATERIALS' },
  'settingsCategory.patterns': { ru: 'ПАТТЕРНЫ', en: 'PATTERNS' },
  'settingsCategory.performance': { ru: 'ПРОИЗВОДИТЕЛЬНОСТЬ', en: 'PERFORMANCE' },
  'settingsCategory.player': { ru: 'ПЛЕЕР', en: 'PLAYER' },
  'settingsCategory.popups': { ru: 'POP-UP', en: 'POPUPS' },
  'settingsCategory.privacy': { ru: 'ПРИВАТНОСТЬ', en: 'PRIVACY' },
  'settingsCategory.simulation': { ru: 'СИМУЛЯЦИЯ', en: 'SIMULATION' },
  'settingsCategory.sizes': { ru: 'РАЗМЕРЫ', en: 'SIZES' },
  'settingsCategory.startup': { ru: 'ЗАПУСК', en: 'STARTUP' },
  'settingsCategory.statusline': { ru: 'НИЖНЯЯ ПАНЕЛЬ', en: 'STATUS LINE' },
  'settingsCategory.styles': { ru: 'СТИЛИ', en: 'STYLES' },
  'settingsCategory.tables': { ru: 'ТАБЛИЦЫ', en: 'TABLES' },
  'settingsCategory.telemetry': { ru: 'ТЕЛЕМЕТРИЯ', en: 'TELEMETRY' },
  'settingsCategory.themes': { ru: 'ТЕМЫ', en: 'THEMES' },
  'settingsCategory.tiles': { ru: 'ПЛИТКИ', en: 'TILES' },
  'settingsCategory.titlebar': { ru: 'ВЕРХНЯЯ ПАНЕЛЬ', en: 'TITLE BAR' },
  'settingsCategory.typography': { ru: 'ТИПОГРАФИКА', en: 'TYPOGRAPHY' },
  'settingsGroup.appearance': { ru: 'ВНЕШНИЙ ВИД', en: 'APPEARANCE' },
  'settingsGroup.information': { ru: 'ИНФОРМАЦИЯ', en: 'INFORMATION' },
  'settingsGroup.layout': { ru: 'МАКЕТ И РАЗМЕРЫ', en: 'LAYOUT AND SIZES' },
  'settingsGroup.media': { ru: 'МЕДИА И КАРТА', en: 'MEDIA AND MAP' },
  'settingsGroup.motion': { ru: 'ДВИЖЕНИЕ И ДОСТУПНОСТЬ', en: 'MOTION AND ACCESSIBILITY' },
  'settingsGroup.session': { ru: 'СЕССИЯ И УПРАВЛЕНИЕ', en: 'SESSION AND CONTROL' },
  'settingsGroup.system': { ru: 'СИСТЕМА', en: 'SYSTEM' },
  'settingsLanding.noResults': { ru: 'НИЧЕГО НЕ НАЙДЕНО', en: 'NOTHING FOUND' },
  'settingsLanding.resultsCount': { ru: '{count} НАЙДЕНО', en: '{count} FOUND' },
  'settingsLanding.resultsHeading': { ru: 'РЕЗУЛЬТАТЫ ПОИСКА', en: 'SEARCH RESULTS' },
  'settingsLanding.searchLabel': { ru: 'Поиск по настройкам', en: 'Search settings' },
  'settingsLanding.searchPlaceholder': { ru: 'ИМЯ ИЛИ ОПИСАНИЕ', en: 'NAME OR DESCRIPTION' },
} as const satisfies CatalogModule;
