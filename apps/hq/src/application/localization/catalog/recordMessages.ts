import type { CatalogModule } from './catalogTypes';

/**
 * The record screens -- overview, tactical map, cases, analytics, objects,
 * search, reports, communications and archive -- plus the Yandex map surface
 * they all share.
 *
 * These nine screens were written before this catalogue existed: every title,
 * eyebrow, column heading and button caption was typed straight into the JSX,
 * which is what `localization.locale` set to `en` proved -- the operator read
 * Russian regardless of the setting. This module is that debt paid off for
 * those files only; the other surfaces have their own modules.
 *
 * ## Shared field and unit vocabulary
 *
 * `field.*` and `unit.*` already existed in `materialMessages.ts` for the
 * material and transport surfaces. A record screen's table column or
 * definition list asks for the same words -- a status, a source, a type, a
 * channel -- and a second `'СТАТУС'` entry under a different id would be a
 * translation that silently drifts from the first the day either one is
 * edited. Where this module's screens need a field or unit `materialMessages`
 * does not already carry, the entry is added here rather than duplicated
 * under a screen-specific id, on the same reasoning: one word, one id,
 * wherever it is read.
 *
 * ## Reused ids from other modules
 *
 * A handful of labels here are exact matches for text `chromeMessages.ts`
 * already carries -- `nav.map`, `nav.comms`, `nav.archive` -- and this module
 * calls through to those ids rather than declaring its own. `catalog/index.ts`
 * merges every module into one flat lookup, so nothing about calling
 * `t('nav.map')` from a record screen says which module answered it.
 *
 * ## World content left alone
 *
 * `CasesScreen.tsx`'s storage tree (the folder names, the project path) and
 * the generated document body in `ReportsScreen.tsx`'s preview panel are the
 * film's own fiction, not chrome this catalogue is the source of. Both stay
 * exactly as written; see the localization wave's report for the file:line
 * list.
 */
