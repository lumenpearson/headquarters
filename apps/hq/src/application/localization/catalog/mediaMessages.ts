import type { CatalogModule } from './catalogTypes';

/**
 * The live-camera and archive video screen, the local file registry, the
 * virtual explorer, and the file-backed surfaces around a single material --
 * the lifecycle panel, the player, the preview, the rendition menu and the
 * annotation panel.
 *
 * These files were written before this catalogue existed, the same debt
 * `recordMessages.ts` describes for the nine record screens: every heading,
 * button caption, status readout and `aria-label` was typed straight into the
 * JSX, in whichever language the author reached for first -- which is why the
 * strings below are a mix of already-Russian text moved here unchanged and
 * English literals that needed a Russian source written for the first time.
 *
 * ## The shared `media.*` vocabulary
 *
 * `VideoScreen.tsx` and `LocalMaterialPlayer.tsx` draw an identical
 * play/pause toggle, seek-by-seconds pair, mute toggle and fullscreen button;
 * `VideoScreen.tsx` and `FilesScreen.tsx` share one "add to case" caption and
 * one five-phase import-progress vocabulary
 * (`MaterialImportProgress['phase']`). Declared once under `media.*` rather
 * than once per screen, on the same reasoning `materialMessages.ts` gives its
 * own `field.*`/`unit.*` block: one word, one id, wherever it is read.
 *
 * ## Reused ids from other modules
 *
 * Where this module's screens needed a field, unit, status or file kind
 * `materialMessages.ts`, `recordMessages.ts` or `chromeMessages.ts` already
 * carry under an exact matching Russian source, the call site reads that id
 * rather than a duplicate declared here -- `field.size`, `field.source`,
 * `field.kindVideo`, `nav.map`, `registry.selectedFooter` among them. Two
 * new entries this module needed but that belong beside that existing
 * vocabulary -- `field.category` and `unit.s` -- were added to
 * `materialMessages.ts` instead of duplicated here.
 *
 * ## What stayed out of the catalogue
 *
 * A definition-list value or a badge that is simulated telemetry rather than
 * chrome -- `selected.resolution`, `AES-256`, `4.2 TB`, `228.4 V`, the fixed
 * `07:42:15` clock reading -- is left exactly as the screen already renders
 * it, the same "world content" exemption `recordMessages.ts` documents for
 * `CasesScreen.tsx`'s storage tree. So is the three-letter file-kind glyph a
 * table row or a thumbnail derives from the English kind id itself
 * (`file.kind.slice(0, 3).toUpperCase()`) -- a mechanical short code, not a
 * word an operator reads as prose, unlike the full kind word this module does
 * carry a translated table for.
 */
