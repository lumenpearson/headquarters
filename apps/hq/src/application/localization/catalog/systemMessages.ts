import type { CatalogModule } from './catalogTypes';

/**
 * The settings screen's own chrome, the six settings-screen sections it
 * shares with the card grid, its group-history sub-panel, the system screen
 * and the engineering (developer) contour -- the surfaces this wave of the
 * mandate covers.
 *
 * `settings.*` and `settingsSection.*` sit beside `settingsMessages.ts`'s
 * `settings.*`/`settingsCategory.*`/`settingsGroup.*`/`settingsLanding.*`
 * ids without colliding with them: every id here names something that file
 * does not already carry (checked against the catalogue's own duplicate-id
 * test). `system.*` is the `/system` screen; `systemUnit.*` is this module's
 * own small set of unit abbreviations, kept separate from `recordMessages.ts`
 * and `materialMessages.ts`'s `unit.*` so two modules never have to agree on
 * one namespace; `developer.*` is the engineering contour, reached from
 * `DeveloperGate` and drawn by `DeveloperPanel`.
 *
 * Two plural sites live here, `settings.eventCount` and `settings.undoCount`,
 * for the same reason `pluralMessages.ts` exists: a Russian count and the noun
 * it governs decline together, and `{count} СОБЫТИЙ` was right for five and
 * wrong for one or two. `system.nodesNormalCount` is a third, the health
 * line's "N/M nodes normal" -- the noun there is governed by the total,
 * the second number, not the first.
 */