export const recordMessages = {
  // Shared field labels this module needed that materialMessages.ts did not
  // already carry. Reused across screens by id, not retyped per screen.
  'field.altitude': { ru: 'ВЫСОТА', en: 'ALTITUDE' },
  'field.alerts': { ru: 'ТРЕВОГИ', en: 'ALERTS' },
  'field.birthDate': { ru: 'ДАТА РОЖДЕНИЯ', en: 'DATE OF BIRTH' },
  'field.case': { ru: 'ДЕЛО', en: 'CASE' },
  'field.channel': { ru: 'КАНАЛ', en: 'CHANNEL' },
  'field.citizenship': { ru: 'ГРАЖДАНСТВО', en: 'CITIZENSHIP' },
  'field.created': { ru: 'СОЗДАНО', en: 'CREATED' },
  'field.document': { ru: 'ДОКУМЕНТ', en: 'DOCUMENT' },
  'field.events': { ru: 'СОБЫТИЯ', en: 'EVENTS' },
  'field.kindAudio': { ru: 'АУДИО', en: 'AUDIO' },
  'field.kindImage': { ru: 'ИЗОБРАЖЕНИЕ', en: 'IMAGE' },
  'field.kindReport': { ru: 'ОТЧЁТ', en: 'REPORT' },
  'field.kindVideo': { ru: 'ВИДЕО', en: 'VIDEO' },
  'field.lastSeen': { ru: 'ПОСЛЕДНИЙ КОНТАКТ', en: 'LAST SEEN' },
  'field.load': { ru: 'НАГРУЗКА', en: 'LOAD' },
  'field.materials': { ru: 'МАТЕРИАЛЫ', en: 'MATERIALS' },
  'field.operator': { ru: 'ОПЕРАТОР', en: 'OPERATOR' },
  'field.packetLoss': { ru: 'ПОТЕРИ ПАКЕТОВ', en: 'PACKET LOSS' },
  'field.priority': { ru: 'ПРИОРИТЕТ', en: 'PRIORITY' },
  'field.role': { ru: 'РОЛЬ', en: 'ROLE' },
  'field.speed': { ru: 'СКОРОСТЬ', en: 'SPEED' },
  'field.threat': { ru: 'УГРОЗА', en: 'THREAT' },
  'field.type': { ru: 'ТИП', en: 'TYPE' },
  'unit.kmh': { ru: 'КМ/Ч', en: 'KM/H' },
  'unit.m': { ru: 'М', en: 'M' },
  'unit.mbps': { ru: 'МБ/С', en: 'MB/S' },
  'unit.ms': { ru: 'МС', en: 'MS' },

  // Shared master-detail chrome: a registry's footer and a detail panel's
  // fallback eyebrow read the same across every screen that has both.
  'registry.noSelection': { ru: 'НЕ ВЫБРАНО', en: 'NO SELECTION' },
  'registry.selectedFooter': { ru: 'ВЫБРАНО: {id}', en: 'SELECTED: {id}' },

  // OverviewScreen.tsx
  'overview.activeAlertsLabel': { ru: 'АКТИВНЫХ ТРЕВОГ', en: 'ACTIVE ALERTS' },
  'overview.briefEyebrow': { ru: 'СВОДКА / ТЕКУЩАЯ ФАЗА', en: 'BRIEF / CURRENT PHASE' },
  'overview.briefTitle': { ru: 'ОБЗОР ОПЕРАЦИИ', en: 'OPERATION BRIEF' },
  'overview.directionAnalysis': { ru: 'АНАЛИЗ', en: 'ANALYSIS' },
  'overview.directionCollection': { ru: 'СБОР', en: 'COLLECTION' },
  'overview.directionIntelligence': { ru: 'РАЗВЕДКА', en: 'INTELLIGENCE' },
  'overview.directionOperations': { ru: 'ОПЕРАЦИИ', en: 'OPERATIONS' },
  'overview.directionSupport': { ru: 'ПОДДЕРЖКА', en: 'SUPPORT' },
  'overview.directionsEyebrow': { ru: 'НАПРАВЛЕНИЯ / АНАЛИТИКА', en: 'DIRECTIONS / ANALYTICS' },
  'overview.directionsTitle': { ru: 'ПРОГРЕСС ПО НАПРАВЛЕНИЯМ', en: 'PROGRESS BY DIRECTION' },
  'overview.evidenceEyebrow': { ru: 'ДОКАЗАТЕЛЬСТВА / ЛОКАЛЬНО', en: 'EVIDENCE / LOCAL' },
  'overview.evidenceTitle': { ru: 'СОБРАННЫЕ ДОКАЗАТЕЛЬСТВА', en: 'COLLECTED EVIDENCE' },
  'overview.eventsEyebrow': {
    ru: 'ШИНА СОБЫТИЙ / В РЕАЛЬНОМ ВРЕМЕНИ',
    en: 'EVENT BUS / LIVE',
  },
  'overview.eventsTitle': { ru: 'ПОСЛЕДНИЕ ОБНОВЛЕНИЯ', en: 'LATEST UPDATES' },
  'overview.firstAlertButton': { ru: '[ENTER] ПЕРВАЯ ТРЕВОГА', en: '[ENTER] FIRST ALERT' },
  'overview.metricCompleted': { ru: 'ВЫПОЛНЕНО', en: 'COMPLETED' },
  'overview.metricInProgress': { ru: 'В ПРОЦЕССЕ', en: 'IN PROGRESS' },
  'overview.metricNeutralized': { ru: 'НЕЙТРАЛИЗОВАНО', en: 'NEUTRALIZED' },
  'overview.metricPending': { ru: 'ОЖИДАЕТ', en: 'PENDING' },
  'overview.metricSignalLost': { ru: 'ПОТЕРЯ СИГНАЛА', en: 'SIGNAL LOST' },
  'overview.metricTotal': { ru: 'ВСЕГО', en: 'TOTAL' },
  'overview.metricUnderway': { ru: 'В РАБОТЕ', en: 'UNDERWAY' },
  'overview.milestonesEyebrow': { ru: 'ВЕХИ / ПОДТВЕРЖДЕНО', en: 'MILESTONES / VERIFIED' },
  'overview.milestonesTitle': { ru: 'КЛЮЧЕВЫЕ ВЕХИ', en: 'KEY MILESTONES' },
  'overview.objectivesEyebrow': { ru: 'ЦЕЛИ / ЧЕК-ЛИСТ', en: 'OBJECTIVES / CHECKLIST' },
  'overview.objectivesTitle': { ru: 'ЦЕЛИ ОПЕРАЦИИ', en: 'OPERATION OBJECTIVES' },
  'overview.openFullCardButton': { ru: '[ENTER] ПОЛНАЯ КАРТОЧКА', en: '[ENTER] FULL CARD' },
  'overview.openMapButton': { ru: '[04] ОТКРЫТЬ КАРТУ', en: '[04] OPEN MAP' },
  'overview.operationCodeLabel': { ru: 'ОПЕРАЦИЯ / {code}', en: 'OPERATION / {code}' },
  'overview.overallProgressLabel': { ru: 'ОБЩИЙ ПРОГРЕСС', en: 'OVERALL PROGRESS' },
  'overview.periodLabel': { ru: 'ПЕРИОД', en: 'PERIOD' },
  'overview.readinessEyebrow': { ru: 'МИССИЯ / ГОТОВНОСТЬ', en: 'MISSION / READINESS' },
  'overview.readinessGaugeDetail': {
    ru: 'ПОРОГ ДОПУСКА 80%',
    en: 'CLEARANCE THRESHOLD 80%',
  },
  'overview.readinessGaugeLabel': { ru: 'ОБЩАЯ ГОТОВНОСТЬ', en: 'OVERALL READINESS' },
  'overview.readinessIntel': { ru: 'РАЗВЕДДАННЫЕ', en: 'INTELLIGENCE DATA' },
  'overview.readinessLogistics': { ru: 'ЛОГИСТИКА', en: 'LOGISTICS' },
  'overview.readinessPersonnel': { ru: 'ЛИЧНЫЙ СОСТАВ', en: 'PERSONNEL' },
  'overview.readinessTechnical': { ru: 'ТЕХНИЧЕСКИЕ СРЕДСТВА', en: 'TECHNICAL ASSETS' },
  'overview.readinessTitle': { ru: 'ГОТОВНОСТЬ К МИССИИ', en: 'MISSION READINESS' },
  'overview.sectorEyebrow': { ru: 'ГЕО / S-03', en: 'GEO / S-03' },
  'overview.sectorPhaseLabel': {
    ru: 'СЕКТОР S-03 / ЦЕЛЬ K-17 / ФАЗА {phase}',
    en: 'SECTOR S-03 / TARGET K-17 / PHASE {phase}',
  },
  'overview.sectorReadoutLabel': {
    ru: 'ПРОМЫШЛЕННАЯ ЗОНА / КОНТУР 3',
    en: 'INDUSTRIAL ZONE / PERIMETER 3',
  },
  'overview.sectorSchemeAlt': { ru: 'Схема сектора операции', en: 'Operation sector schematic' },
  'overview.sectorTitle': { ru: 'СЕКТОР ОПЕРАЦИИ', en: 'OPERATION SECTOR' },
  // Guillemets in ru, matching the register `case.title` and every other
  // in-app quotation already uses; English has no equivalent convention, so
  // the en side quotes with the ASCII mark instead of reusing the Cyrillic one.
  'overview.summaryPrefix': { ru: 'СВОДКА ОПЕРАЦИИ «', en: 'OPERATION SUMMARY "' },
  'overview.summarySuffix': { ru: '»', en: '"' },
  'overview.targetsEyebrow': { ru: 'ЦЕЛИ / СВЯЗАННЫЕ', en: 'TARGETS / LINKED' },
  'overview.targetsTitle': { ru: 'ЦЕЛИ', en: 'TARGETS' },
  'overview.tasksEyebrow': { ru: 'ЗАДАЧИ / В РЕАЛЬНОМ ВРЕМЕНИ', en: 'TASKS / LIVE' },
  'overview.tasksTitle': { ru: 'АКТИВНЫЕ ЗАДАЧИ', en: 'ACTIVE TASKS' },
  'overview.threatsEyebrow': { ru: 'УГРОЗА / СЕКТОРЫ', en: 'THREAT / SECTORS' },
  'overview.threatsTitle': {
    ru: 'УРОВЕНЬ УГРОЗЫ ПО СЕКТОРАМ',
    en: 'THREAT LEVEL BY SECTOR',
  },
  'overview.timelineEyebrow': { ru: 'ХРОНОЛОГИЯ / 09–19 СЕН', en: 'TIMELINE / 09–19 SEP' },
  'overview.timelineTitle': { ru: 'ХРОНОЛОГИЯ ОПЕРАЦИИ', en: 'OPERATION TIMELINE' },

  // TacticalMapScreen.tsx and YandexTacticalMap.tsx: both draw the one map
  // surface the operator sees, so they share the `map.*` and `yandexMap.*`
  // areas rather than being told apart by which file happens to hold the id.
  'map.alertsEyebrow': { ru: 'ТРЕВОГИ / ТЕКУЩИЙ РАЙОН', en: 'ALERTS / CURRENT AREA' },
  'map.alertsTitle': { ru: 'АКТИВНЫЕ ТРЕВОГИ', en: 'ACTIVE ALERTS' },
  'map.channelColumnEncryption': { ru: 'ШИФР', en: 'ENC' },
  'map.channelsEyebrow': { ru: 'СВЯЗЬ / ШИФРОВАНО', en: 'COMMS / ENCRYPTED' },
  'map.channelsPaginationLabel': {
    ru: 'Страницы таблицы каналов связи',
    en: 'Communication channel table pages',
  },
  'map.channelsTitle': { ru: 'КАНАЛЫ СВЯЗИ', en: 'COMMUNICATION CHANNELS' },
  'map.headerRepresentationLabel': {
    ru: 'ГЕО / {mode} / ЛОКАЛЬНЫЙ ВЕКТОРНЫЙ СЛОЙ',
    en: 'GEO / {mode} / LOCAL VECTOR LAYER',
  },
  'map.historyButton': { ru: '[H] ИСТОРИЯ', en: '[H] HISTORY' },
  'map.layerFriendly': { ru: 'СВОИ ПОДРАЗДЕЛЕНИЯ', en: 'FRIENDLY UNITS' },
  'map.layerHostile': { ru: 'ПРОТИВНИК', en: 'HOSTILE' },
  'map.layerInfrastructure': { ru: 'ИНФРАСТРУКТУРА', en: 'INFRASTRUCTURE' },
  'map.layerNeutral': { ru: 'НЕЙТРАЛЬНЫЕ', en: 'NEUTRAL' },
  'map.layerRestricted': { ru: 'ЗОНЫ ОГРАНИЧЕНИЙ', en: 'RESTRICTED ZONES' },
  'map.layerRoutes': { ru: 'МАРШРУТЫ', en: 'ROUTES' },
  'map.layerSensors': { ru: 'ДАТЧИКИ', en: 'SENSORS' },
  'map.layerTasks': { ru: 'МАРКЕРЫ И ЗАДАЧИ', en: 'MARKERS AND TASKS' },
  'map.layersEyebrow': { ru: 'СТЕК СЛОЁВ / СОХРАНЯЕТСЯ', en: 'LAYER STACK / PERSISTED' },
  'map.layersTitle': { ru: 'СЛОИ', en: 'LAYERS' },
  'map.legendFriendlyShort': { ru: 'СВОЙ', en: 'FRIENDLY' },
  'map.legendHostileShort': { ru: 'УГРОЗА', en: 'HOSTILE' },
  'map.legendLabel': { ru: 'ЛЕГЕНДА', en: 'LEGEND' },
  'map.legendNeutralShort': { ru: 'НЕЙТРАЛЬНЫЙ', en: 'NEUTRAL' },
  'map.openVideoButton': { ru: '[V] ВИДЕО', en: '[V] VIDEO' },
  'map.representationHidesLabel': {
    ru: 'РЕЖИМ «{mode}» НЕ ОТРИСОВЫВАЕТ: {list}',
    en: 'MODE "{mode}" DOES NOT DRAW: {list}',
  },
  'map.representationTactical': { ru: 'ТАКТИКА', en: 'TACTICAL' },
  'map.representationSatellite': { ru: 'СПУТНИК', en: 'SATELLITE' },
  'map.resetViewButton': { ru: '[R] СБРОС ВИДА', en: '[R] RESET VIEW' },
  'map.routesEyebrow': { ru: 'МАРШРУТЫ / 08', en: 'ROUTES / 08' },
  'map.routesTitle': { ru: 'МАРШРУТЫ И КОРИДОРЫ', en: 'ROUTES AND CORRIDORS' },
  'map.satelliteUnavailableLabel': { ru: 'СНИМКИ НЕДОСТУПНЫ', en: 'IMAGERY UNAVAILABLE' },
  'map.selectedEyebrow': { ru: 'ТРЕК / ТЕКУЩИЙ', en: 'TRACK / CURRENT' },
  'map.selectedTitle': { ru: 'ВЫБРАННЫЙ ОБЪЕКТ', en: 'SELECTED OBJECT' },
  'map.sensorsEyebrow': { ru: 'ДАТЧИКИ / В РЕАЛЬНОМ ВРЕМЕНИ', en: 'SENSORS / LIVE' },
  'map.sensorsTitle': { ru: 'СИГНАЛЫ И ДАТЧИКИ', en: 'SIGNALS AND SENSORS' },
  'map.surfaceTitle': { ru: 'ТАКТИЧЕСКАЯ КАРТА', en: 'TACTICAL MAP' },
  'map.trackButton': { ru: '[T] СОПРОВОЖДАТЬ', en: '[T] TRACK' },
  'map.viewObjectButton': { ru: '[O] ОБЪЕКТ', en: '[O] OBJECT' },
  'map.zoomInButton': { ru: '[+] УВЕЛИЧИТЬ', en: '[+] ZOOM IN' },
  'map.zoomOutButton': { ru: '[-] УМЕНЬШИТЬ', en: '[-] ZOOM OUT' },

  'yandexMap.applyKeyButton': { ru: '[APPLY] ПОДКЛЮЧИТЬ', en: '[APPLY] CONNECT' },
  'yandexMap.centerLabel': { ru: 'ЦЕНТР', en: 'CENTER' },
  'yandexMap.fallbackAriaLabel': { ru: 'Резервные данные карты', en: 'Fallback map data' },
  'yandexMap.fallbackHeading': {
    ru: '[ ДАННЫЕ КАРТЫ / ЛОКАЛЬНЫЙ РЕЗЕРВ ]',
    en: '[ MAP DATA / LOCAL FALLBACK ]',
  },
  'yandexMap.initializingHeading': {
    ru: '[ ИНИЦИАЛИЗАЦИЯ ВЕКТОРНОГО СЛОЯ YANDEX... ]',
    en: '[ INITIALIZING YANDEX VECTOR LAYER... ]',
  },
  'yandexMap.keyInputAriaLabel': { ru: 'Ключ Yandex Maps API v3', en: 'Yandex Maps API v3 key' },
  'yandexMap.keyInputPlaceholder': {
    ru: 'JavaScript API v3 ключ',
    en: 'JavaScript API v3 key',
  },
  'yandexMap.keyRequiredHeading': {
    ru: '[ YANDEX MAPS API V3 // ТРЕБУЕТСЯ КЛЮЧ ]',
    en: '[ YANDEX MAPS API V3 // KEY REQUIRED ]',
  },
  'yandexMap.keyRequiredHint': {
    ru: 'Введите JavaScript API-ключ v3 с ограничением HTTP Referer для этого устройства',
    en: 'Enter a JavaScript API v3 key restricted by HTTP Referer for this device',
  },
  'yandexMap.keyStorageHint': {
    ru: 'Ключ хранится только на устройстве. Для production-сборки используйте {envVar}.',
    en: 'The key is stored on this device only. Use {envVar} for a production build.',
  },
  'yandexMap.offlineStatus': {
    ru: 'YANDEX MAPS API V3 ОФФЛАЙН',
    en: 'YANDEX MAPS API V3 OFFLINE',
  },
  'yandexMap.providerUnavailableHeading': {
    ru: '[ ПРОВАЙДЕР КАРТЫ V3 НЕДОСТУПЕН ]',
    en: '[ MAP PROVIDER V3 UNAVAILABLE ]',
  },
  'yandexMap.providerUnavailableHint': {
    ru: 'Проверьте ключ v3, HTTP Referer, доступ к api-maps.yandex.ru и лимиты проекта.',
    en: 'Check the v3 key, HTTP Referer, access to api-maps.yandex.ru and the project limits.',
  },
  'yandexMap.replaceKeyButton': { ru: '[R] ЗАМЕНИТЬ КЛЮЧ', en: '[R] REPLACE KEY' },
  'yandexMap.scaleLabel': { ru: 'МАСШТАБ', en: 'SCALE' },
  'yandexMap.sectionAriaLabel': {
    ru: 'Тактическая карта Yandex Maps API v3',
    en: 'Tactical map, Yandex Maps API v3',
  },

  // CasesScreen.tsx. The storage tree (folder names, the project path under
  // `footer`) is the film's own fiction rather than chrome and is left out of
  // this catalogue entirely -- see the wave's report for the file:line list.
  'cases.addressesHeading': { ru: 'АДРЕСА', en: 'ADDRESSES' },
  'cases.attachedMaterialsHeading': {
    ru: 'ПРИКРЕПЛЁННЫЕ МАТЕРИАЛЫ',
    en: 'ATTACHED MATERIALS',
  },
  'cases.columnCode': { ru: 'КОД', en: 'CODE' },
  'cases.columnDossier': { ru: 'ДОСЬЕ', en: 'DOSSIER' },
  'cases.dossierTitle': { ru: 'КАРТОЧКА ДОСЬЕ', en: 'DOSSIER CARD' },
  'cases.fileViewerButton': { ru: '[V] ПРОСМОТР ФАЙЛА', en: '[V] FILE VIEWER' },
  'cases.headerEyebrow': { ru: 'РЕЕСТР / ДОСЬЕ / ЛОКАЛЬНО', en: 'REGISTRY / DOSSIER / LOCAL' },
  'cases.headerTitle': { ru: 'ДЕЛА И ДОСЬЕ', en: 'CASES AND DOSSIERS' },
  'cases.mapMarker': { ru: '[КАРТА]', en: '[MAP]' },
  'cases.noCasesFound': { ru: 'ДЕЛА НЕ ОБНАРУЖЕНЫ', en: 'NO CASES FOUND' },
  'cases.noDossierSelected': { ru: 'ДОСЬЕ НЕ ВЫБРАНО', en: 'NO DOSSIER SELECTED' },
  'cases.openFullCardButton': {
    ru: '[ENTER] ОТКРЫТЬ ПОЛНУЮ КАРТОЧКУ',
    en: '[ENTER] OPEN FULL CARD',
  },
  'cases.paginationLabel': { ru: 'Страницы реестра дел', en: 'Case registry pages' },
  'cases.personMarker': { ru: '[ ЛИЦО / {id} ]', en: '[ PERSON / {id} ]' },
  'cases.registryCountLabel': { ru: 'РЕЕСТР', en: 'REGISTRY' },
  'cases.registryEyebrow': {
    ru: {
      one: '{folder} / {count} ЗАПИСЬ',
      few: '{folder} / {count} ЗАПИСИ',
      many: '{folder} / {count} ЗАПИСЕЙ',
      other: '{folder} / {count} ЗАПИСИ',
    },
    en: { one: '{folder} / {count} RECORD', other: '{folder} / {count} RECORDS' },
  },
  'cases.registryTitle': { ru: 'РЕЕСТР ДЕЛ', en: 'CASE REGISTRY' },
  'cases.restrictedCountLabel': { ru: 'ОГРАНИЧЕНО', en: 'RESTRICTED' },
  'cases.searchAriaLabel': { ru: 'Поиск по реестру дел', en: 'Search the case registry' },
  'cases.searchPlaceholder': { ru: 'ПОИСК ПО РЕЕСТРУ', en: 'SEARCH REGISTRY' },
  'cases.sortLabel': { ru: '[{arrow}] СОРТИРОВКА', en: '[{arrow}] SORT' },
  'cases.statusActive': { ru: 'АКТИВЕН', en: 'ACTIVE' },
  'cases.statusAll': { ru: 'ВСЕ СТАТУСЫ', en: 'ALL STATUSES' },
  'cases.statusInProgress': { ru: 'В РАБОТЕ', en: 'IN PROGRESS' },
  'cases.statusRestricted': { ru: 'ОГРАНИЧЕН', en: 'RESTRICTED' },
  'cases.statusSelectLabel': { ru: 'Статус дела', en: 'Case status' },
  'cases.treeEyebrow': { ru: 'ДЕРЕВО ДЕЛ / ЛОКАЛЬНО', en: 'CASE TREE / LOCAL' },
  'cases.treeTitle': { ru: 'СТРУКТУРА ХРАНИЛИЩА', en: 'STORAGE STRUCTURE' },

  // AnalyticsScreen.tsx
  'analytics.circuitReadinessLabel': { ru: 'ГОТОВНОСТЬ КОНТУРА', en: 'CIRCUIT READINESS' },
  'analytics.confidenceEyebrow': { ru: 'ИСТОЧНИКИ / ДОСТОВЕРНОСТЬ', en: 'SOURCES / CONFIDENCE' },
  'analytics.confidenceTitle': { ru: 'НАДЁЖНОСТЬ ДАННЫХ', en: 'DATA RELIABILITY' },
  'analytics.correlationChartAriaLabel': {
    ru: 'График корреляции событий',
    en: 'Event correlation chart',
  },
  'analytics.correlationEyebrow': {
    ru: 'ШИНА СОБЫТИЙ / ПОСЛЕДНИЕ 120',
    en: 'EVENT BUS / LAST 120',
  },
  'analytics.correlationTitle': { ru: 'КОРРЕЛЯЦИЯ СОБЫТИЙ', en: 'EVENT CORRELATION' },
  'analytics.filterAll': { ru: 'ВСЕ', en: 'ALL' },
  'analytics.forecastDegradation': { ru: 'ДЕГРАДАЦИЯ {code}', en: 'DEGRADATION {code}' },
  'analytics.forecastEyebrow': {
    ru: 'ЛОКАЛЬНАЯ ЭВРИСТИКА / 45 МИН',
    en: 'LOCAL HEURISTIC / 45 MIN',
  },
  'analytics.forecastHorizonDetail': { ru: 'ГОРИЗОНТ 45 МИН', en: 'HORIZON 45 MIN' },
  'analytics.forecastIntersection': { ru: 'ПЕРЕСЕЧЕНИЕ {code}', en: 'INTERSECTION {code}' },
  'analytics.forecastOverload': { ru: 'ПЕРЕГРУЗКА {code}', en: 'OVERLOAD {code}' },
  'analytics.forecastSignalLoss': { ru: 'ПОТЕРЯ СИГНАЛА {code}', en: 'SIGNAL LOSS {code}' },
  'analytics.forecastStableValue': { ru: 'СТАБИЛЬНО+', en: 'STABLE+' },
  'analytics.forecastTitle': { ru: 'ПРОГНОЗ РИСКОВ', en: 'RISK FORECAST' },
  'analytics.headerEyebrow': {
    ru: 'АНАЛИТИЧЕСКОЕ ЯДРО / ЛОКАЛЬНАЯ МОДЕЛЬ',
    en: 'ANALYTICAL CORE / LOCAL MODEL',
  },
  'analytics.headerTitle': { ru: 'ОПЕРАТИВНАЯ АНАЛИТИКА', en: 'OPERATIONAL ANALYTICS' },
  'analytics.indexEyebrow': { ru: 'СВОДНЫЙ ПОКАЗАТЕЛЬ / T+07:42', en: 'COMPOSITE SCORE / T+07:42' },
  'analytics.indexSparklineLabel': {
    ru: 'Динамика индекса оперативной обстановки',
    en: 'Operational situation index over time',
  },
  'analytics.indexTitle': {
    ru: 'ИНДЕКС ОПЕРАЦИОННОЙ ОБСТАНОВКИ',
    en: 'OPERATIONAL SITUATION INDEX',
  },
  'analytics.insightsEyebrow': {
    ru: 'ВЫВОДЫ / С ПОМОЩЬЮ МАШИНЫ',
    en: 'INSIGHTS / MACHINE ASSISTED',
  },
  'analytics.insightsTitle': { ru: 'КЛЮЧЕВЫЕ ВЫВОДЫ', en: 'KEY INSIGHTS' },
  'analytics.legendCritical': { ru: 'КРИТИЧЕСКОЕ', en: 'CRITICAL' },
  'analytics.legendDeviation': { ru: 'ОТКЛОНЕНИЕ', en: 'DEVIATION' },
  'analytics.legendNormal': { ru: 'НОРМА', en: 'NORMAL' },
  'analytics.matrixEyebrow': { ru: 'УГРОЗА × ГОТОВНОСТЬ', en: 'THREAT × READINESS' },
  'analytics.matrixTitle': { ru: 'МАТРИЦА СЕКТОРОВ', en: 'SECTOR MATRIX' },
  'analytics.metricActiveObjects': { ru: 'АКТИВНЫЕ ОБЪЕКТЫ', en: 'ACTIVE OBJECTS' },
  'analytics.metricAverageThreat': { ru: 'СРЕДНЯЯ УГРОЗА', en: 'AVERAGE THREAT' },
  'analytics.metricForecast': { ru: 'ПРОГНОЗ', en: 'FORECAST' },
  'analytics.metricSignalQuality': { ru: 'КАЧЕСТВО СИГНАЛА', en: 'SIGNAL QUALITY' },
  'analytics.readyLabel': { ru: 'ГОТОВ', en: 'READY' },
  'analytics.sourceFieldTeams': { ru: 'ПОЛЕВЫЕ ГРУППЫ', en: 'FIELD TEAMS' },
  'analytics.sourceOpenSources': { ru: 'ОТКРЫТЫЕ ИСТОЧНИКИ', en: 'OPEN SOURCES' },
  'analytics.sourceRadioIntercept': { ru: 'РАДИОПЕРЕХВАТ', en: 'RADIO INTERCEPT' },
  'analytics.sourceSensors': { ru: 'СЕНСОРЫ', en: 'SENSORS' },
  'analytics.thresholdDetail': { ru: 'ПОРОГ: 80%', en: 'THRESHOLD: 80%' },

  // ObjectsScreen.tsx
  'objects.columnNameCallsign': { ru: 'ИМЯ / ПОЗЫВНОЙ', en: 'NAME / CALLSIGN' },
  'objects.detailTitle': { ru: 'КАРТОЧКА ОБЪЕКТА', en: 'OBJECT CARD' },
  'objects.headerDetailTitle': { ru: 'КАРТОЧКА ОБЪЕКТА {id}', en: 'OBJECT CARD {id}' },
  'objects.headerEyebrow': {
    ru: 'СУЩНОСТИ / НОРМАЛИЗОВАННЫЙ РЕЕСТР',
    en: 'ENTITIES / NORMALIZED REGISTRY',
  },
  'objects.headerRegistryTitle': { ru: 'РЕЕСТР ОБЪЕКТОВ', en: 'OBJECT REGISTRY' },
  'objects.idCallsignLabel': { ru: 'ID / ПОЗЫВНОЙ', en: 'ID / CALLSIGN' },
  'objects.kindAll': { ru: 'ВСЕ ТИПЫ', en: 'ALL TYPES' },
  'objects.kindDevice': { ru: 'УСТРОЙСТВА', en: 'DEVICES' },
  'objects.kindGroup': { ru: 'ГРУППЫ', en: 'GROUPS' },
  'objects.kindLabelDevice': { ru: 'УСТРОЙСТВО', en: 'DEVICE' },
  'objects.kindLabelGroup': { ru: 'ГРУППА', en: 'GROUP' },
  'objects.kindLabelPerson': { ru: 'ЛИЦО', en: 'PERSON' },
  'objects.kindLabelVehicle': { ru: 'ТРАНСПОРТ', en: 'VEHICLE' },
  'objects.kindPerson': { ru: 'ЛИЦА', en: 'PEOPLE' },
  'objects.kindSelectLabel': { ru: 'Тип объекта', en: 'Object type' },
  'objects.kindVehicle': { ru: 'ТРАНСПОРТ', en: 'VEHICLES' },
  'objects.linkedCaseButton': { ru: '[03] СВЯЗАННОЕ ДЕЛО', en: '[03] LINKED CASE' },
  'objects.localVideoFeedLabel': { ru: 'ЛОКАЛЬНАЯ ВИДЕОТРАНСЛЯЦИЯ', en: 'LOCAL VIDEO FEED' },
  'objects.noCameraLabel': { ru: 'НЕТ КАМЕРЫ', en: 'NO CAMERA' },
  'objects.noMatches': { ru: 'СОВПАДЕНИЙ НЕ ОБНАРУЖЕНО', en: 'NO MATCHES FOUND' },
  'objects.noObjectEyebrow': { ru: 'ОБЪЕКТ НЕ ВЫБРАН', en: 'NO OBJECT' },
  'objects.noObjectSelected': { ru: 'ОБЪЕКТ НЕ ВЫБРАН', en: 'NO OBJECT SELECTED' },
  'objects.openVideoButton': { ru: '[05] ОТКРЫТЬ ВИДЕО', en: '[05] OPEN VIDEO' },
  'objects.paginationLabel': { ru: 'Страницы реестра объектов', en: 'Object registry pages' },
  'objects.registryEyebrow': { ru: 'РЕЕСТР / {total}', en: 'REGISTRY / {total}' },
  'objects.registryTitle': { ru: 'ОБЪЕКТЫ', en: 'OBJECTS' },
  'objects.searchAriaLabel': { ru: 'Поиск объектов', en: 'Search objects' },
  'objects.searchPlaceholder': {
    ru: 'ID / ИМЯ / ПОЗЫВНОЙ / СЕКТОР',
    en: 'ID / NAME / CALLSIGN / SECTOR',
  },
  'objects.showOnMapButton': { ru: '[04] ПОКАЗАТЬ НА КАРТЕ', en: '[04] SHOW ON MAP' },
  'objects.signalLostLabel': { ru: 'ПОТЕРЯ СИГНАЛА', en: 'SIGNAL LOST' },
  'objects.signalThreatHeading': { ru: 'СИГНАЛ / УГРОЗА', en: 'SIGNAL / THREAT' },
  'objects.tabActivity': { ru: 'АКТИВНОСТЬ', en: 'ACTIVITY' },
  'objects.tabFiles': { ru: 'ФАЙЛЫ', en: 'FILES' },
  'objects.tabMap': { ru: 'КАРТА', en: 'MAP' },
  'objects.tabRelations': { ru: 'СВЯЗИ', en: 'RELATIONS' },
  'objects.tabSummary': { ru: 'СВОДКА', en: 'SUMMARY' },
  'objects.tabVideo': { ru: 'ВИДЕО', en: 'VIDEO' },

  // SearchScreen.tsx. `search.matchCount` (the plural id `t('search.matchCount', …)`
  // already reads) lives in `pluralMessages.ts`, not here.
  'search.ctrlKHint': {
    ru: 'CTRL+K — ОТКРЫТЬ ПОИСК ИЗ ЛЮБОГО РАЗДЕЛА',
    en: 'CTRL+K — OPEN SEARCH FROM ANYWHERE',
  },
  'search.enterQueryPrompt': { ru: 'ВВЕДИТЕ ЗАПРОС', en: 'ENTER A QUERY' },
  'search.exampleAlpha': { ru: 'АЛЬФА', en: 'ALPHA' },
  'search.exampleSignal': { ru: 'СИГНАЛ', en: 'SIGNAL' },
  'search.globalSearchAriaLabel': { ru: 'Глобальный поиск', en: 'Global search' },
  'search.headerLabel': { ru: 'ГЛОБАЛЬНЫЙ ИНДЕКС //', en: 'GLOBAL INDEX //' },
  'search.indexEyebrow': { ru: 'ЛОКАЛЬНЫЙ НАБОР ДАННЫХ', en: 'LOCAL DATASET' },
  'search.indexStatusLabel': { ru: 'ИНДЕКС: ГОТОВ', en: 'INDEX: READY' },
  'search.indexTitle': { ru: 'ИНДЕКС', en: 'INDEX' },
  'search.networkStatusLabel': { ru: 'СЕТЬ: НЕ ТРЕБУЕТСЯ', en: 'NETWORK: NOT REQUIRED' },
  'search.noMatchesFound': { ru: 'СОВПАДЕНИЙ НЕ НАЙДЕНО', en: 'NO MATCHES FOUND' },
  'search.paginationLabel': { ru: 'Страницы результатов поиска', en: 'Search result pages' },
  'search.quickSearchHeading': { ru: 'БЫСТРЫЙ ПОИСК', en: 'QUICK SEARCH' },
  'search.resultsEyebrow': {
    ru: 'ЕДИНЫЙ ПОИСК / ВСЕ СУЩНОСТИ',
    en: 'UNIFIED SEARCH / ALL ENTITIES',
  },
  'search.resultsTitle': { ru: 'РЕЗУЛЬТАТЫ', en: 'RESULTS' },
  'search.searchPlaceholder': {
    ru: 'ID, НАЗВАНИЕ, ПОЗЫВНОЙ, СЕКТОР, ТЕГ, ИСТОЧНИК...',
    en: 'ID, NAME, CALLSIGN, SECTOR, TAG, SOURCE...',
  },
  'search.storageStatusLabel': { ru: 'ХРАНИЛИЩЕ: ЛОКАЛЬНОЕ', en: 'STORAGE: LOCAL' },
  'search.tryLabel': { ru: 'Попробуйте:', en: 'Try:' },

  // ReportsScreen.tsx. The generated document body inside the preview panel
  // (the letterhead marker, section headings, the three paragraphs, the
  // classification and checksum footer) is the film's own report fiction, not
  // chrome, and is left out of this catalogue -- see the wave's report.
  'reports.archiveButton': { ru: '[A] АРХИВ', en: '[A] ARCHIVE' },
  'reports.exportPdfButton': { ru: '[D] ЭКСПОРТ PDF (СИМ)', en: '[D] EXPORT PDF SIM' },
  'reports.generateSummaryButton': { ru: '[N] СФОРМИРОВАТЬ СВОДКУ', en: '[N] GENERATE SUMMARY' },
  'reports.headerEyebrow': {
    ru: 'ОТЧЁТНОСТЬ / ЛОКАЛЬНЫЙ ГЕНЕРАТОР',
    en: 'REPORTING / LOCAL GENERATOR',
  },
  'reports.headerTitle': { ru: 'ОТЧЁТЫ И СВОДКИ', en: 'REPORTS AND SUMMARIES' },
  'reports.kindAll': { ru: 'ВСЕ', en: 'ALL' },
  'reports.kindAnalytics': { ru: 'АНАЛИТИКА', en: 'ANALYTICS' },
  'reports.kindCommunications': { ru: 'СВЯЗЬ', en: 'COMMUNICATIONS' },
  'reports.kindIncident': { ru: 'ИНЦИДЕНТ', en: 'INCIDENT' },
  'reports.kindObject': { ru: 'ОБЪЕКТ', en: 'OBJECT' },
  'reports.kindOperation': { ru: 'ОПЕРАЦИЯ', en: 'OPERATION' },
  'reports.kindSector': { ru: 'СЕКТОР', en: 'SECTOR' },
  'reports.kindSystem': { ru: 'СИСТЕМА', en: 'SYSTEM' },
  'reports.kindVideo': { ru: 'ВИДЕО', en: 'VIDEO' },
  'reports.kindsEyebrow': { ru: 'ИНДЕКС / ШАБЛОНЫ', en: 'INDEX / TEMPLATES' },
  'reports.kindsTitle': { ru: 'ТИПЫ ОТЧЁТОВ', en: 'REPORT TYPES' },
  'reports.noReportSelected': { ru: 'ОТЧЁТ НЕ ВЫБРАН', en: 'NO REPORT SELECTED' },
  'reports.noReportsOfKind': {
    ru: 'ОТЧЁТЫ ЭТОГО ТИПА ОТСУТСТВУЮТ',
    en: 'NO REPORTS OF THIS TYPE',
  },
  'reports.paginationLabel': { ru: 'Страницы реестра отчётов', en: 'Report registry pages' },
  'reports.previewTitle': { ru: 'ПРЕДПРОСМОТР ДОКУМЕНТА', en: 'DOCUMENT PREVIEW' },
  'reports.printSimButton': { ru: '[P] ПЕЧАТЬ (СИМ)', en: '[P] PRINT SIM' },
  'reports.registryEyebrow': {
    ru: {
      one: '{count} ЗАПИСЬ / ПРОВЕРЕНО',
      few: '{count} ЗАПИСИ / ПРОВЕРЕНО',
      many: '{count} ЗАПИСЕЙ / ПРОВЕРЕНО',
      other: '{count} ЗАПИСИ / ПРОВЕРЕНО',
    },
    en: { one: '{count} RECORD / VERIFIED', other: '{count} RECORDS / VERIFIED' },
  },
  'reports.registryTitle': { ru: 'РЕЕСТР ОТЧЁТОВ', en: 'REPORT REGISTRY' },
  'reports.signLocalButton': { ru: '[S] ПОДПИСАТЬ ЛОКАЛЬНО', en: '[S] SIGN LOCAL' },

  // CommunicationsScreen.tsx
  'comms.activeChannelTitle': { ru: 'АКТИВНЫЙ КАНАЛ', en: 'ACTIVE CHANNEL' },
  'comms.avgLatencyLabel': { ru: 'СР. ЗАДЕРЖКА', en: 'AVG LATENCY' },
  'comms.channelsCountLabel': { ru: 'КАНАЛЫ', en: 'CHANNELS' },
  'comms.channelsEyebrow': {
    ru: 'МАТРИЦА КАНАЛОВ / В РЕАЛЬНОМ ВРЕМЕНИ',
    en: 'CHANNEL MATRIX / LIVE',
  },
  'comms.channelsTitle': { ru: 'АКТИВНЫЕ КАНАЛЫ', en: 'ACTIVE CHANNELS' },
  'comms.headerEyebrow': { ru: 'СВЯЗЬ / ШИФРОВАНО / ЛОКАЛЬНО', en: 'COMMS / ENCRYPTED / LOCAL' },
  'comms.headerTitle': { ru: 'ЦЕНТР ЗАЩИЩЁННОЙ СВЯЗИ', en: 'SECURE COMMUNICATIONS CENTER' },
  'comms.inLabel': { ru: 'ВХОД', en: 'IN' },
  'comms.inboundTrafficLabel': { ru: 'Входящий трафик', en: 'Inbound traffic' },
  'comms.interceptsCountLabel': { ru: 'ПЕРЕХВАТЫ', en: 'INTERCEPTS' },
  'comms.liveAudioBufferLabel': {
    ru: 'ПРЯМОЙ ЭФИР / БУФЕР 00:00:18.420',
    en: 'LIVE AUDIO / BUFFER 00:00:18.420',
  },
  'comms.logEyebrow': { ru: 'ЖУРНАЛ СООБЩЕНИЙ / АУДИТ', en: 'MESSAGE LOG / AUDIT' },
  'comms.logTitle': { ru: 'ЖУРНАЛ СООБЩЕНИЙ', en: 'MESSAGE LOG' },
  'comms.markEventButton': { ru: '[M] ОТМЕТИТЬ СОБЫТИЕ', en: '[M] MARK EVENT' },
  'comms.muteButton': { ru: '[ЗАГЛУШИТЬ]', en: '[MUTE]' },
  'comms.mutedButton': { ru: '[ЗАГЛУШЕНО]', en: '[MUTED]' },
  'comms.noChannelAssigned': { ru: 'КАНАЛ НЕ НАЗНАЧЕН', en: 'NO CHANNEL ASSIGNED' },
  'comms.noChannelEyebrow': { ru: 'КАНАЛ НЕ ВЫБРАН', en: 'NO CHANNEL' },
  'comms.outLabel': { ru: 'ВЫХОД', en: 'OUT' },
  'comms.outboundTrafficLabel': { ru: 'Исходящий трафик', en: 'Outbound traffic' },
  'comms.sampleButton': { ru: '[{icon}] ОБРАЗЕЦ', en: '[{icon}] SAMPLE' },
  'comms.securedCountLabel': { ru: 'ЗАЩИЩЕНО', en: 'SECURED' },
  'comms.soloButton': { ru: '[СОЛО]', en: '[SOLO]' },
  'comms.trafficEyebrow': { ru: 'СЕТЬ / 60 МИН', en: 'NETWORK / 60 MIN' },
  'comms.trafficTitle': { ru: 'ТРАФИК / ЗАДЕРЖКА', en: 'TRAFFIC / LATENCY' },
  'comms.transcriptButton': { ru: '[T] ТРАНСКРИПТ', en: '[T] TRANSCRIPT' },
  'comms.transcriptEyebrow': { ru: 'ГОЛОС В ТЕКСТ / ЛОКАЛЬНО', en: 'VOICE TO TEXT / LOCAL' },
  // `RU` names the transcribed speech's own language, not the UI locale, and
  // stays fixed for the same reason a domain record does.
  'comms.transcriptFooterLabel': {
    ru: 'ЯЗЫК: RU / ДОСТОВЕРНОСТЬ 96.2% / ЛОКАЛЬНАЯ МОДЕЛЬ',
    en: 'LANG: RU / CONFIDENCE 96.2% / LOCAL MODEL',
  },
  'comms.transcriptTitle': { ru: 'ТРАНСКРИПТ', en: 'TRANSCRIPT' },

  // ArchiveScreen.tsx
  'archive.periodLabel': { ru: 'АРХИВНЫЙ ПЕРИОД', en: 'ARCHIVE PERIOD' },
  'archive.periodYear': { ru: 'ГОД', en: 'YEAR' },
} as const satisfies CatalogModule;