export const mediaMessages = {
  // Shared across VideoScreen.tsx, LocalMaterialPlayer.tsx and
  // FilesScreen.tsx -- see the module docstring's "shared vocabulary" note.
  'media.addToCaseButton': { ru: '[+] ДОБАВИТЬ В ДЕЛО', en: '[+] ADD TO CASE' },
  'media.archiveLabel': { ru: 'АРХИВ', en: 'ARCHIVE' },
  'media.audioButton': { ru: '[M] ЗВУК', en: '[M] AUDIO' },
  'media.fullscreenButton': { ru: '[F] ПОЛНЫЙ ЭКРАН', en: '[F] FULL' },
  'media.importPhase.completed': { ru: 'ЗАВЕРШЕНО', en: 'COMPLETED' },
  'media.importPhase.hashing': { ru: 'ХЕШИРОВАНИЕ', en: 'HASHING' },
  'media.importPhase.starting': { ru: 'НАЧАЛО', en: 'STARTING' },
  'media.importPhase.uploading': { ru: 'ЗАГРУЗКА', en: 'UPLOADING' },
  'media.importPhase.verifying': { ru: 'ПРОВЕРКА', en: 'VERIFYING' },
  'media.liveLabel': { ru: 'ЭФИР', en: 'LIVE' },
  'media.mutedButton': { ru: '[M] ЗАГЛУШЕНО', en: '[M] MUTED' },
  'media.pauseButton': { ru: '[Ⅱ] ПАУЗА', en: '[Ⅱ] PAUSE' },
  'media.pauseLabel': { ru: 'ПАУЗА', en: 'PAUSE' },
  'media.playButton': { ru: '[▶] ВОСПРОИЗВЕСТИ', en: '[▶] PLAY' },
  'media.playLabel': { ru: 'ВОСПРОИЗВЕДЕНИЕ', en: 'PLAY' },
  'media.playbackRateLabel': { ru: 'Скорость воспроизведения', en: 'Playback rate' },
  'media.seekBackward': { ru: '[◀] -{seconds}СЕК', en: '[◀] -{seconds}S' },
  'media.seekForward': { ru: '[▶] +{seconds}СЕК', en: '[▶] +{seconds}S' },

  // VideoScreen.tsx
  'video.activeChannelEyebrow': { ru: 'КАМЕРА / ТЕЛЕМЕТРИЯ', en: 'CAMERA / TELEMETRY' },
  'video.activeChannelTitle': { ru: 'АКТИВНЫЙ КАНАЛ', en: 'ACTIVE CHANNEL' },
  'video.backup': { ru: 'РЕЗЕРВ', en: 'BACKUP' },
  'video.cameraFilterSelectLabel': { ru: 'Фильтр камер', en: 'Camera filter' },
  'video.cameraGridEyebrow': {
    ru: 'ПРОСМОТР {page}/{total} / {count} КАНАЛОВ',
    en: 'VIEW {page}/{total} / {count} CHANNELS',
  },
  'video.cameraGridTitle': { ru: 'СЕТКА КАМЕР', en: 'CAMERA GRID' },
  'video.cameraImageAlt': { ru: 'Камера {id}: {location}', en: 'Camera {id}: {location}' },
  'video.cameraPaginationLabel': { ru: 'Страницы реестра камер', en: 'Camera registry pages' },
  'video.cameraSortSelectLabel': { ru: 'Сортировка камер', en: 'Camera sort' },
  'video.catalogOffline': {
    ru: 'ЛОКАЛЬНЫЙ КАТАЛОГ МАТЕРИАЛОВ НЕДОСТУПЕН',
    en: 'LOCAL MATERIAL CATALOG OFFLINE',
  },
  'video.demoSourceLabel': { ru: '[DEMO] ПЕТЛЯ НАБЛЮДЕНИЯ', en: '[DEMO] SURVEILLANCE LOOP' },
  'video.dtActive': { ru: 'АКТИВНЫЕ', en: 'ACTIVE' },
  'video.dtActiveChannels': { ru: 'АКТИВНЫЕ КАНАЛЫ', en: 'ACTIVE CHANNELS' },
  'video.dtDemo': { ru: 'ДЕМО', en: 'DEMO' },
  'video.dtFree': { ru: 'СВОБОДНЫЕ', en: 'FREE' },
  'video.dtIntegrity': { ru: 'ЦЕЛОСТНОСТЬ', en: 'INTEGRITY' },
  'video.dtLocation': { ru: 'ЛОКАЦИЯ', en: 'LOCATION' },
  'video.dtLost': { ru: 'ПОТЕРЯНО', en: 'LOST' },
  'video.dtMatch': { ru: 'СОВПАДЕНИЯ', en: 'MATCH' },
  'video.dtMaterial': { ru: 'МАТЕРИАЛ', en: 'MATERIAL' },
  'video.dtRecording': { ru: 'ЗАПИСЬ', en: 'RECORDING' },
  'video.dtRtspOptIn': { ru: 'RTSP ПО ЗАПРОСУ', en: 'RTSP OPT-IN' },
  'video.dtThreats': { ru: 'УГРОЗЫ', en: 'THREATS' },
  'video.dtTransport': { ru: 'ТРАНСПОРТ', en: 'TRANSPORT' },
  'video.dtUptime': { ru: 'ВРЕМЯ РАБОТЫ', en: 'UPTIME' },
  'video.dtVpnTunnels': { ru: 'VPN-ТУННЕЛИ', en: 'VPN TUNNELS' },
  'video.dtWebcam': { ru: 'ВЕБКАМЕРА', en: 'WEBCAM' },
  'video.eventLogEyebrow': { ru: 'ПОСЛЕДНИЕ / 05', en: 'LATEST / 05' },
  'video.eventLogTitle': { ru: 'ЖУРНАЛ СОБЫТИЙ', en: 'EVENT LOG' },
  'video.eyebrow': { ru: 'ВИДЕО / ЛОКАЛЬНАЯ МЕДИАМАТРИЦА', en: 'VIDEO / LOCAL MEDIA MATRIX' },
  'video.faceLabel': { ru: '[ЛИЦО {index}]', en: '[FACE {index}]' },
  'video.fallbackSuffix': { ru: ' / РЕЗЕРВ', en: ' / FALLBACK' },
  'video.fileSourceLabel': { ru: '[ФАЙЛ] {name}', en: '[FILE] {name}' },
  'video.filterAlert': { ru: 'ТОЛЬКО ALERT', en: 'ALERT ONLY' },
  'video.filterAll': { ru: 'ВСЕ КАНАЛЫ', en: 'ALL CHANNELS' },
  'video.filterOnline': { ru: 'ТОЛЬКО ACTIVE', en: 'ACTIVE ONLY' },
  'video.focusInButton': { ru: '[+] ФОКУС', en: '[+] FOCUS' },
  'video.focusOutButton': { ru: '[-] ФОКУС', en: '[-] FOCUS' },
  'video.gaugeExcellent': { ru: 'ОТЛИЧНЫЙ', en: 'EXCELLENT' },
  'video.goLiveButton': { ru: '[●] ЭФИР', en: '[●] LIVE' },
  'video.headingArchive': { ru: 'ВИДЕОАРХИВ', en: 'VIDEO ARCHIVE' },
  'video.headingCameras': { ru: 'ЦЕНТР КАМЕР / VIDEO WALL', en: 'CAMERA CENTER / VIDEO WALL' },
  'video.headingLive': { ru: 'ВИДЕО / ПРЯМОЙ ЭФИР', en: 'VIDEO / LIVE FEED' },
  'video.hiddenFeedsNote': {
    ru: 'СКРЫТЫЕ ПОТОКИ: СТАТИЧНЫЕ МИНИАТЮРЫ / ЦЕЛЬ ДЕКОДИРОВАНИЯ:',
    en: 'HIDDEN FEEDS: STATIC THUMBNAILS / DECODE TARGET:',
  },
  'video.incoming': { ru: 'ВХОДЯЩИЙ', en: 'INCOMING' },
  'video.incomingTrafficLabel': { ru: 'Входящий трафик', en: 'Incoming traffic' },
  'video.interceptEyebrow': { ru: 'АУДИО / ПЕРЕХВАТ', en: 'AUDIO / INTERCEPT' },
  'video.interceptTitle': { ru: 'ПЕРЕХВАТ СВЯЗИ', en: 'COMMS INTERCEPT' },
  'video.irisCloseButton': { ru: '[-] ДИАФРАГМА', en: '[-] IRIS' },
  'video.irisOpenButton': { ru: '[+] ДИАФРАГМА', en: '[+] IRIS' },
  'video.lastLabel': { ru: 'ПОСЛЕДНИЙ', en: 'LAST' },
  'video.liveChannelEyebrow': { ru: 'ЖИВОЙ КАНАЛ', en: 'LIVE CHANNEL' },
  'video.loadingLocalMaterial': {
    ru: 'ЗАГРУЗКА ЛОКАЛЬНОГО МАТЕРИАЛА…',
    en: 'LOADING LOCAL MATERIAL…',
  },
  'video.localDeviceLive': { ru: 'ЛОКАЛЬНОЕ УСТРОЙСТВО / ЭФИР', en: 'LOCAL DEVICE / LIVE' },
  'video.localMaterialStreamUnavailable': {
    ru: 'ЛОКАЛЬНЫЙ ПОТОК МАТЕРИАЛА НЕДОСТУПЕН',
    en: 'LOCAL MATERIAL STREAM UNAVAILABLE',
  },
  'video.materialNotAvailable': {
    ru: 'МАТЕРИАЛ ОТСУТСТВУЕТ В ЛОКАЛЬНОЙ КОПИИ',
    en: 'MATERIAL NOT AVAILABLE IN LOCAL MIRROR',
  },
  'video.materialReady': { ru: 'МАТЕРИАЛ ГОТОВ', en: 'MATERIAL READY' },
  'video.miniMapEyebrow': { ru: 'ГЕО / КАМЕРА', en: 'GEO / CAMERA' },
  'video.miniMapTitle': { ru: 'СПУТНИКОВАЯ КАРТА', en: 'SATELLITE MAP' },
  'video.missingSourceLabel': { ru: '[ОТСУТСТВУЕТ] {id}', en: '[MISSING] {id}' },
  'video.navArchive': { ru: '[A] АРХИВ', en: '[A] ARCHIVE' },
  'video.navCameras': { ru: '[C] КАМЕРЫ', en: '[C] CAMERAS' },
  'video.navLive': { ru: '[L] ЭФИР', en: '[L] LIVE' },
  'video.networkEyebrow': { ru: 'СОСТОЯНИЕ КАНАЛА', en: 'CHANNEL HEALTH' },
  'video.networkTitle': { ru: 'СЕТЬ / ПИТАНИЕ', en: 'NETWORK / POWER' },
  'video.nextFrameButton': { ru: '[▶|] КАДР', en: '[▶|] FRAME' },
  'video.openStreamTitle': { ru: '{location} / открыть поток', en: '{location} / open stream' },
  'video.operatorSystem': { ru: 'СИСТЕМА', en: 'SYSTEM' },
  'video.outgoing': { ru: 'ИСХОДЯЩИЙ', en: 'OUTGOING' },
  'video.outgoingTrafficLabel': { ru: 'Исходящий трафик', en: 'Outgoing traffic' },
  'video.overlayAngle': { ru: 'УГОЛ {value}°', en: 'ANGLE {value}°' },
  'video.overlayCamera': { ru: 'КАМЕРА {id}', en: 'CAMERA {id}' },
  'video.overlayLocation': { ru: 'ЛОКАЦИЯ {sector}', en: 'LOCATION {sector}' },
  'video.overlayZoom': { ru: 'ЗУМ {value}×', en: 'ZOOM {value}×' },
  'video.pipButton': { ru: '[P] КАРТИНКА В КАРТИНКЕ', en: '[P] PIP' },
  'video.power': { ru: 'ПИТАНИЕ', en: 'POWER' },
  'video.presetButton': { ru: 'ПРЕСЕТ {n}', en: 'PRESET {n}' },
  'video.prevFrameButton': { ru: '[|◀] КАДР', en: '[|◀] FRAME' },
  'video.ptzAvailable': { ru: 'ДОСТУПНО', en: 'AVAILABLE' },
  'video.ptzControlEyebrow': { ru: 'ВИРТУАЛЬНЫЙ КРОП / ЛОКАЛЬНО', en: 'VIRTUAL CROP / LOCAL' },
  'video.ptzControlTitle': { ru: 'УПРАВЛЕНИЕ PTZ', en: 'PTZ CONTROL' },
  'video.ptzFixed': { ru: 'ФИКСИРОВАНО', en: 'FIXED' },
  'video.ptzFooter': {
    ru: 'ПАН {pan} / НАКЛОН {tilt} / ЗУМ {zoom}×',
    en: 'PAN {pan} / TILT {tilt} / ZOOM {zoom}×',
  },
  'video.ptzSpeedLabel': { ru: 'СКОРОСТЬ PTZ', en: 'PTZ SPEED' },
  'video.rangeStreamReady': { ru: 'RANGE-ПОТОК ГОТОВ', en: 'RANGE STREAM READY' },
  'video.recognitionEyebrow': { ru: 'ЛОКАЛЬНЫЙ AI / СИНТЕТИКА', en: 'LOCAL AI / SYNTHETIC' },
  'video.recognitionPeople': { ru: 'ЛЮДИ', en: 'PEOPLE' },
  'video.recognitionPlates': { ru: 'НОМЕРА', en: 'PLATES' },
  'video.recognitionTitle': { ru: 'РАСПОЗНАВАНИЕ', en: 'RECOGNITION' },
  'video.recognitionVehicles': { ru: 'ТРАНСПОРТ', en: 'VEHICLES' },
  'video.registryFilterAlert': { ru: 'ТРЕВОГА', en: 'ALERT' },
  'video.registryFilterAll': { ru: 'ВСЕ', en: 'ALL' },
  'video.registryFilterOnline': { ru: 'АКТИВНЫЕ', en: 'ONLINE' },
  'video.registryQueryLabel': { ru: '[ ЗАПРОС РЕЕСТРА ]', en: '[ REGISTRY QUERY ]' },
  'video.registrySummaryLabel': { ru: 'Сводка реестра камер', en: 'Camera registry summary' },
  'video.retryStreamButton': { ru: '[R] ПОВТОРИТЬ ПОТОК', en: '[R] RETRY STREAM' },
  'video.sampleButton': { ru: '[{icon}] ПРОСЛУШАТЬ', en: '[{icon}] SAMPLE' },
  'video.scrubberLabel': { ru: 'Позиция видеопотока', en: 'Video stream position' },
  'video.securityEyebrow': { ru: 'БЕЗОПАСНОСТЬ', en: 'SECURITY' },
  'video.securityTitle': { ru: 'ЗАЩИЩЁННАЯ СЕТЬ', en: 'SECURED NETWORK' },
  'video.snapButton': { ru: '[S] СНИМОК', en: '[S] SNAP' },
  'video.sortId': { ru: 'ИДЕНТИФИКАТОР', en: 'IDENTIFIER' },
  'video.sortRegistryOrder': { ru: 'ПОРЯДОК РЕЕСТРА', en: 'REGISTRY ORDER' },
  'video.sourceLabelDemoLoop': { ru: '↻ ДЕМО-ПЕТЛЯ', en: '↻ DEMO LOOP' },
  'video.sourceLabelLocalMaterial': { ru: '▶ ЛОКАЛЬНЫЙ МАТЕРИАЛ', en: '▶ LOCAL MATERIAL' },
  'video.sourceLabelOptionalLive': { ru: '● ОПЦИОНАЛЬНЫЙ ЭФИР', en: '● OPTIONAL LIVE' },
  'video.sourceLabelWebcam': { ru: '● ЛОКАЛЬНАЯ ВЕБКАМЕРА', en: '● LOCAL WEBCAM' },
  'video.sourceSelectLabel': { ru: 'Источник выбранного канала', en: 'Selected channel source' },
  'video.stabilizationActive': { ru: 'СТАБИЛИЗАЦИЯ АКТИВНА', en: 'STABILIZATION ACTIVE' },
  'video.stopButton': { ru: '[■] СТОП', en: '[■] STOP' },
  'video.storageEyebrow': { ru: 'МАТРИЦА ЗАПИСИ', en: 'RECORDING MATRIX' },
  'video.storageTitle': { ru: 'ХРАНИЛИЩЕ / КАНАЛЫ', en: 'STORAGE / CHANNELS' },
  'video.streamAriaLabel': { ru: 'Видеопоток {id}', en: 'Video stream {id}' },
  'video.switchingToBackup': {
    ru: 'ПЕРЕКЛЮЧЕНИЕ НА РЕЗЕРВНЫЙ КАНАЛ',
    en: 'SWITCHING TO BACKUP CHANNEL',
  },
  'video.syncActive': { ru: 'АКТИВНА', en: 'ACTIVE' },
  'video.syncConnecting': { ru: 'ПОДКЛЮЧЕНИЕ', en: 'CONNECTING' },
  'video.syncLocalOnly': { ru: 'ТОЛЬКО ЛОКАЛЬНО', en: 'LOCAL ONLY' },
  'video.syncLocalSource': { ru: 'ЛОКАЛЬНЫЙ ИСТОЧНИК', en: 'LOCAL SOURCE' },
  'video.syncSourceMismatch': { ru: 'НЕСОВПАДЕНИЕ ИСТОЧНИКА', en: 'SOURCE MISMATCH' },
  'video.syncStatusLine': { ru: '[⇄] СИНХРО / {status}', en: '[⇄] SYNC / {status}' },
  'video.thumbDemo': { ru: '↻ ДЕМО', en: '↻ DEMO' },
  'video.thumbFile': { ru: '▶ ФАЙЛ', en: '▶ FILE' },
  'video.thumbLive': { ru: '● ЭФИР', en: '● LIVE' },
  'video.thumbNoSignal': { ru: 'НЕТ СИГНАЛА', en: 'NO SIGNAL' },
  'video.threatsNone': { ru: 'НЕ ОБНАРУЖЕНЫ', en: 'NOT DETECTED' },
  'video.transcriptButton': { ru: '[T] ТРАНСКРИПТ', en: '[T] TRANSCRIPT' },
  'video.trackingLabel': { ru: 'ОТСЛЕЖИВАНИЕ', en: 'TRACKING' },
  'video.transportEyebrow': { ru: 'ХРОНОЛОГИЯ / ТРАНСПОРТ', en: 'TIMELINE / TRANSPORT' },
  'video.transportTitle': { ru: 'УПРАВЛЕНИЕ ПОТОКОМ', en: 'STREAM CONTROL' },
  'video.volumeLabel': { ru: 'Громкость', en: 'Volume' },
  'video.webcamApiUnavailable': { ru: 'API КАМЕРЫ НЕДОСТУПНО', en: 'CAMERA API UNAVAILABLE' },
  'video.webcamDenied': { ru: 'ДОСТУП К КАМЕРЕ ОТКЛОНЁН', en: 'CAMERA ACCESS DENIED' },
  'video.webcamEnded': { ru: 'ПОТОК КАМЕРЫ ЗАВЕРШЁН', en: 'CAMERA STREAM ENDED' },
  'video.webcamRequestButton': { ru: '[W] ЗАПРОС', en: '[W] REQUEST' },
  'video.webcamStartButton': { ru: '[W] ВЕБКАМЕРА', en: '[W] WEBCAM' },
  'video.webcamStopButton': { ru: '[W] ОСТАНОВИТЬ', en: '[W] STOP CAM' },
  'video.zoomInButton': { ru: '[+] ЗУМ', en: '[+] ZOOM' },
  'video.zoomOutButton': { ru: '[-] ЗУМ', en: '[-] ZOOM' },

  // FilesScreen.tsx
  'files.allMaterials': { ru: 'ВСЕ МАТЕРИАЛЫ', en: 'ALL MATERIALS' },
  'files.archiveHeading': { ru: 'АРХИВНЫЕ МАТЕРИАЛЫ', en: 'ARCHIVE MATERIALS' },
  'files.archiveIndexTitle': { ru: 'АРХИВНЫЙ ИНДЕКС', en: 'ARCHIVE INDEX' },
  'files.bridgeErrorPrefix': { ru: 'МОСТ: {message}', en: 'BRIDGE: {message}' },
  'files.bridgeUnknownError': {
    ru: 'НЕИЗВЕСТНАЯ ОШИБКА ЛОКАЛЬНОГО ИМПОРТА',
    en: 'UNKNOWN LOCAL IMPORT ERROR',
  },
  'files.cancelImportButton': { ru: '[ESC] ОТМЕНИТЬ ИМПОРТ', en: '[ESC] CANCEL IMPORT' },
  'files.categoriesEyebrow': { ru: 'ФИЛЬТР / ИНДЕКС', en: 'FILTER / INDEX' },
  'files.categoriesTitle': { ru: 'КАТЕГОРИИ', en: 'CATEGORIES' },
  'files.closeButton': { ru: 'ЗАКРЫТЬ', en: 'CLOSE' },
  'files.closePreviewButton': { ru: '[X] ЗАКРЫТЬ', en: '[X] CLOSE' },
  'files.colAccess': { ru: 'ДОСТУП', en: 'ACCESS' },
  'files.colIdName': { ru: 'ID / НАЗВАНИЕ', en: 'ID / NAME' },
  'files.controlPlaneEyebrow': {
    ru: 'CONTROL PLANE ПОВЕРХ GRPC-WEB',
    en: 'CONTROL PLANE OVER GRPC-WEB',
  },
  'files.downloadSimButton': { ru: '[D] СИМУЛЯЦИЯ ЗАГРУЗКИ', en: '[D] DOWNLOAD SIM' },
  'files.filesHeading': { ru: 'ФАЙЛЫ И МАТЕРИАЛЫ', en: 'FILES AND MATERIALS' },
  'files.fileViewerButton': { ru: '[ENTER] ПРОСМОТР ФАЙЛА', en: '[ENTER] FILE VIEWER' },
  'files.groupImportDescription': {
    ru: 'Материалы уходят в библиотеку группы: control plane резервирует части, браузер пишет их прямо в объектное хранилище по подписанным адресам.',
    en: 'Materials go to the group library: the control plane reserves parts, and the browser writes them directly to object storage at signed addresses.',
  },
  'files.groupImportTitle': { ru: 'ИМПОРТ МАТЕРИАЛОВ В ГРУППУ', en: 'IMPORT MATERIALS TO GROUP' },
  'files.groupTrashHeader': {
    ru: {
      one: 'КОРЗИНА ГРУППЫ / {count} ЗАПИСЬ',
      few: 'КОРЗИНА ГРУППЫ / {count} ЗАПИСИ',
      many: 'КОРЗИНА ГРУППЫ / {count} ЗАПИСЕЙ',
      other: 'КОРЗИНА ГРУППЫ / {count} ЗАПИСИ',
    },
    en: { one: 'GROUP TRASH / {count} RECORD', other: 'GROUP TRASH / {count} RECORDS' },
  },
  'files.historicalMaterialsEyebrow': {
    ru: 'ИСТОРИЧЕСКИЕ МАТЕРИАЛЫ / ТОЛЬКО ЧТЕНИЕ',
    en: 'HISTORICAL MATERIALS / READ ONLY',
  },
  'files.importCancelled': {
    ru: 'ИМПОРТ ОТМЕНЁН ОПЕРАТОРОМ',
    en: 'IMPORT CANCELLED BY OPERATOR',
  },
  'files.importCategoryFieldLabel': { ru: 'КАТЕГОРИЯ ИМПОРТА', en: 'IMPORT CATEGORY' },
  'files.importCategorySelectLabel': {
    ru: 'Категория импортируемых материалов',
    en: 'Category of materials being imported',
  },
  'files.importedMessage': {
    ru: 'ЗАГРУЖЕНО: {count} / {origin}',
    en: 'UPLOADED: {count} / {origin}',
  },
  'files.integrityOk': { ru: 'НОРМА', en: 'OK' },
  'files.kindData': { ru: 'ДАННЫЕ', en: 'DATA' },
  'files.libraryEventsLabel': {
    ru: 'СОБЫТИЯ БИБЛИОТЕКИ: {count} / ПОСЛЕДНЕЕ {kind}',
    en: 'LIBRARY EVENTS: {count} / LATEST {kind}',
  },
  'files.libraryHeader': {
    ru: {
      one: '{origin} / {count} ЗАПИСЬ',
      few: '{origin} / {count} ЗАПИСИ',
      many: '{origin} / {count} ЗАПИСЕЙ',
      other: '{origin} / {count} ЗАПИСИ',
    },
    en: { one: '{origin} / {count} RECORD', other: '{origin} / {count} RECORDS' },
  },
  'files.localEvidenceStoreEyebrow': {
    ru: 'ЛОКАЛЬНОЕ ХРАНИЛИЩЕ ДОКАЗАТЕЛЬСТВ / ТОЛЬКО ЧТЕНИЕ',
    en: 'LOCAL EVIDENCE STORE / READ ONLY',
  },
  'files.localImportDescription': {
    ru: 'Материалы пишутся только в локальный mirror. Группа не подключена либо этот control plane не объявляет коллаборатор materials.',
    en: 'Materials are written only to the local mirror. Either no group is connected, or this control plane declares no materials collaborator.',
  },
  'files.localImportTitle': { ru: 'ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ', en: 'LOCAL MATERIAL IMPORT' },
  'files.localVerifiedPrefix': { ru: 'ЛОКАЛЬНО / ПРОВЕРЕНО /', en: 'LOCAL / VERIFIED /' },
  'files.loopbackEyebrow': { ru: 'LOOPBACK ПОВЕРХ GRPC-WEB', en: 'LOOPBACK OVER GRPC-WEB' },
  'files.gridViewButton': { ru: '[G] СЕТКА', en: '[G] GRID' },
  'files.listViewButton': { ru: '[L] СПИСОК', en: '[L] LIST' },
  'files.nextPageButton': { ru: 'СЛЕДУЮЩАЯ СТРАНИЦА', en: 'NEXT PAGE' },
  'files.noArchiveMaterials': { ru: 'АРХИВНЫЕ МАТЕРИАЛЫ ОТСУТСТВУЮТ', en: 'NO ARCHIVE MATERIALS' },
  'files.noImportedMaterials': {
    ru: 'ИМПОРТИРОВАННЫЕ МАТЕРИАЛЫ ОТСУТСТВУЮТ',
    en: 'NO IMPORTED MATERIALS',
  },
  'files.noMaterialSelected': { ru: 'МАТЕРИАЛ НЕ ВЫБРАН', en: 'NO MATERIAL SELECTED' },
  'files.paginationLabel': { ru: 'Страницы реестра файлов', en: 'File registry pages' },
  'files.previewTitle': { ru: 'ПРЕДПРОСМОТР', en: 'PREVIEW' },
  'files.printSimButton': { ru: '[P] СИМУЛЯЦИЯ ПЕЧАТИ', en: '[P] PRINT SIM' },
  'files.purgeButton': { ru: '[P] УДАЛИТЬ НАВСЕГДА', en: '[P] PERMANENTLY DELETE' },
  'files.purgeConfirmDescription': {
    ru: 'Объект будет удалён из хранилища группы без возможности восстановления.',
    en: 'The object will be deleted from the group storage beyond recovery.',
  },
  'files.purgeConfirmTitle': {
    ru: 'УДАЛИТЬ МАТЕРИАЛ НАВСЕГДА?',
    en: 'PERMANENTLY DELETE MATERIAL?',
  },
  'files.purgedMessage': { ru: 'УДАЛЕНО НАВСЕГДА: {name}', en: 'PERMANENTLY DELETED: {name}' },
  'files.readingMirror': { ru: 'ЧТЕНИЕ ЛОКАЛЬНОГО MIRROR…', en: 'READING LOCAL MIRROR…' },
  'files.readyToImport': {
    ru: 'ГОТОВО / ВЫБЕРИТЕ ФАЙЛЫ ДЛЯ НАЧАЛА ОГРАНИЧЕННОЙ БИНАРНОЙ ПЕРЕДАЧИ',
    en: 'READY / SELECT FILES TO START A BOUNDED BINARY TRANSFER',
  },
  'files.recentTabLabel': { ru: 'НЕДАВНИЕ', en: 'RECENT' },
  'files.registryEyebrow': {
    ru: {
      one: '{count} ЗАПИСЬ / ЛОКАЛЬНО',
      few: '{count} ЗАПИСИ / ЛОКАЛЬНО',
      many: '{count} ЗАПИСЕЙ / ЛОКАЛЬНО',
      other: '{count} ЗАПИСИ / ЛОКАЛЬНО',
    },
    en: { one: '{count} RECORD / LOCAL', other: '{count} RECORDS / LOCAL' },
  },
  'files.registryTitle': { ru: 'РЕЕСТР ФАЙЛОВ', en: 'FILE REGISTRY' },
  'files.restoreButton': { ru: '[R] ВОССТАНОВИТЬ', en: '[R] RESTORE' },
  'files.restoredMessage': { ru: 'ВОССТАНОВЛЕНО: {name}', en: 'RESTORED: {name}' },
  'files.searchAriaLabel': { ru: 'Поиск материалов', en: 'Search materials' },
  'files.searchPlaceholder': {
    ru: 'ПОИСК ПО ID / ТЕГАМ / ИСТОЧНИКУ',
    en: 'SEARCH BY ID / TAGS / SOURCE',
  },
  'files.selectFilesAriaLabel': {
    ru: 'Выбрать материалы для локального импорта',
    en: 'Select materials for local import',
  },
  'files.selectFilesFieldLabel': {
    ru: 'ВЫБРАТЬ ФАЙЛЫ / ВИДЕО / ФОТО / ДОКУМЕНТЫ',
    en: 'SELECT FILES / VIDEO / PHOTO / DOCUMENTS',
  },
  'files.sortDate': { ru: 'ДАТА', en: 'DATE' },
  'files.sortSelectLabel': { ru: 'Сортировка материалов', en: 'Materials sort' },
  'files.summaryFiles': { ru: 'ФАЙЛЫ', en: 'FILES' },
  'files.summaryStorage': { ru: 'ХРАНИЛИЩЕ', en: 'STORAGE' },
  'files.trashEmpty': { ru: 'КОРЗИНА ПУСТА', en: 'TRASH IS EMPTY' },
  'files.trashTabLabel': { ru: 'КОРЗИНА', en: 'TRASH' },

  // VirtualExplorer.tsx
  'explorer.bridgeStatus.connecting': { ru: 'ПОДКЛЮЧЕНИЕ', en: 'CONNECTING' },
  'explorer.bridgeStatus.incompatible': { ru: 'НЕСОВМЕСТИМО', en: 'INCOMPATIBLE' },
  'explorer.emptyFolderHint': {
    ru: 'Подключите источник или вернитесь в корень.',
    en: 'Connect a source or go back to the root.',
  },
  'explorer.emptyFolderTitle': { ru: 'ПАПКА ПУСТА', en: 'FOLDER IS EMPTY' },
  'explorer.emulatedSourceLabel': { ru: 'ЭМУЛИРОВАННЫЙ', en: 'EMULATED' },
  'explorer.fieldModified': { ru: 'ИЗМЕНЁН', en: 'MODIFIED' },
  'explorer.fieldName': { ru: 'ИМЯ', en: 'NAME' },
  'explorer.fieldPath': { ru: 'ПУТЬ', en: 'PATH' },
  'explorer.fileBridgeLabel': { ru: 'МОСТ ФАЙЛОВ', en: 'FILE BRIDGE' },
  'explorer.filterAll': { ru: 'ВСЕ ТИПЫ', en: 'ALL TYPES' },
  'explorer.filterDocuments': { ru: 'ДОКУМЕНТЫ', en: 'DOCUMENTS' },
  'explorer.filterImages': { ru: 'ИЗОБРАЖЕНИЯ', en: 'IMAGES' },
  'explorer.filterSelectLabel': { ru: 'Фильтр материалов', en: 'Materials filter' },
  'explorer.lastEventHeading': { ru: 'ПОСЛЕДНЕЕ СОБЫТИЕ', en: 'LAST EVENT' },
  'explorer.mountButton': { ru: '[+] ПОДКЛЮЧИТЬ ПАПКУ', en: '[+] MOUNT DIR' },
  'explorer.nodeCount': {
    ru: {
      one: '{count} ОБЪЕКТ',
      few: '{count} ОБЪЕКТА',
      many: '{count} ОБЪЕКТОВ',
      other: '{count} ОБЪЕКТА',
    },
    en: { one: '{count} OBJECT', other: '{count} OBJECTS' },
  },
  'explorer.noEvents': { ru: 'НЕТ СОБЫТИЙ', en: 'NO EVENTS' },
  'explorer.openInWorkspaceButton': { ru: 'ОТКРЫТЬ В РАБОЧЕЙ ОБЛАСТИ', en: 'OPEN IN WORKSPACE' },
  'explorer.quickAccessConnectedMaterials': {
    ru: 'ПОДКЛЮЧЕННЫЕ МАТЕРИАЛЫ',
    en: 'CONNECTED MATERIALS',
  },
  'explorer.quickAccessHeading': { ru: 'БЫСТРЫЙ ДОСТУП', en: 'QUICK ACCESS' },
  'explorer.quickAccessMaps': { ru: 'КАРТЫ', en: 'MAPS' },
  'explorer.quickAccessMedia': { ru: 'МЕДИА', en: 'MEDIA' },
  'explorer.scanningSources': { ru: 'СКАНИРОВАНИЕ ИСТОЧНИКОВ…', en: 'SCANNING SOURCES…' },
  'explorer.searchLabel': { ru: 'Поиск в материалах', en: 'Search in materials' },
  'explorer.selectMaterialPrompt': { ru: 'ВЫБЕРИТЕ МАТЕРИАЛ', en: 'SELECT A MATERIAL' },
  'explorer.sendToScreenButton': { ru: '> ЭКРАН', en: '> SCREEN' },
  'explorer.sourceStatus.empty': { ru: 'ПУСТО', en: 'EMPTY' },
  'explorer.sourceStatus.permissionRequired': {
    ru: 'ТРЕБУЕТСЯ ДОСТУП',
    en: 'PERMISSION REQUIRED',
  },
  'explorer.sourcesHeading': { ru: 'ИСТОЧНИКИ', en: 'SOURCES' },
  'explorer.status.offline': { ru: 'НЕ В СЕТИ', en: 'OFFLINE' },
  'explorer.status.online': { ru: 'В СЕТИ', en: 'ONLINE' },
  'explorer.targetScreenLabel': { ru: 'Целевой экран', en: 'Target screen' },

  // MaterialLifecyclePanel.tsx
  'materialLifecycle.categorySelectLabel': { ru: 'Категория материала', en: 'Material category' },
  'materialLifecycle.errorPrefix': { ru: 'ОШИБКА: {message}', en: 'ERROR: {message}' },
  'materialLifecycle.header': {
    ru: 'УПРАВЛЕНИЕ МАТЕРИАЛОМ / {id}',
    en: 'MATERIAL MANAGEMENT / {id}',
  },
  'materialLifecycle.metadataUpdated': { ru: 'МЕТАДАННЫЕ ОБНОВЛЕНЫ', en: 'METADATA UPDATED' },
  'materialLifecycle.nameInputLabel': { ru: 'Название материала', en: 'Material name' },
  'materialLifecycle.newVersionFieldLabel': { ru: 'НОВАЯ ВЕРСИЯ', en: 'NEW VERSION' },
  'materialLifecycle.noVersions': { ru: 'ИСТОРИЯ ВЕРСИЙ ОТСУТСТВУЕТ', en: 'NO VERSION HISTORY' },
  'materialLifecycle.saveButton': { ru: '[S] СОХРАНИТЬ', en: '[S] SAVE' },
  'materialLifecycle.trashButton': { ru: '[T] В КОРЗИНУ', en: '[T] MOVE TO TRASH' },
  'materialLifecycle.trashConfirmDescription': {
    ru: 'Материал уйдёт в корзину группы. До полного удаления его можно восстановить из вкладки КОРЗИНА.',
    en: 'The material moves to the group trash. It can be restored from the TRASH tab until it is permanently deleted.',
  },
  'materialLifecycle.trashConfirmTitle': {
    ru: 'ПЕРЕМЕСТИТЬ МАТЕРИАЛ В КОРЗИНУ?',
    en: 'MOVE MATERIAL TO TRASH?',
  },
  'materialLifecycle.unknownError': {
    ru: 'НЕИЗВЕСТНАЯ ОШИБКА ОПЕРАЦИИ',
    en: 'UNKNOWN OPERATION ERROR',
  },
  'materialLifecycle.uploadVersionLabel': {
    ru: 'Загрузить новую версию материала',
    en: 'Upload a new version of the material',
  },
  'materialLifecycle.versionUploaded': { ru: 'НОВАЯ ВЕРСИЯ ЗАГРУЖЕНА', en: 'NEW VERSION UPLOADED' },
  'materialLifecycle.versionsHeader': { ru: 'ВЕРСИИ / {count}', en: 'VERSIONS / {count}' },

  // LocalMaterialPlayer.tsx
  'localPlayer.ariaLabel': {
    ru: 'Локальный медиаплеер: {title}',
    en: 'Local media player: {title}',
  },
  'localPlayer.positionLabel': { ru: 'Позиция воспроизведения', en: 'Playback position' },
  'localPlayer.rateFieldLabel': { ru: 'СКОРОСТЬ', en: 'SPEED' },
  'localPlayer.settingsButtonLabel': { ru: 'Настройки плеера', en: 'Player settings' },
  'localPlayer.settingsTitle': { ru: 'НАСТРОЙКИ ПЛЕЕРА', en: 'PLAYER SETTINGS' },
  'localPlayer.subtitlesFieldLabel': { ru: 'СУБТИТРЫ', en: 'SUBTITLES' },
  'localPlayer.subtitlesOffLabel': { ru: '[CC] СУБТИТРЫ ВЫКЛ', en: '[CC] SUBS OFF' },
  'localPlayer.subtitlesOnLabel': { ru: '[CC] СУБТИТРЫ ВКЛ', en: '[CC] SUBS ON' },
  'localPlayer.subtitlesToggleLabel': { ru: 'Показывать субтитры', en: 'Show subtitles' },
  'localPlayer.volumeLabel': { ru: 'ГРОМКОСТЬ', en: 'VOLUME' },

  // LocalMaterialPreview.tsx
  'localPreview.errorReason': { ru: 'ОШИБКА VIEWER: {message}', en: 'VIEWER ERROR: {message}' },
  'localPreview.imageAlt': { ru: 'Предпросмотр {name}', en: 'Preview of {name}' },
  'localPreview.loadingReason': {
    ru: 'ЧТЕНИЕ ЛОКАЛЬНОГО MATERIAL STREAM…',
    en: 'READING LOCAL MATERIAL STREAM…',
  },
  'localPreview.oversizeReason': {
    ru: 'МАТЕРИАЛ ПРЕВЫШАЕТ БЕЗОПАСНЫЙ ЛИМИТ ЛОКАЛЬНОГО ПРЕДПРОСМОТРА',
    en: 'MATERIAL EXCEEDS THE SAFE LOCAL PREVIEW LIMIT',
  },
  'localPreview.pdfTitle': { ru: 'PDF предпросмотр {name}', en: 'PDF preview of {name}' },
  'localPreview.statusBadge': { ru: '[ЛОКАЛЬНЫЙ ПРОСМОТР]', en: '[LOCAL VIEWER]' },
  'localPreview.textPreviewLabel': { ru: 'Текстовый предпросмотр', en: 'Text preview' },
  'localPreview.unknownError': {
    ru: 'Неизвестная ошибка локального предпросмотра.',
    en: 'Unknown local preview error.',
  },
  'localPreview.unsupportedReason': {
    ru: 'ПРЕДПРОСМОТР ЭТОГО ТИПА БУДЕТ ДОБАВЛЕН ОТДЕЛЬНЫМ VIEWER',
    en: 'PREVIEW OF THIS TYPE WILL BE ADDED AS A SEPARATE VIEWER',
  },

  // MaterialRenditionMenu.tsx
  'rendition.outcome.failed': { ru: 'ВАРИАНТ НЕДОСТУПЕН', en: 'VARIANT UNAVAILABLE' },
  'rendition.outcome.original': {
    ru: 'ВАРИАНТ НЕ СОБРАН — ОТДАН ОРИГИНАЛ',
    en: 'VARIANT NOT BUILT — ORIGINAL SERVED',
  },
  'rendition.outcome.pending': { ru: 'ЗАПРОС ГРАНТА…', en: 'REQUESTING GRANT…' },
  'rendition.outcome.rendered': { ru: 'ВАРИАНТ ВЫДАН', en: 'VARIANT ISSUED' },
  'rendition.qualityLabel': { ru: 'Качество воспроизведения', en: 'Playback quality' },
  'rendition.singleEntry': {
    ru: '[Q] ORIGINAL / БЕЗ ЛЕСТНИЦЫ КАЧЕСТВА',
    en: '[Q] ORIGINAL / NO QUALITY LADDER',
  },

  // MaterialAnnotationsPanel.tsx
  'annotations.addButton': { ru: '[+] ДОБАВИТЬ НА {timestamp}', en: '[+] ADD AT {timestamp}' },
  'annotations.draftLabel': { ru: 'Текст новой аннотации', en: 'New annotation text' },
  'annotations.draftPlaceholder': { ru: 'ЗАМЕТКА НА {timestamp}…', en: 'NOTE AT {timestamp}…' },
  'annotations.empty': { ru: 'ЗАМЕТОК НЕТ', en: 'NO NOTES' },
  'annotations.headerLabel': { ru: '[АННОТАЦИИ]', en: '[ANNOTATIONS]' },
  'annotations.panelLabel': { ru: 'Аннотации материала', en: 'Material annotations' },
  'annotations.removeLabel': { ru: 'Удалить аннотацию', en: 'Remove annotation' },
} as const satisfies CatalogModule;