export const systemMessages = {
  // ---------------------------------------------------------------------
  // Settings screen: chrome shared by every presentation
  // ---------------------------------------------------------------------
  'settings.localConfigEyebrow': {
    ru: 'ЛОКАЛЬНАЯ КОНФИГУРАЦИЯ / СОХРАНЯЕТСЯ',
    en: 'LOCAL CONFIGURATION / PERSISTED',
  },
  'settings.screenTitle': { ru: 'НАСТРОЙКИ КОНТУРА', en: 'CONTOUR SETTINGS' },
  'settings.sectionsAriaLabel': { ru: 'Разделы настроек', en: 'Settings sections' },
  'settings.sectionsToggleButton': { ru: '[≡] РАЗДЕЛЫ', en: '[≡] SECTIONS' },
  'settings.landingToggleLabel': { ru: 'Вид настроек', en: 'Settings view' },
  'settings.savedLocallyNotice': {
    ru: '[✓] ИЗМЕНЕНИЯ СОХРАНЯЮТСЯ ЛОКАЛЬНО',
    en: '[✓] CHANGES SAVE LOCALLY',
  },
  'settings.sectionsNavTitle': { ru: 'РАЗДЕЛЫ', en: 'SECTIONS' },
  'settings.backToSectionsButton': { ru: '[←] К РАЗДЕЛАМ', en: '[←] BACK TO SECTIONS' },

  // ---------------------------------------------------------------------
  // Settings screen: the ten section labels, shared with SettingsCardGrid
  // ---------------------------------------------------------------------
  'settingsSection.interface': { ru: 'ИНТЕРФЕЙС', en: 'INTERFACE' },
  'settingsSection.simulation': { ru: 'СИМУЛЯЦИЯ', en: 'SIMULATION' },
  'settingsSection.workspace': { ru: 'РАБОЧЕЕ МЕСТО', en: 'WORKSPACE' },
  'settingsSection.group': { ru: 'СИНХРОНИЗАЦИЯ ГРУППЫ', en: 'GROUP SYNC' },
  'settingsSection.data': { ru: 'ЛОКАЛЬНЫЕ ДАННЫЕ', en: 'LOCAL DATA' },
  'settingsSection.personalization': { ru: 'ПЕРСОНАЛИЗАЦИЯ', en: 'PERSONALIZATION' },
  'settingsSection.keybinds': { ru: 'СОЧЕТАНИЯ КЛАВИШ', en: 'KEYBOARD SHORTCUTS' },
  'settingsSection.history': { ru: 'ИСТОРИЯ НАСТРОЕК', en: 'SETTINGS HISTORY' },
  'settingsSection.keymap': { ru: 'ГОРЯЧИЕ КЛАВИШИ', en: 'HOTKEYS' },
  'settingsSection.update': { ru: 'ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ', en: 'APPLICATION UPDATE' },

  // ---------------------------------------------------------------------
  // Settings screen: interface panel
  // ---------------------------------------------------------------------
  'settings.interfaceEyebrow': { ru: 'ОТОБРАЖЕНИЕ / ТЕРМИНАЛ', en: 'DISPLAY / TERMINAL' },
  'settings.compactNavLabel': { ru: 'КОМПАКТНАЯ НАВИГАЦИЯ', en: 'COMPACT NAVIGATION' },
  'settings.compactNavDetail': {
    ru: 'Освобождает пространство рабочей области',
    en: 'Frees up workspace room',
  },
  'settings.compactNavSwitchLabel': { ru: 'Компактная навигация', en: 'Compact navigation' },
  'settings.animationsLabel': { ru: 'АНИМАЦИИ', en: 'ANIMATIONS' },
  'settings.animationsDetail': {
    ru: 'Плавные переходы и импульсы событий',
    en: 'Smooth transitions and event pulses',
  },
  'settings.animationsSwitchLabel': { ru: 'Анимации', en: 'Animations' },
  'settings.cameraSafeLabel': { ru: 'ЩАДЯЩИЙ РЕЖИМ', en: 'CAMERA SAFE' },
  'settings.cameraSafeDetail': {
    ru: 'Снижает контраст и яркость для съёмки',
    en: 'Reduces contrast and brightness for filming',
  },
  'settings.cameraSafeSwitchLabel': { ru: 'Щадящий режим', en: 'Camera safe' },
  'settings.cursorModeLabel': { ru: 'РЕЖИМ КУРСОРА', en: 'CURSOR MODE' },
  'settings.cursorModeDetail': {
    ru: 'Поведение курсора в полноэкранном режиме',
    en: 'Cursor behaviour in full screen',
  },
  'settings.cursorModeSelectLabel': { ru: 'Режим курсора', en: 'Cursor mode' },
  'settings.cursorModeVisible': { ru: 'ВИДИМЫЙ', en: 'VISIBLE' },
  'settings.cursorModeAutoHide': { ru: 'АВТОСКРЫТИЕ', en: 'AUTO HIDE' },
  'settings.cursorModeHidden': { ru: 'СКРЫТ', en: 'HIDDEN' },

  // ---------------------------------------------------------------------
  // Settings screen: simulation panel
  // ---------------------------------------------------------------------
  'settings.simulationEyebrow': { ru: 'ДЕТЕРМИНИРОВАННЫЙ МИР', en: 'DETERMINISTIC WORLD' },
  'settings.stateLabel': { ru: 'СОСТОЯНИЕ', en: 'STATE' },
  'settings.simulationTickDetail': { ru: 'ТИК {tick}', en: 'TICK {tick}' },
  'settings.simulationStateSwitchLabel': { ru: 'Состояние симуляции', en: 'Simulation state' },
  'settings.clockSpeedLabel': { ru: 'СКОРОСТЬ ЧАСОВ', en: 'CLOCK SPEED' },
  'settings.clockSpeedDetail': { ru: 'Масштаб локального времени', en: 'Local time scale' },
  'settings.clockSpeedSelectLabel': { ru: 'Скорость часов', en: 'Clock speed' },
  'settings.clockModeLabel': { ru: 'РЕЖИМ ЧАСОВ', en: 'CLOCK MODE' },
  'settings.clockModeDetail': {
    ru: 'Фиксированное или системное время',
    en: 'Fixed or system time',
  },
  'settings.clockModeSelectLabel': { ru: 'Режим часов', en: 'Clock mode' },
  'settings.clockModeFixed': { ru: 'ФИКСИРОВАННОЕ', en: 'FIXED' },
  'settings.clockModeSystem': { ru: 'СИСТЕМНОЕ', en: 'SYSTEM' },
  'settings.fixedTimeLabel': { ru: 'ФИКСИРОВАННОЕ ВРЕМЯ', en: 'FIXED TIME' },
  'settings.fixedTimeFormatDetail': { ru: 'ЧЧ:ММ:СС', en: 'HH:MM:SS' },
  'settings.fixedTimeAriaLabel': { ru: 'Фиксированное время', en: 'Fixed time' },

  // ---------------------------------------------------------------------
  // Settings screen: workspace panel
  // ---------------------------------------------------------------------
  'settings.workspaceEyebrow': { ru: 'НЕСКОЛЬКО МОНИТОРОВ', en: 'MULTI MONITOR' },
  'settings.screenIdLabel': { ru: 'ИДЕНТИФИКАТОР ЭКРАНА', en: 'SCREEN ID' },
  'settings.screenIdDetail': {
    ru: 'Идентификатор текущего монитора',
    en: 'Identifier of the current monitor',
  },
  'settings.screenIdSelectLabel': { ru: 'Идентификатор экрана', en: 'Screen ID' },
  'settings.autoDemoLabel': { ru: 'АВТОДЕМО', en: 'AUTO DEMO' },
  'settings.autoDemoDetail': {
    ru: 'Циклическое локальное демо, отключается при вводе',
    en: 'Looping local demo, stops on input',
  },
  'settings.autoDemoSwitchLabel': { ru: 'Автодемо', en: 'Auto demo' },
  'settings.productionPanelButton': {
    ru: '[CTRL+SHIFT+P] ПАНЕЛЬ РЕЖИССЁРА',
    en: '[CTRL+SHIFT+P] PRODUCTION PANEL',
  },
  'settings.fullscreenKioskButton': {
    ru: '[F] ПОЛНЫЙ ЭКРАН / КИОСК',
    en: '[F] FULLSCREEN / KIOSK',
  },

  // ---------------------------------------------------------------------
  // Settings screen: group panel
  // ---------------------------------------------------------------------
  'settings.groupSyncEyebrow': { ru: 'СИНХРОНИЗАЦИЯ / R27', en: 'SYNC / R27' },
  'settings.groupConnectionDetail': {
    ru: 'Связь с control plane',
    en: 'Connection to the control plane',
  },
  'settings.groupNameLabel': { ru: 'ГРУППА', en: 'GROUP' },
  'settings.groupNameDetail': {
    ru: 'Имя группы и роль этого устройства',
    en: "This device's group name and role",
  },
  'settings.openGroupPairingButton': {
    ru: '[G] ОТКРЫТЬ ПОДКЛЮЧЕНИЕ К ГРУППЕ',
    en: '[G] OPEN GROUP CONNECTION',
  },

  // ---------------------------------------------------------------------
  // Settings screen: local data panel
  // ---------------------------------------------------------------------
  'settings.dataEyebrow': { ru: 'СОХРАНЕНИЕ / АВТОНОМНО', en: 'PERSISTENCE / OFFLINE' },
  'settings.dataDescription': {
    ru: 'Конфигурация, подтверждения тревог, выполненные задачи и съёмочные snapshots хранятся в профиле браузера. Сеть не требуется.',
    en: 'Configuration, alert acknowledgements, completed tasks and shoot snapshots live in the browser profile. No network required.',
  },
  'settings.dataWorldStoreLabel': { ru: 'МИРОВОЕ ХРАНИЛИЩЕ', en: 'WORLD STORE' },
  'settings.dataWorldStoreValue': { ru: 'ZUSTAND / НОРМАЛИЗОВАННОЕ', en: 'ZUSTAND / NORMALIZED' },
  'settings.dataPersistenceLabel': { ru: 'СОХРАНЕНИЕ', en: 'PERSISTENCE' },
  'settings.dataPersistenceValue': { ru: 'LOCALSTORAGE, ВЕРСИЯ 2', en: 'LOCALSTORAGE V2' },
  'settings.dataSyncLabel': { ru: 'СИНХРОНИЗАЦИЯ', en: 'SYNC' },
  'settings.dataSyncValue': { ru: 'BROADCASTCHANNEL / МЕЖОКОННЫЙ КАНАЛ', en: 'BROADCASTCHANNEL' },
  'settings.dataExportLabel': { ru: 'ЭКСПОРТ', en: 'EXPORT' },
  'settings.dataExportValue': { ru: 'СТАТИЧЕСКИЙ / АВТОНОМНО', en: 'STATIC / OFFLINE' },
  'settings.resetWorldButton': {
    ru: '[R] СБРОСИТЬ ОПЕРАТИВНЫЙ МИР',
    en: '[R] RESET OPERATIONAL WORLD',
  },
  'settings.resetWorldDialogTitle': {
    ru: 'СБРОСИТЬ ОПЕРАТИВНЫЙ МИР?',
    en: 'RESET THE OPERATIONAL WORLD?',
  },
  'settings.resetWorldDialogDescription': {
    ru: 'Объекты, дела, тревоги, события и связь вернутся к исходному состоянию сцены. Настройки персонализации это не затронет.',
    en: 'Objects, cases, alerts, events and comms return to the scene default. Personalization settings are unaffected.',
  },
  'settings.resetWorldConfirmLabel': { ru: '[R] СБРОСИТЬ МИР', en: '[R] RESET WORLD' },
  'settings.resetWorldToastTitle': { ru: 'ОПЕРАТИВНЫЙ МИР СБРОШЕН', en: 'OPERATIONAL WORLD RESET' },
  'settings.resetWorldToastDescription': {
    ru: 'Объекты, дела, тревоги и связь вернулись к исходному состоянию сцены.',
    en: 'Objects, cases, alerts and comms returned to the scene default.',
  },

  // ---------------------------------------------------------------------
  // Settings screen: personalization / catalogue panel
  // ---------------------------------------------------------------------
  'settings.personalizationTitle': {
    ru: 'ПЕРСОНАЛИЗАЦИЯ / КАТАЛОГ',
    en: 'PERSONALIZATION / CATALOGUE',
  },
  'settings.personalizationEyebrowPrefix': { ru: 'БЕЗОПАСНЫЙ ЧЕРНОВИК', en: 'SAFE DRAFT' },
  'settings.personalizationEyebrowRevision': { ru: 'РЕВ {revision}', en: 'REV {revision}' },
  'settings.catalogGroupSelectLabel': {
    ru: 'Раздел персонализации',
    en: 'Personalization section',
  },
  'settings.catalogCategorySelectLabel': {
    ru: 'Категория персонализации',
    en: 'Personalization category',
  },
  'settings.allCategoriesOption': { ru: 'ВСЕ КАТЕГОРИИ РАЗДЕЛА', en: 'ALL SECTION CATEGORIES' },
  'settings.changedOnlyLabel': { ru: 'Только изменённые', en: 'Changed only' },
  'settings.catalogCountSummary': {
    ru: '{shown} ИЗ {total} · {changed} ИЗМЕНЕНО В РАЗДЕЛЕ',
    en: '{shown} OF {total} · {changed} CHANGED IN SECTION',
  },
  'settings.foundElsewhereHeading': {
    ru: 'НАЙДЕНО В ДРУГИХ РАЗДЕЛАХ: {count}',
    en: 'FOUND ELSEWHERE: {count}',
  },
  'settings.resetCategoryButton': { ru: '[R] СБРОСИТЬ КАТЕГОРИЮ', en: '[R] RESET CATEGORY' },
  'settings.resetAllButton': { ru: '[RR] СБРОСИТЬ ВСЁ', en: '[RR] RESET ALL' },
  'settings.resetAllDialogTitle': { ru: 'СБРОСИТЬ ВСЕ НАСТРОЙКИ?', en: 'RESET EVERY SETTING?' },
  'settings.resetAllDialogDescription': {
    ru: 'Все категории персонализации вернутся к значениям по умолчанию. Отменяется через [CTRL+Z] UNDO.',
    en: 'Every personalization category returns to its default. [CTRL+Z] UNDO reverses it.',
  },
  'settings.resetAllToastTitle': { ru: 'НАСТРОЙКИ СБРОШЕНЫ', en: 'SETTINGS RESET' },
  'settings.resetAllToastDescription': {
    ru: 'Все категории вернулись к значениям по умолчанию; [CTRL+Z] отменяет.',
    en: 'Every category returned to its default; [CTRL+Z] undoes it.',
  },
  'settings.discardDraftButton': { ru: '[ESC] ОТМЕНИТЬ DRAFT', en: '[ESC] DISCARD DRAFT' },
  'settings.undoButton': { ru: '[CTRL+Z] ОТМЕНА', en: '[CTRL+Z] UNDO' },
  'settings.redoButton': { ru: '[CTRL+Y] ПОВТОР', en: '[CTRL+Y] REDO' },
  'settings.exportJsonButton': { ru: '[↓] ЭКСПОРТ JSON', en: '[↓] EXPORT JSON' },
  'settings.importJsonButton': { ru: '[↑] ИМПОРТ JSON', en: '[↑] IMPORT JSON' },
  'settings.publishButton': { ru: '[CTRL+ENTER] ОПУБЛИКОВАТЬ', en: '[CTRL+ENTER] PUBLISH' },
  'settings.draftHistorySummary': {
    ru: 'ИСТОРИЯ DRAFT: {events} · ЛОКАЛЬНЫЙ SCOPE · БЕЗ НЕБЕЗОПАСНЫХ CSS/JS',
    en: 'DRAFT HISTORY: {events} · LOCAL SCOPE · NO UNSAFE CSS/JS',
  },
  'settings.importSuccessStatus': {
    ru: '[✓] ИМПОРТИРОВАНО: {fileName}',
    en: '[✓] IMPORTED: {fileName}',
  },
  'settings.importRejectedStatus': {
    ru: '[!] ИМПОРТ ОТКЛОНЁН: ОШИБКА ВАЛИДАЦИИ СХЕМЫ',
    en: '[!] IMPORT REJECTED: SCHEMA VALIDATION FAILED',
  },
  'settings.importDraftAriaLabel': { ru: 'Импорт черновика настроек', en: 'Import settings draft' },

  // ---------------------------------------------------------------------
  // Settings screen: keybinds panel
  // ---------------------------------------------------------------------
  'settings.keybindsEyebrow': {
    ru: 'СОЧЕТАНИЯ КЛАВИШ / НАЖМИТЕ ЛЮБОЕ',
    en: 'KEYBINDS / PRESS ANY',
  },

  // ---------------------------------------------------------------------
  // Settings screen: history panel (local ledger)
  // ---------------------------------------------------------------------
  'settings.historyEyebrow': {
    ru: 'ЛОКАЛЬНЫЙ ЖУРНАЛ / {events} / {undo}',
    en: 'LOCAL LEDGER / {events} / {undo}',
  },
  'settings.historyOperationSelectLabel': { ru: 'Операция истории', en: 'History operation' },
  'settings.allOperationsOption': { ru: 'ВСЕ ОПЕРАЦИИ', en: 'ALL OPERATIONS' },
  'settings.historyOperationPatch': { ru: 'ПРАВКА', en: 'PATCH' },
  'settings.historyOperationResetCategory': { ru: 'СБРОС КАТЕГОРИИ', en: 'RESET CATEGORY' },
  'settings.historyOperationResetAll': { ru: 'ПОЛНЫЙ СБРОС', en: 'RESET ALL' },
  'settings.historyOperationImport': { ru: 'ИМПОРТ', en: 'IMPORT' },
  'settings.historyOperationDiscard': { ru: 'ЧЕРНОВИК ОТБРОШЕН', en: 'DISCARD' },
  'settings.historyOperationPublish': { ru: 'ПУБЛИКАЦИЯ', en: 'PUBLISH' },
  'settings.historyOperationRestore': { ru: 'ВОССТАНОВЛЕНИЕ', en: 'RESTORE' },
  'settings.historyOperationUndo': { ru: 'ОТМЕНА', en: 'UNDO' },
  'settings.historyOperationRedo': { ru: 'ПОВТОР', en: 'REDO' },
  'settings.historyScopeSelectLabel': { ru: 'Охват истории', en: 'History scope' },
  'settings.allScopesOption': { ru: 'ЛЮБОЙ ОХВАТ', en: 'ANY SCOPE' },
  'settings.historyScopeDevice': { ru: 'ТОЛЬКО ЭТА МАШИНА', en: 'THIS MACHINE ONLY' },
  'settings.historyScopeGroup': { ru: 'ГРУППОВЫЕ', en: 'GROUP' },
  'settings.historyCategorySelectLabel': { ru: 'Категория истории', en: 'History category' },
  'settings.allHistoryCategoriesOption': { ru: 'ВСЕ КАТЕГОРИИ', en: 'ALL CATEGORIES' },
  'settings.historySettingFilterAriaLabel': {
    ru: 'Фильтр истории по параметру',
    en: 'Filter history by setting',
  },
  'settings.historySettingFilterPlaceholder': { ru: 'ИД НАСТРОЙКИ', en: 'SETTING ID' },
  'settings.historyDateFilterAriaLabel': {
    ru: 'Фильтр истории по дате',
    en: 'Filter history by date',
  },
  'settings.historyOrderSelectLabel': { ru: 'Порядок истории', en: 'History order' },
  'settings.historyOrderNewest': { ru: 'СНАЧАЛА НОВЫЕ', en: 'NEWEST FIRST' },
  'settings.historyOrderOldest': { ru: 'СНАЧАЛА СТАРЫЕ', en: 'OLDEST FIRST' },
  'settings.historyEmptyState': {
    ru: 'НЕТ СОБЫТИЙ ПО ТЕКУЩЕМУ ФИЛЬТРУ',
    en: 'NO EVENTS FOR THE CURRENT FILTER',
  },
  'settings.publicationNoChanges': {
    ru: 'ПУБЛИКАЦИЯ БЕЗ ИЗМЕНЕНИЙ',
    en: 'PUBLICATION WITH NO CHANGES',
  },
  'settings.localScopeLabel': { ru: 'ЛОКАЛЬНО', en: 'LOCAL' },
  'settings.restoreToDraftButton': { ru: '[↩] В DRAFT', en: '[↩] TO DRAFT' },
  'settings.paginationBackButton': { ru: '[←] НАЗАД', en: '[←] BACK' },
  'settings.paginationSummary': {
    ru: 'СТР. {page} / {pageCount} · ВСЕГО {total}',
    en: 'PAGE {page} / {pageCount} · TOTAL {total}',
  },
  'settings.paginationForwardButton': { ru: 'ВПЕРЁД [→]', en: 'FORWARD [→]' },
  'settings.historyRestoreNote': {
    ru: 'ВОССТАНОВЛЕНИЕ ЗАГРУЖАЕТ СОСТОЯНИЕ В ЛОКАЛЬНЫЙ DRAFT; ПУБЛИКАЦИЯ СОЗДАЁТ НОВУЮ РЕВИЗИЮ И НЕ ПЕРЕЗАПИСЫВАЕТ ИСТОРИЮ.',
    en: 'RESTORING LOADS THE STATE INTO THE LOCAL DRAFT; PUBLISHING CREATES A NEW REVISION AND NEVER OVERWRITES HISTORY.',
  },

  // ---------------------------------------------------------------------
  // Settings screen: history panel, the group ledger sub-section
  // ---------------------------------------------------------------------
  'settings.groupJournalAriaLabel': { ru: 'Журнал группы', en: 'Group journal' },
  'settings.groupJournalHeading': { ru: 'ЖУРНАЛ ГРУППЫ', en: 'GROUP JOURNAL' },
  'settings.groupJournalUnavailable': {
    ru: 'СЕССИЯ НЕ В ГРУППЕ — ЧИТАТЬ НЕЧЕГО',
    en: 'THIS SESSION IS NOT IN A GROUP — NOTHING TO READ',
  },
  'settings.groupJournalLoading': { ru: 'ЧТЕНИЕ', en: 'READING' },
  'settings.groupJournalLoaded': { ru: 'ЗАГРУЖЕНО {count}{more}', en: 'LOADED {count}{more}' },
  'settings.groupJournalHasMore': { ru: ', ЕСТЬ ЕЩЁ', en: ', MORE AVAILABLE' },
  'settings.groupJournalNoMore': { ru: ', БОЛЬШЕ НЕТ', en: ', NO MORE' },
  'settings.groupJournalEditModeOnlyLabel': {
    ru: 'Только правки режима редактирования',
    en: 'Edit-mode changes only',
  },
  'settings.groupJournalEditModeEmpty': {
    ru: 'НЕТ ПРАВОК РЕЖИМА РЕДАКТИРОВАНИЯ НА ЭТОЙ СТРАНИЦЕ',
    en: 'NO EDIT-MODE CHANGES ON THIS PAGE',
  },
  'settings.groupJournalNoParameters': {
    ru: 'ИЗМЕНЕНИЕ БЕЗ ПАРАМЕТРОВ',
    en: 'CHANGE WITH NO PARAMETERS',
  },
  'settings.groupScopeLabel': { ru: 'ГРУППА', en: 'GROUP' },
  'settings.groupJournalRevisionActor': {
    ru: 'РЕВ. {revision} · {actor}',
    en: 'REV. {revision} · {actor}',
  },
  'settings.groupJournalUnknownDevice': { ru: 'НЕИЗВЕСТНОЕ УСТРОЙСТВО', en: 'UNKNOWN DEVICE' },
  'settings.groupJournalReloadButton': { ru: '[↺] СНАЧАЛА', en: '[↺] FROM THE START' },
  'settings.groupJournalPaginationNote': {
    ru: 'ПАГИНАЦИЯ ПО КУРСОРУ · БЕЗ ОБЩЕГО СЧЁТА',
    en: 'CURSOR PAGINATION · NO TOTAL COUNT',
  },
  'settings.groupJournalMoreButton': { ru: 'ЕЩЁ [→]', en: 'MORE [→]' },
  'settings.groupHistoryUnavailableError': {
    ru: 'ИСТОРИЯ ГРУППЫ НЕДОСТУПНА',
    en: 'GROUP HISTORY UNAVAILABLE',
  },
  'settings.groupHistoryError': { ru: 'ИСТОРИЯ ГРУППЫ: {message}', en: 'GROUP HISTORY: {message}' },
  'settings.groupHistoryOperationApplyDraftPatch': { ru: 'ПРАВКА ЧЕРНОВИКА', en: 'DRAFT PATCH' },
  'settings.groupHistoryOperationDiscardDraft': { ru: 'ЧЕРНОВИК ОТБРОШЕН', en: 'DRAFT DISCARDED' },
  'settings.groupHistoryOperationPublishDraft': { ru: 'ПУБЛИКАЦИЯ', en: 'PUBLISH' },
  'settings.groupHistoryOperationResetCategory': { ru: 'СБРОС КАТЕГОРИИ', en: 'RESET CATEGORY' },
  'settings.groupHistoryOperationResetElement': { ru: 'СБРОС ПАРАМЕТРА', en: 'RESET SETTING' },
  'settings.groupHistoryOperationResetAll': { ru: 'ПОЛНЫЙ СБРОС', en: 'RESET ALL' },
  'settings.groupHistoryOperationImportSettings': { ru: 'ИМПОРТ', en: 'IMPORT' },
  'settings.groupHistoryOperationRevertVersion': {
    ru: 'ВОЗВРАТ К РЕВИЗИИ',
    en: 'REVERT TO REVISION',
  },

  // ---------------------------------------------------------------------
  // Settings screen: keymap panel
  // ---------------------------------------------------------------------
  'settings.keymapEyebrow': { ru: 'KEYMAP / ТЕРМИНАЛ', en: 'KEYMAP / TERMINAL' },
  'settings.keymapSections': { ru: 'ПЕРЕХОД ПО РАЗДЕЛАМ', en: 'JUMP TO A SECTION' },
  'settings.keymapGlobalSearch': { ru: 'ГЛОБАЛЬНЫЙ ПОИСК', en: 'GLOBAL SEARCH' },
  'settings.keymapProductionPanel': { ru: 'ПАНЕЛЬ РЕЖИССЁРА', en: 'PRODUCTION PANEL' },
  'settings.keymapFullscreen': { ru: 'ПОЛНЫЙ ЭКРАН', en: 'FULLSCREEN' },
  'settings.keymapWebcamToggle': { ru: 'ВЕБКАМЕРА ВКЛ / ВЫКЛ', en: 'WEBCAM ON / OFF' },
  'settings.keymapPlayPause': { ru: 'ПУСК / ПАУЗА ВИДЕО', en: 'PLAY / PAUSE VIDEO' },
  'settings.keymapCloseDrawer': { ru: 'ЗАКРЫТЬ ЯЩИК / ПАНЕЛЬ', en: 'CLOSE DRAWER / PANEL' },

  // ---------------------------------------------------------------------
  // Settings screen: plural sites
  // ---------------------------------------------------------------------
  'settings.eventCount': {
    ru: {
      one: '{count} СОБЫТИЕ',
      few: '{count} СОБЫТИЯ',
      many: '{count} СОБЫТИЙ',
      other: '{count} СОБЫТИЯ',
    },
    en: { one: '{count} EVENT', other: '{count} EVENTS' },
  },
  'settings.undoCount': {
    ru: {
      one: '{count} ОТМЕНА',
      few: '{count} ОТМЕНЫ',
      many: '{count} ОТМЕН',
      other: '{count} ОТМЕНЫ',
    },
    en: { one: '{count} UNDO', other: '{count} UNDOS' },
  },

  // =======================================================================
  // System screen (/system)
  // =======================================================================
  'system.controlNodeLabel': { ru: 'УЗЕЛ УПРАВЛЕНИЯ', en: 'CONTROL NODE' },
  'system.screenTitle': { ru: 'СИСТЕМА И РЕСУРСЫ', en: 'SYSTEM AND RESOURCES' },
  'system.contourStableLabel': { ru: 'КОНТУР СТАБИЛЕН', en: 'CONTOUR STABLE' },
  'system.nodesNormalCount': {
    ru: {
      one: '{normal}/{count} УЗЕЛ В НОРМЕ',
      few: '{normal}/{count} УЗЛА В НОРМЕ',
      many: '{normal}/{count} УЗЛОВ В НОРМЕ',
      other: '{normal}/{count} УЗЛА В НОРМЕ',
    },
    en: { one: '{normal}/{count} NODE NORMAL', other: '{normal}/{count} NODES NORMAL' },
  },

  'system.resourcesTitle': { ru: 'РЕСУРСЫ РАБОЧЕЙ СТАНЦИИ', en: 'WORKSTATION RESOURCES' },
  'system.resourcesHostPrefix': { ru: 'ХОСТ', en: 'HOST' },
  'system.metricLabelCpu': { ru: 'ЦП', en: 'CPU' },
  'system.metricLabelRam': { ru: 'ОЗУ', en: 'RAM' },
  'system.metricLabelGpu': { ru: 'ГП', en: 'GPU' },
  'system.metricLabelStorage': { ru: 'ХРАНИЛИЩЕ', en: 'STORAGE' },
  'system.metricNoSampleDetail': { ru: 'ОТСЧЁТА НЕТ', en: 'NO SAMPLE' },
  'system.cpuSpecDetail': { ru: '16C / 4.8 ГГЦ', en: '16C / 4.8 GHZ' },
  'system.ramSpecDetail': { ru: '43.5 / 64 ГБ', en: '43.5 / 64 GB' },
  'system.gpuSpecDetail': { ru: 'ВИДЕОКОНВЕЙЕР', en: 'VIDEO PIPELINE' },
  'system.storageSpecDetail': { ru: '2.8 / 4.0 ТБ', en: '2.8 / 4.0 TB' },
  'system.networkInLabel': { ru: 'ВХОДЯЩИЙ ТРАФИК', en: 'NETWORK IN' },
  'system.networkInSparklineLabel': { ru: 'Входящий трафик', en: 'Incoming traffic' },
  'system.networkOutLabel': { ru: 'ИСХОДЯЩИЙ ТРАФИК', en: 'NETWORK OUT' },
  'system.networkOutSparklineLabel': { ru: 'Исходящий трафик', en: 'Outgoing traffic' },

  'system.nodesTitle': { ru: 'СИСТЕМНЫЕ УЗЛЫ', en: 'SYSTEM NODES' },
  'system.nodesEyebrow': { ru: 'ЛОКАЛЬНАЯ ИНФРАСТРУКТУРА', en: 'LOCAL INFRASTRUCTURE' },
  'system.nodesColumnNode': { ru: 'УЗЕЛ', en: 'NODE' },
  'system.nodesColumnTypeIp': { ru: 'ТИП / IP', en: 'TYPE / IP' },
  'system.nodesColumnStatus': { ru: 'СТАТУС', en: 'STATUS' },
  'system.nodesColumnLoad': { ru: 'НАГРУЗКА', en: 'LOAD' },
  'system.nodesColumnTemp': { ru: 'ТЕМПЕРАТУРА', en: 'TEMP' },

  'system.networkTitle': { ru: 'СЕТЕВЫЕ КАНАЛЫ', en: 'NETWORK CHANNELS' },
  'system.networkEyebrow': { ru: 'ШИФРОВАННЫЕ КАНАЛЫ', en: 'ENCRYPTED LINKS' },
  'system.packetLossLabel': { ru: 'ПОТЕРИ', en: 'LOSS' },

  'system.auditTitle': { ru: 'ЖУРНАЛ АУДИТА', en: 'AUDIT LOG' },
  'system.auditEyebrow': {
    ru: 'ДЕЙСТВИЯ ОПЕРАТОРА / ТОЛЬКО ДОБАВЛЕНИЕ',
    en: 'OPERATOR ACTIONS / APPEND ONLY',
  },

  'system.storageTitle': { ru: 'КОНТУР ХРАНЕНИЯ', en: 'STORAGE CONTOUR' },
  'system.storageEyebrow': { ru: 'ЛОКАЛЬНО / АВТОНОМНО', en: 'LOCAL / OFFLINE' },
  'system.storageAreaCore': { ru: 'ЯДРО', en: 'CORE' },
  'system.storageAreaEvents': { ru: 'СОБЫТИЯ', en: 'EVENTS' },
  'system.storageAreaVideo': { ru: 'ВИДЕО', en: 'VIDEO' },
  'system.storageAreaEvidence': { ru: 'УЛИКИ', en: 'EVIDENCE' },
  'system.storageAreaSnapshots': { ru: 'СНИМКИ', en: 'SNAPSHOTS' },
  'system.storageIntegrityNote': {
    ru: 'ЦЕЛОСТНОСТЬ: VERIFIED / РЕПЛИКА: LOCAL-02 / ПОСЛЕДНЯЯ ПРОВЕРКА: 07:41:52',
    en: 'INTEGRITY: VERIFIED / REPLICA: LOCAL-02 / LAST CHECK: 07:41:52',
  },

  'system.nativeMediaTitle': { ru: 'НАТИВНЫЙ МЕДИАШЛЮЗ', en: 'NATIVE MEDIA GATEWAY' },
  'system.nativeMediaEyebrow': {
    ru: 'НАТИВНЫЙ ШЛЮЗ / RTSP В HLS',
    en: 'NATIVE GATEWAY / RTSP TO HLS',
  },
  'system.mediaGatewayNoResponse': {
    ru: 'ШЛЮЗ НЕ ОТВЕЧАЕТ: {error}',
    en: 'GATEWAY NOT RESPONDING: {error}',
  },
  'system.mediaGatewayWebOnlyNotice': {
    ru: 'НАТИВНЫЙ МЕДИАШЛЮЗ ЕСТЬ ТОЛЬКО В ДЕСКТОП-СБОРКЕ: В ВЕБ-СЕССИИ СЧЁТЧИКОВ ШЛЮЗА НЕТ.',
    en: 'THE NATIVE MEDIA GATEWAY EXISTS ONLY IN THE DESKTOP BUILD: A WEB SESSION HAS NO GATEWAY COUNTERS.',
  },
  'system.mediaGatewayStoppedNotice': {
    ru: 'ШЛЮЗ ОСТАНОВЛЕН: ПОТОКИ НЕ ОБСЛУЖИВАЮТСЯ.',
    en: 'GATEWAY STOPPED: NO STREAMS ARE SERVED.',
  },
  'system.mediaGatewaySourcesLabel': { ru: 'ИСТОЧНИКОВ', en: 'SOURCES' },
  'system.mediaGatewayLimitDetail': { ru: 'ЛИМИТ {limit}', en: 'LIMIT {limit}' },
  'system.mediaGatewayActiveLabel': { ru: 'АКТИВНО', en: 'ACTIVE' },
  'system.mediaGatewayStartingDetail': { ru: 'ЗАПУСК {count}', en: 'STARTING {count}' },
  'system.mediaGatewayStableDetail': { ru: 'УСТОЙЧИВО', en: 'STABLE' },
  'system.mediaGatewayReconnectingLabel': { ru: 'ПЕРЕПОДКЛЮЧЕНИЕ', en: 'RECONNECTING' },
  'system.mediaGatewayBackoffDetail': { ru: 'С ЗАДЕРЖКОЙ', en: 'BACKOFF' },
  'system.mediaGatewayFailedLabel': { ru: 'ОТКАЗ', en: 'FAILED' },
  'system.mediaGatewayDegradedDetail': { ru: 'ДЕГРАДАЦИЯ', en: 'DEGRADED' },
  'system.mediaGatewayColumnCamera': { ru: 'КАМЕРА', en: 'CAMERA' },
  'system.mediaGatewayColumnState': { ru: 'СОСТОЯНИЕ', en: 'STATE' },
  'system.mediaGatewayColumnViewers': { ru: 'ЗРИТЕЛИ', en: 'VIEWERS' },
  'system.mediaGatewayColumnFailuresRestarts': {
    ru: 'СБОЕВ / ПЕРЕЗАПУСКОВ',
    en: 'FAILURES / RESTARTS',
  },
  'system.mediaGatewayColumnManifest': { ru: 'МАНИФЕСТ', en: 'MANIFEST' },
  'system.mediaGatewayManifestNone': { ru: 'НЕТ', en: 'NONE' },
  'system.mediaGatewayOriginLabel': { ru: 'ИСТОЧНИК: {origin}', en: 'ORIGIN: {origin}' },

  'system.measuredTelemetryTitle': { ru: 'ИЗМЕРЕННАЯ ТЕЛЕМЕТРИЯ', en: 'MEASURED TELEMETRY' },
  'system.measuredTelemetryEyebrow': {
    ru: 'CONTROL PLANE / ИЗМЕРЕНО',
    en: 'CONTROL PLANE / MEASURED',
  },
  'system.simulatedSourceDetail': { ru: 'СИМУЛИРОВАННЫЙ ИСТОЧНИК', en: 'SIMULATED SOURCE' },
  'system.hostSourceDetail': { ru: 'ИСТОЧНИК ХОСТА', en: 'HOST SOURCE' },

  'system.telemetryNativeCaption': {
    ru: 'NATIVE / ИСТОЧНИК НЕДОСТУПЕН',
    en: 'NATIVE / SOURCE UNAVAILABLE',
  },
  'system.telemetryNativeNotice': {
    ru: 'ИСТОЧНИК ТЕЛЕМЕТРИИ NATIVE НЕ ЧИТАЕТСЯ В ЭТОЙ СБОРКЕ: СЧЁТЧИКОВ ХОСТА НЕТ НИ В ВЕБ-, НИ В ДЕСКТОП-СЛОЕ. ВЫБЕРИТЕ SIMULATION ИЛИ HYBRID.',
    en: 'THE NATIVE TELEMETRY SOURCE READS NOTHING IN THIS BUILD: THERE ARE NO HOST COUNTERS IN EITHER THE WEB OR THE DESKTOP LAYER. CHOOSE SIMULATION OR HYBRID.',
  },
  'system.telemetryHybridCaption': {
    ru: 'HYBRID / ЗАМЕЩЕНО СИМУЛЯЦИЕЙ',
    en: 'HYBRID / SUBSTITUTED BY SIMULATION',
  },
  'system.telemetryHybridNotice': {
    ru: 'СЧЁТЧИКИ ХОСТА НЕДОСТУПНЫ: ВСЕ РЯДЫ ВЗЯТЫ ИЗ СИМУЛЯЦИИ.',
    en: 'HOST COUNTERS ARE UNAVAILABLE: EVERY SERIES IS TAKEN FROM THE SIMULATION.',
  },
  'system.telemetrySimulationCaption': {
    ru: 'SIM / ДЕТЕРМИНИРОВАННЫЙ МИР',
    en: 'SIM / DETERMINISTIC WORLD',
  },
  'system.telemetrySeriesTagNative': { ru: 'Н/Д', en: 'N/A' },
  'system.telemetrySeriesTagSimulated': { ru: 'СИМ', en: 'SIM' },

  // =======================================================================
  // System screen: unit abbreviations this module needs of its own
  // =======================================================================
  'systemUnit.seconds': { ru: 'С', en: 'S' },
  'systemUnit.samples': { ru: 'ЗАМ', en: 'SMP' },

  // =======================================================================
  // Developer contour: DeveloperGate and DeveloperPanel
  // =======================================================================
  'developer.badge': { ru: 'ИНЖ', en: 'DEV' },
  'developer.panelHeading': { ru: 'ИНЖЕНЕРНЫЙ КОНТУР', en: 'ENGINEERING CONTOUR' },
  'developer.localOnlyLabel': { ru: 'ТОЛЬКО ЛОКАЛЬНО', en: 'LOCAL ONLY' },
  'developer.closeAriaLabel': {
    ru: 'Закрыть инженерный контур',
    en: 'Close the engineering contour',
  },
  'developer.accessRestrictedHeading': { ru: 'ДОСТУП ОГРАНИЧЕН', en: 'ACCESS RESTRICTED' },
  'developer.enterCodeInstruction': {
    ru: 'Введите локальный код проекта. Данные не отправляются в сеть.',
    en: "Enter the project's local code. No data leaves this machine.",
  },
  'developer.accessCodeAriaLabel': { ru: 'Код инженерного доступа', en: 'Engineering access code' },
  'developer.unlockButton': { ru: 'РАЗБЛОКИРОВАТЬ', en: 'UNLOCK' },
  'developer.codeRejectedNotice': { ru: 'КОД НЕ ПРИНЯТ', en: 'CODE REJECTED' },
  'developer.alternativeShortcutNote': {
    ru: 'Альтернативный вызов: Ctrl + Shift + Alt + D',
    en: 'Alternative trigger: Ctrl + Shift + Alt + D',
  },

  'developer.tabStates': { ru: 'СОСТОЯНИЯ', en: 'STATES' },
  'developer.tabScenes': { ru: 'СЦЕНЫ', en: 'SCENES' },
  'developer.tabScreens': { ru: 'ЭКРАНЫ', en: 'SCREENS' },
  'developer.tabData': { ru: 'ДАННЫЕ', en: 'DATA' },
  'developer.tabFiles': { ru: 'ФАЙЛЫ', en: 'FILES' },
  'developer.tabMedia': { ru: 'МЕДИА', en: 'MEDIA' },
  'developer.tabSimulation': { ru: 'СИМУЛЯЦИЯ', en: 'SIMULATION' },
  'developer.tabBridge': { ru: 'МОСТ', en: 'BRIDGE' },
  'developer.tabSnapshots': { ru: 'СНИМКИ', en: 'SNAPSHOTS' },
  'developer.tabDiagnostics': { ru: 'ДИАГНОСТИКА', en: 'DIAGNOSTICS' },

  'developer.simulationFlagsHeading': { ru: 'ФЛАГИ СИМУЛЯЦИИ', en: 'SIMULATION FLAGS' },
  'developer.simulationFlagCheckboxLabel': { ru: 'Симуляция {flag}', en: 'Simulation {flag}' },
  'developer.onLabel': { ru: 'ВКЛ', en: 'ON' },
  'developer.offLabel': { ru: 'ВЫКЛ', en: 'OFF' },
  'developer.revisionLabel': { ru: 'РЕВ. {revision}', en: 'REV {revision}' },

  'developer.nativeDisplaysHeading': { ru: 'НАТИВНЫЕ ДИСПЛЕИ', en: 'NATIVE DISPLAYS' },
  'developer.nativeShellUnavailableNotice': {
    ru: 'НАТИВНАЯ ОБОЛОЧКА НЕДОСТУПНА В ЭТОЙ СЕССИИ: УПРАВЛЕНИЕ ОКНАМИ ЕСТЬ ТОЛЬКО В ДЕСКТОП-СБОРКЕ.',
    en: 'THE NATIVE SHELL IS UNAVAILABLE IN THIS SESSION: WINDOW MANAGEMENT EXISTS ONLY IN THE DESKTOP BUILD.',
  },
  'developer.pollMonitorsButton': { ru: 'ОПРОСИТЬ МОНИТОРЫ', en: 'POLL MONITORS' },
  'developer.monitorsFoundReport': {
    ru: 'МОНИТОРОВ НАЙДЕНО: {count}',
    en: 'MONITORS FOUND: {count}',
  },
  'developer.openScreenWindowsButton': {
    ru: 'ОТКРЫТЬ ОКНА ЭКРАНОВ ({count})',
    en: 'OPEN SCREEN WINDOWS ({count})',
  },
  'developer.windowsOpenedReport': {
    ru: 'ОКОН ОТКРЫТО: {opened} ИЗ {total}',
    en: 'WINDOWS OPENED: {opened} OF {total}',
  },
  'developer.windowsOpenedWithFailuresReport': {
    ru: 'ОКОН ОТКРЫТО: {opened} ИЗ {total}. ОТКАЗЫ: {failures}',
    en: 'WINDOWS OPENED: {opened} OF {total}. FAILURES: {failures}',
  },
  'developer.closeManagedWindowsButton': {
    ru: 'ЗАКРЫТЬ УПРАВЛЯЕМЫЕ ОКНА',
    en: 'CLOSE MANAGED WINDOWS',
  },
  'developer.managedWindowsClosedReport': {
    ru: 'УПРАВЛЯЕМЫЕ ОКНА ЗАКРЫТЫ',
    en: 'MANAGED WINDOWS CLOSED',
  },
  'developer.closeFailedReport': { ru: 'ОТКАЗ: {reason}', en: 'FAILED: {reason}' },
  'developer.nativeShellUnavailableReport': {
    ru: 'НАТИВНАЯ ОБОЛОЧКА НЕДОСТУПНА',
    en: 'NATIVE SHELL UNAVAILABLE',
  },
  'developer.unnamedMonitorLabel': { ru: 'БЕЗ ИМЕНИ', en: 'UNNAMED' },
  'developer.primaryMonitorSuffix': { ru: ' · ОСНОВНОЙ', en: ' · PRIMARY' },

  'developer.snapshotsHeading': { ru: 'СНИМКИ', en: 'SNAPSHOTS' },
  'developer.snapshotsDescription': {
    ru: 'Состояние хранится локально и экспортируется как JSON без сетевого запроса.',
    en: 'State lives locally and exports as JSON with no network request.',
  },
  'developer.saveSnapshotDialogTitle': { ru: 'СОХРАНИТЬ SNAPSHOT', en: 'SAVE SNAPSHOT' },
  'developer.saveSnapshotDialogEyebrow': {
    ru: 'ЛОКАЛЬНОЕ СОСТОЯНИЕ / ВЕРСИОНИРОВАНО',
    en: 'LOCAL STATE / VERSIONED',
  },
  'developer.saveSnapshotDialogDescription': {
    ru: 'Задайте имя локальной точки восстановления. Данные не отправляются в сеть.',
    en: 'Name the local restore point. No data leaves this machine.',
  },
  'developer.confirmSaveButton': { ru: '[ENTER] СОХРАНИТЬ', en: '[ENTER] SAVE' },
  'developer.snapshotNameAriaLabel': { ru: 'Имя snapshot', en: 'Snapshot name' },
  'developer.exportCurrentStateButton': {
    ru: 'ЭКСПОРТ ТЕКУЩЕГО СОСТОЯНИЯ',
    en: 'EXPORT CURRENT STATE',
  },
  'developer.restoreButton': { ru: 'ВОССТАНОВИТЬ', en: 'RESTORE' },
  'developer.deleteButton': { ru: 'УДАЛИТЬ', en: 'DELETE' },
  'developer.rehearsalPrefix': { ru: 'РЕПЕТИЦИЯ {time}', en: 'REHEARSAL {time}' },
} as const satisfies CatalogModule;
