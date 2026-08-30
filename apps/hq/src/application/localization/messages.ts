/**
 * The message catalogue: every label the application draws for itself, keyed
 * by a stable id, in Russian and in English.
 *
 * No i18n library. The three that would fit -- i18next, FormatJS, Lingui --
 * all bring a loader, a plural/ICU compiler and a runtime message store, and
 * this application has no server, no lazy chunk boundary worth splitting a
 * catalogue across, and two locales that ship in the same static export
 * (ADR 0005). What is left of such a library once the loader is unused is a
 * table lookup and a placeholder substitution, which is the file you are
 * reading. Adding one would also put a second validation surface beside
 * `packages/settings-schema`, which is already the trust boundary for
 * everything the operator can change.
 *
 * ## The id convention
 *
 * `<area>.<name>`, lowercase, dot-separated -- the same spelling a setting id
 * uses, because an operator reading a diff should not have to learn two.
 * `<area>` is the surface that draws the string (`nav`, `menu`, `keybind`,
 * `settingsCategory`, `tileCategory`, `edit`, `clock`), never the module that
 * happens to hold it: a label moving between files must not change its id, or
 * a translation is lost by a refactor.
 *
 * Where a table is keyed by a union -- a tile category, a settings group -- the
 * consumer declares a `Record<Union, MessageId>` rather than building the id
 * with a template string. The compiler then catches a union member with no
 * message, which a built id never can.
 *
 * ## Register
 *
 * Two registers are in play and only one of them is translated. Russian is the
 * human register: what an operator reads, and what `ru` below is the source of
 * truth for. Latin uppercase status tokens name protocols and machine state --
 * `UTC`, `RPC:GRPC-WEB`, `UTF-8`, `PTZ` -- and are the same word in every
 * locale. Those live in {@link tokens}, a namespace `translate` resolves
 * before it looks at any locale, so the decision is encoded once instead of
 * being taken again for each string.
 */

export const appLocales = ['ru', 'en'] as const;

export type AppLocale = (typeof appLocales)[number];

/**
 * The locale whose text is written first and reviewed as the original.
 *
 * A message missing from another locale falls back to this one rather than to
 * the id: an operator who switched to English and found one untranslated
 * Russian label is better served than one who found `edit.tiles.heading`.
 */
export const sourceLocale: AppLocale = 'ru';

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Strings that are the same in every locale.
 *
 * Not an oversight list and not "not translated yet": these name a protocol, a
 * unit or a machine state, and translating `UTC` into Russian would produce a
 * word no operator is looking for. The screens' bare `BUS:BROADCAST`,
 * `RPC:GRPC-WEB`, `UTF-8` and `PTZ` readouts call through here now instead of
 * repeating the literal at each site, so the decision that they stay Latin is
 * encoded once rather than taken again for each string.
 */
export const tokens = {
  'token.utc': 'UTC',
  'token.ptz': 'PTZ',
  'token.utf8': 'UTF-8',
  'token.rpcGrpcWeb': 'RPC:GRPC-WEB',
  'token.busBroadcast': 'BROADCAST',
  'token.busFallback': 'FALLBACK',
} as const satisfies Readonly<Record<`token.${string}`, string>>;

export type TokenId = keyof typeof tokens;

/** The Russian catalogue: the source text, and the complete set of ids. */
const ru = {
  // Navigation rail.
  'nav.rail': 'Разделы штаба',
  'nav.overview': 'ОБЗОР',
  'nav.objects': 'ОБЪЕКТЫ',
  'nav.cases': 'ДЕЛА',
  'nav.map': 'КАРТА',
  'nav.video': 'ВИДЕО',
  'nav.comms': 'СВЯЗЬ',
  'nav.files': 'ФАЙЛЫ',
  'nav.archive': 'АРХИВ',
  'nav.search': 'ПОИСК',

  // Keybind descriptions. `keybind.navigate` is the one with a parameter: the
  // nine numbered routes take their target from `primaryNavigation`, so the
  // rail's own label reaches the description rather than being written again.
  'keybind.navigate': 'Перейти: {target}',
  'keybind.shell.search': 'Глобальный поиск',
  'keybind.shell.dismiss': 'Закрыть панель или ящик',
  'keybind.shell.productionPanel': 'Панель режиссёра',
  'keybind.shell.fullscreen': 'Полный экран',
  'keybind.shell.togglePlayback': 'Пуск и пауза видео (на видеоэкранах)',
  'keybind.edit.toggle': 'Режим редактирования',
  'keybind.edit.dockPanel': 'Пристыковать панель редактирования к следующему краю',
  'keybind.keybinds.list': 'Список сочетаний клавиш',
  'keybind.files.import': 'Импорт материалов',
  'keybind.scene.commandPalette': 'Палитра команд сцены',
  'keybind.scene.sectionFiles': 'Раздел: файлы',
  'keybind.scene.sectionMap': 'Раздел: карта',
  'keybind.scene.previousCue': 'Предыдущая реплика сцены',
  'keybind.scene.nextCue': 'Следующая реплика сцены',
  'keybind.scene.resetScene': 'Сбросить сцену',
  'keybind.developer.toggle': 'Панель разработчика',

  'keybindCategory.navigation': 'НАВИГАЦИЯ',
  'keybindCategory.operation': 'ОПЕРАЦИЯ',
  'keybindCategory.editing': 'РЕДАКТИРОВАНИЕ',
  'keybindCategory.developer': 'РАЗРАБОТКА',

  // Context menus.
  'menu.shell': 'Команды штаба',
  'menu.shell.search': 'Глобальный поиск',
  'menu.shell.keybinds': 'Сочетания клавиш',
  'menu.shell.edit': 'Режим редактирования',
  'menu.shell.fullscreen': 'Полный экран',
  'menu.shell.production': 'Панель режиссёра',
  'menu.shell.group': 'Синхронизация группы',
  'menu.shell.diagnostics': 'Скопировать диагностику',
  'menu.record': 'Действия над записью',
  'menu.record.open': 'Открыть карточку',
  'menu.record.select': 'Выделить строку',
  'menu.record.search': 'Найти упоминания',

  /*
   * Settings sections and categories.
   *
   * These were written `ВНЕШНИЙ ВИД / APPEARANCE` -- both languages in one
   * string, because there was nowhere else to put the second one. A catalogue
   * is that place, so each half now stands alone and an English session reads
   * a heading rather than a heading and its own translation.
   */
  'settingsGroup.appearance': 'ВНЕШНИЙ ВИД',
  'settingsGroup.layout': 'МАКЕТ И РАЗМЕРЫ',
  'settingsGroup.motion': 'ДВИЖЕНИЕ И ДОСТУПНОСТЬ',
  'settingsGroup.information': 'ИНФОРМАЦИЯ',
  'settingsGroup.media': 'МЕДИА И КАРТА',
  'settingsGroup.session': 'СЕССИЯ И УПРАВЛЕНИЕ',
  'settingsGroup.system': 'СИСТЕМА',

  'settingsCategory.general': 'ОБЩИЕ',
  'settingsCategory.information': 'ИНФОРМАЦИЯ',
  'settingsCategory.layout': 'МАКЕТ',
  'settingsCategory.tiles': 'ПЛИТКИ',
  'settingsCategory.themes': 'ТЕМЫ',
  'settingsCategory.styles': 'СТИЛИ',
  'settingsCategory.colors': 'ЦВЕТА',
  'settingsCategory.typography': 'ТИПОГРАФИКА',
  'settingsCategory.sizes': 'РАЗМЕРЫ',
  'settingsCategory.backgrounds': 'ФОНЫ',
  'settingsCategory.patterns': 'ПАТТЕРНЫ',
  'settingsCategory.animations': 'АНИМАЦИИ',
  'settingsCategory.startup': 'ЗАПУСК',
  'settingsCategory.player': 'ПЛЕЕР',
  'settingsCategory.cameras': 'КАМЕРЫ',
  'settingsCategory.map': 'КАРТА',
  'settingsCategory.tables': 'ТАБЛИЦЫ',
  'settingsCategory.popups': 'POP-UP',
  'settingsCategory.keybinds': 'КЛАВИШИ',
  'settingsCategory.localization': 'ЛОКАЛИЗАЦИЯ',
  'settingsCategory.dateTime': 'ДАТА И ВРЕМЯ',
  'settingsCategory.telemetry': 'ТЕЛЕМЕТРИЯ',
  'settingsCategory.simulation': 'СИМУЛЯЦИЯ',
  'settingsCategory.groups': 'ГРУППЫ',
  'settingsCategory.materials': 'МАТЕРИАЛЫ',
  'settingsCategory.titlebar': 'ВЕРХНЯЯ ПАНЕЛЬ',
  'settingsCategory.statusline': 'НИЖНЯЯ ПАНЕЛЬ',
  'settingsCategory.accessibility': 'ДОСТУПНОСТЬ',
  'settingsCategory.performance': 'ПРОИЗВОДИТЕЛЬНОСТЬ',
  'settingsCategory.privacy': 'ПРИВАТНОСТЬ',
  'settingsCategory.diagnostics': 'ДИАГНОСТИКА',
  'settingsCategory.github': 'ИНТЕГРАЦИЯ GITHUB',
  'settingsCategory.advanced': 'РАСШИРЕННЫЕ',

  // Shown beside a setting listed in `settingsAwaitingTheirFeature`: it can be
  // changed, but nothing reads it yet.
  'settings.awaitingFeature': 'ПОКА НЕ ДЕЙСТВУЕТ — изменение ни на что не влияет',

  /*
   * Tile groups, reconciled.
   *
   * `TileMotionPicker` and `TileVisibility` each carried a
   * `Record<TileCategory, string>` over the same union and the two disagreed:
   * `records` was `РЕЕСТРЫ` in one and `ЗАПИСИ` in the other, `detail` was
   * `КАРТОЧКИ` against `КАРТОЧКА`, `geo` was `ГЕО` against `ГЕОГРАФИЯ`. One
   * table now, and the wording chosen rather than averaged: `РЕЕСТРЫ` because
   * `routeLabels` already calls the objects screen `РЕЕСТР ОБЪЕКТОВ` and a
   * group name should be the application's own word; `КАРТОЧКИ` in the plural
   * because the entry names a group of tiles, not one card; `ГЕОГРАФИЯ`
   * because the other six are words and `ГЕО` was the only abbreviation.
   */
  'tileCategory.summary': 'СВОДКА',
  'tileCategory.records': 'РЕЕСТРЫ',
  'tileCategory.detail': 'КАРТОЧКИ',
  'tileCategory.navigation': 'НАВИГАЦИЯ',
  'tileCategory.telemetry': 'ТЕЛЕМЕТРИЯ',
  'tileCategory.events': 'СОБЫТИЯ',
  'tileCategory.geo': 'ГЕОГРАФИЯ',

  'tileMotion.inherit': 'КАК У ГРУППЫ',
  'tileMotion.none': 'БЕЗ ДВИЖЕНИЯ',
  'tileMotion.fade': 'ПРОЯВЛЕНИЕ',
  'tileMotion.rise': 'ПОДЪЁМ',
  'tileMotion.scan': 'РАЗВЁРТКА',

  'tilePresentation.auto': 'КАК У ГРУППЫ',
  'tilePresentation.full': 'ПОЛНЫЙ ВИД',
  'tilePresentation.compact': 'КОМПАКТНЫЙ ВИД',
  'tilePresentation.minimal': 'МИНИМАЛЬНЫЙ ВИД',

  // Edit mode.
  'edit.tiles.heading': 'ПЛИТКИ ЭКРАНА',
  'edit.tiles.groups': 'ГРУППЫ',
  'edit.tiles.noneOnScreen':
    'На этом экране сейчас нет плиток — поимённый выбор появится, когда вы откроете экран с плитками. Группы ниже переключаются и без него.',
  'edit.tileMotion.heading': 'ДВИЖЕНИЕ ПЛИТОК',
  'edit.tileMotion.hint': 'Нажмите на плитку, чтобы задать её собственное движение.',
  'edit.tileMotion.tile': 'Движение плитки {tile}',
  'edit.tileMotion.category': 'Движение группы {category}',
  'edit.tilePresentation.heading': 'ВИД ПЛИТОК',
  'edit.tilePresentation.hint': 'Нажмите на плитку, чтобы задать её собственный вид.',
  'edit.tilePresentation.tile': 'Вид плитки {tile}',
  'edit.tilePresentation.category': 'Вид группы {category}',

  'edit.translation.heading': 'ПЕРЕВОД ЭЛЕМЕНТА',
  'edit.translation.hint': 'Нажмите на плитку, чтобы задать её подпись на текущем языке.',
  'edit.translation.field': 'Подпись плитки {element} на языке {locale}',
  'edit.translation.reset': 'Вернуть исходную подпись',
  'edit.translation.count': 'Своих подписей: {count}',
  'edit.translation.propose': 'ЧЕРНОВИК ПЕРЕВОДА',
  /*
   * Said in the panel rather than only in a commit message: the operator is
   * about to leave the application for a GitHub form, and an application that
   * later showed no pull-request link would read as a failure rather than as
   * the boundary it is. Nothing here holds a token, so nothing here can watch
   * the branch that the operator has not created yet.
   */
  'edit.translation.proposeHint':
    'Откроется форма GitHub с готовым файлом перевода. Пулл-реквест создаёте вы при коммите — приложение не узнает его адрес и не может показать ссылку на него.',

  // The clock marker. `utc` is not here: it is a token, not a word.
  'clock.mode.operation': 'ОПЕР',
  'clock.mode.system': 'СИСТ',

  /*
   * What each `statusline.elements` and `titlebar.elements` member is, in the
   * operator's language. Both settings were edited as a raw comma list of
   * these ids (`SchemaSetting`'s `string-list` editor had no per-value
   * catalogue), which is what `statuslineElementLabel` and
   * `titlebarElementLabel` read instead -- for the row's own detail text and
   * for `TerminalElementsConstructor`, which replaced the text field with a
   * pick-and-order control for both.
   */
  'statuslineElement.system': 'СИСТЕМА',
  'statuslineElement.route': 'ТЕКУЩИЙ МАРШРУТ',
  'statuslineElement.cpu': 'ЗАГРУЗКА ПРОЦЕССОРА',
  'statuslineElement.ram': 'ЗАГРУЗКА ПАМЯТИ',
  'statuslineElement.net': 'СЕТЕВОЙ ТРАФИК',
  'statuslineElement.probe': 'ТРАНСПОРТ СЕССИИ',
  'statuslineElement.alerts': 'СЧЁТЧИК ТРЕВОГ',
  'statuslineElement.encoding': 'КОДИРОВКА',
  'statuslineElement.clock': 'ЧАСЫ',
  'statuslineElement.hints': 'ПОДСКАЗКИ КЛАВИШ',

  'titlebarElement.title': 'ЗАГОЛОВОК ОКНА',
  'titlebarElement.information': 'ИНФОРМАЦИОННЫЙ СЛОТ',
  'titlebarElement.minimize': 'СВЕРНУТЬ',
  'titlebarElement.maximize': 'РАЗВЕРНУТЬ',
  'titlebarElement.close': 'ЗАКРЫТЬ',

  /*
   * A setting's own `description`, in the operator's language.
   *
   * `packages/settings-schema` is a trust boundary and stays English-only
   * (`apps/control-plane/src/settings/schema.ts` sends no localization key for
   * the same reason); this table is where a translation is authored instead,
   * read by `settingLocalization.ts` and keyed by the definition's own id so a
   * label moving between settings files still finds its text. Not every
   * definition has an entry: `localizedSettingDescription` falls back to the
   * schema's own English line for one that does not, which is what a session
   * in either language showed for all seventy of these before this batch and
   * still shows for the rest -- an intentional, documented gap, not a second
   * silent default the way a missing chrome string would be.
   */
  'settingDescription.general.localOnly': 'Клиент остаётся работоспособным без группы.',
  'settingDescription.general.brandTagline': 'Показывать слоган под маркой операции.',
  'settingDescription.general.secureLinkBadge': 'Показывать значок защищённого канала в шапке.',
  'settingDescription.dateTime.showSeconds': 'Показывать секунды на часах шапки и в нижней панели.',
  'settingDescription.dateTime.showModeLabel':
    'Показывать в нижней панели, какой режим часов сейчас показан.',
  'settingDescription.dateTime.showClockRate':
    'Показывать скорость хода часов рядом с часами шапки.',
  'settingDescription.dateTime.showHeaderDate': 'Показывать дату в метаданных шапки.',
  'settingDescription.dateTime.mode':
    'Показывать оперативное или системное время, не трогая часы ОС.',
  'settingDescription.diagnostics.showTransportProbe':
    'Показывать индикатор транспорта в нижней панели.',
  'settingDescription.diagnostics.showKeybindHints':
    'Показывать подсказку сочетаний клавиш в нижней панели.',
  'settingDescription.information.showOperationalContext':
    'Показывать контекст операции и сектора на панелях.',
  'settingDescription.tiles.presentation':
    'Верхняя граница подробности отрисовки плитки; «как у группы» оставляет выбор макету.',
  /*
   * The dropdown options of `dateTime.mode`, as full words: the 4-character
   * status-line markers (`dateTime.ts`'s `dateTimeModeLabel`) belong to a
   * surface that is paying for every character, and a settings dropdown is
   * not. `utc` has no entry on purpose -- the uppercase fallback already
   * spells it `UTC` in every locale.
   */
  'settingOption.dateTime.mode.operation': 'ОПЕРАТИВНОЕ',
  'settingOption.dateTime.mode.system': 'СИСТЕМНОЕ',

  /*
   * `OperationsShell`: the header, the primary nav, the status line's
   * transport popover, the record drawer and the production panel. The
   * biggest single sweep of F11's chrome pass, so the ids below split into
   * the areas that draw them rather than one flat list.
   */
  'topbar.brand': 'ГРЕМУЧАЯ//MESH',
  'topbar.phase': '{code} / ФАЗА {phase}',
  'topbar.date': 'ДАТА',
  'topbar.session': 'СЕССИЯ',
  'topbar.operatorCode': 'ОП-01',
  'topbar.link': 'СВЯЗЬ',
  'topbar.openActiveAlert': 'Открыть активную тревогу',
  'topbar.commandsLabel': 'КОМАНДЫ',

  'nav.primaryLabel': 'Основная навигация',
  'nav.toggleCompact': 'Переключить компактную навигацию',

  'shell.openSystemStatus': 'Открыть состояние системы',
  'shell.openLoadAnalytics': 'Открыть аналитику нагрузки',
  'shell.openNewAlert': 'Открыть новую тревогу',
  'shell.toggleClockMode': 'Переключить режим часов',

  'transport.description': 'Чем этот экран синхронизируется с остальными',
  'transport.detailsLabel': 'Подробности транспорта',
  'transport.busLabel': 'ШИНА ЭКРАНОВ',
  'transport.busBroadcastDetail': 'BroadcastChannel — вкладки одного браузера',
  'transport.busFallbackDetail': 'storage-события — BroadcastChannel недоступен',
  'transport.rpcDetail': 'ConnectRPC поверх бинарного gRPC-Web',
  'transport.screenLabel': 'ЭКРАН',
  'transport.groupSyncLabel': 'ГРУППОВАЯ СИНХРОНИЗАЦИЯ',
  'transport.authorityLabel': 'АВТОРИТЕТ',
  'transport.noGroupAssigned': 'Группа не назначена',
  'transport.eventChannelLabel': 'КАНАЛ СОБЫТИЙ',
  'transport.linkPrimary': 'СВЯЗЬ · ОСНОВНАЯ',
  'transport.linkSecondary': 'СВЯЗЬ · ЗАПАСНАЯ',
  'transport.otherPlaneUnused': 'ДРУГАЯ БАЗА CONTROL PLANE — НЕ ИСПОЛЬЗУЕТСЯ',
  'transport.eventMarker': ' — событие {sequence}',
  'transport.resyncMarker': ', пересинхронизаций {count}',
  'transport.groupClockLabel': 'ЧАСЫ ГРУППЫ',
  'transport.notMeasured': 'Не измерены',
  'transport.clockOffset': 'Сдвиг {offset} мс, задержка {latency} мс',
  'transport.localMirrorLabel': 'ЛОКАЛЬНАЯ КОПИЯ',
  'transport.mirrorNotPresent': 'Нет — значения берутся из сборки',
  'transport.mirrorUpdated': 'Обновлена {at}, ревизия {revision}',

  // Generic definition-list field names, reused wherever the record drawer
  // (or the topbar) names the same field on a different kind of record.
  'field.sector': 'СЕКТОР',
  'field.clearance': 'ДОПУСК',
  'field.source': 'ИСТОЧНИК',
  'field.object': 'ОБЪЕКТ',
  'field.status': 'СТАТУС',
  'field.coordinates': 'КООРДИНАТЫ',
  'field.name': 'НАЗВАНИЕ',
  'field.time': 'ВРЕМЯ',
  'field.objects': 'ОБЪЕКТЫ',
  'field.cases': 'ДЕЛА',
  'field.signal': 'СИГНАЛ',
  'field.stream': 'ПОТОК',
  'field.codec': 'КОДЕК',
  'field.length': 'ДЛИНА',
  'field.risk': 'РИСК',
  'field.encryption': 'ШИФРОВАНИЕ',
  'field.latency': 'ЗАДЕРЖКА',
  'field.size': 'РАЗМЕР',
  'field.tags': 'ТЕГИ',

  'unit.km': 'КМ',
  'unit.min': 'МИН',

  'drawer.confirmAlert': '[A] ПОДТВЕРДИТЬ ТРЕВОГУ',
  'drawer.completeTask': '[X] ОТМЕТИТЬ ВЫПОЛНЕННЫМ',
  'drawer.attachToCase': '[+] ПРИКРЕПИТЬ К ДЕЛУ',
  'drawer.signalLevel': 'УРОВЕНЬ СИГНАЛА',
  'drawer.progression': 'ПРОХОЖДЕНИЕ',
  'drawer.linkedObjects': 'Связанные объекты: {list}',

  'production.panelLabel': 'Панель съёмочного режима',
  'production.heading': 'УПРАВЛЕНИЕ СЪЁМОЧНЫМ СОСТОЯНИЕМ',
  'production.presetLabel': 'Сценарный preset',
  'production.fixedTimeLabel': 'Фиксированное время production',
  'production.clockSpeedLabel': 'Скорость часов',
  'production.saveSnapshot': '[S] СОХРАНИТЬ СОСТОЯНИЕ СЦЕНЫ',

  /*
   * `UiGalleryScreen`: the `/dev/ui` component catalogue. The typography
   * panel's own demonstration text -- the Cyrillic alphabet and the sample
   * headings under it -- stays out of this table on purpose: it exists to
   * show what the glyphs look like, and translating it would defeat the one
   * thing that panel demonstrates.
   */
  'gallery.menuInspect': 'ПРОВЕРИТЬ КОНТУР',
  'gallery.menuInspectedTitle': 'КОНТУР ПРОВЕРЕН',
  'gallery.menuInspectedDescription': 'ARIA И KEYBOARD-КОНТРАКТ АКТИВЕН',
  'gallery.menuIsolate': 'ИЗОЛИРОВАТЬ УЗЕЛ',
  'gallery.menuIsolatedTitle': 'УЗЕЛ ИЗОЛИРОВАН',
  'gallery.menuIsolatedDescription': 'ДЕМО-ОПЕРАЦИЯ UI-КАТАЛОГА',
  'gallery.screenTitle': 'UI КАТАЛОГ ТЕРМИНАЛЬНОГО КОНТУРА',
  'gallery.statusesPanel': 'СТАТУСЫ',
  'gallery.metricsPanel': 'МЕТРИКИ',
  'gallery.progressPanel': 'ПРОГРЕСС И ГРАФИКИ',
  'gallery.demoChart': 'Демо график',
  'gallery.gaugePanel': 'ДАТЧИК',
  'gallery.actionsPanel': 'ДЕЙСТВИЯ',
  'gallery.tooltipDemo': 'Терминальная подсказка без скруглений',
  'gallery.dialogTitle': 'ПРОВЕРКА КОНТУРА',
  'gallery.dialogDescription': 'Поведенческий слой Base UI, визуальный слой оперативного штаба.',
  'gallery.confirm': '[ENTER] ПОДТВЕРДИТЬ',
  'gallery.menuLabel': 'Действия контура',
  'gallery.contextMenuLabel': 'Контекстные действия контура',
  'gallery.toastReadyTitle': 'СИСТЕМА ГОТОВА',
  'gallery.formPanel': 'ПОЛЯ И ВЫБОР',
  'gallery.sectorFieldDescription': 'Текстовое поле с общим Field-контрактом',
  'gallery.secureChannelLabel': 'Защищённый канал',
  'gallery.secureChannelSpan': 'ЗАЩИЩЁННЫЙ КАНАЛ',
  'gallery.accessGroupLabel': 'Группа доступа',
  'gallery.optionAlpha': 'АЛЬФА',
  'gallery.optionBravo': 'БРАВО',
  'gallery.loadLabel': 'Нагрузка',
  'gallery.intensityLabel': 'Интенсивность',
  'gallery.observedObjectLabel': 'Объект наблюдения',
  'gallery.objectK17': 'K-17 / АЛЬФА',
  'gallery.objectDmc12': 'DMC-12 / ДРОН',
  'gallery.objectFp2': 'FP-2 / РУБЕЖ',
  'gallery.compositePanel': 'КОМПОЗИТНЫЕ ЭЛЕМЕНТЫ',
  'gallery.diagnosticsLabel': 'Диагностика',
  'gallery.statusTab': 'СТАТУС',
  'gallery.historyTab': 'ИСТОРИЯ',
  'gallery.syncProgressLabel': 'СИНХРОНИЗАЦИЯ',
  'gallery.standCommandsLabel': 'Команды стенда',
  'gallery.scanCompleteToast': 'СКАНИРОВАНИЕ ЗАВЕРШЕНО',
  'gallery.contourLockedToast': 'КОНТУР ЗАБЛОКИРОВАН',
  'gallery.popoverTitle': 'СОСТОЯНИЕ УЗЛА',
  'gallery.popoverDescription': 'Всплывающая панель с управлением фокусом',
  'gallery.confirmOperationTitle': 'ПОДТВЕРДИТЬ ОПЕРАЦИЮ',
  'gallery.confirmOperationDescription':
    'Демонстрация безопасного подтверждения критического действия.',
  'gallery.operationConfirmedToast': 'ОПЕРАЦИЯ ПОДТВЕРЖДЕНА',
  'gallery.emptyStatePanel': 'ПУСТОЕ СОСТОЯНИЕ',
  'gallery.emptyStateText': 'ДАННЫЕ В ЭТОМ СЕКТОРЕ ОТСУТСТВУЮТ',
  'gallery.openExample': '[D] ОТКРЫТЬ ПРИМЕР',
  'gallery.typographyPanel': 'ТИПОГРАФИКА',
} as const satisfies Readonly<Record<string, string>>;

export type MessageId = keyof typeof ru | TokenId;

/**
 * The English catalogue.
 *
 * Annotated rather than inferred on purpose: the annotation is what makes a
 * missing id and an id that exists only here both compile errors, before any
 * test runs. `messages.test.ts` asserts the same thing at runtime, so
 * loosening this type cannot pass unnoticed.
 */
const en: Readonly<Record<Exclude<MessageId, TokenId>, string>> = {
  'nav.rail': 'Headquarters sections',
  'nav.overview': 'OVERVIEW',
  'nav.objects': 'OBJECTS',
  'nav.cases': 'CASES',
  'nav.map': 'MAP',
  'nav.video': 'VIDEO',
  'nav.comms': 'COMMS',
  'nav.files': 'FILES',
  'nav.archive': 'ARCHIVE',
  'nav.search': 'SEARCH',

  'keybind.navigate': 'Go to: {target}',
  'keybind.shell.search': 'Global search',
  'keybind.shell.dismiss': 'Close the panel or drawer',
  'keybind.shell.productionPanel': 'Director panel',
  'keybind.shell.fullscreen': 'Full screen',
  'keybind.shell.togglePlayback': 'Play and pause video (on video screens)',
  'keybind.edit.toggle': 'Edit mode',
  'keybind.edit.dockPanel': 'Dock the edit panel to the next edge',
  'keybind.keybinds.list': 'Keyboard shortcut list',
  'keybind.files.import': 'Material import',
  'keybind.scene.commandPalette': 'Scene command palette',
  'keybind.scene.sectionFiles': 'Section: files',
  'keybind.scene.sectionMap': 'Section: map',
  'keybind.scene.previousCue': 'Previous scene cue',
  'keybind.scene.nextCue': 'Next scene cue',
  'keybind.scene.resetScene': 'Reset the scene',
  'keybind.developer.toggle': 'Developer panel',

  'keybindCategory.navigation': 'NAVIGATION',
  'keybindCategory.operation': 'OPERATION',
  'keybindCategory.editing': 'EDITING',
  'keybindCategory.developer': 'DEVELOPMENT',

  'menu.shell': 'Headquarters commands',
  'menu.shell.search': 'Global search',
  'menu.shell.keybinds': 'Keyboard shortcuts',
  'menu.shell.edit': 'Edit mode',
  'menu.shell.fullscreen': 'Full screen',
  'menu.shell.production': 'Director panel',
  'menu.shell.group': 'Group synchronisation',
  'menu.shell.diagnostics': 'Copy diagnostics',
  'menu.record': 'Record actions',
  'menu.record.open': 'Open the card',
  'menu.record.select': 'Select the row',
  'menu.record.search': 'Find mentions',

  'settingsGroup.appearance': 'APPEARANCE',
  'settingsGroup.layout': 'LAYOUT AND SIZES',
  'settingsGroup.motion': 'MOTION AND ACCESSIBILITY',
  'settingsGroup.information': 'INFORMATION',
  'settingsGroup.media': 'MEDIA AND MAP',
  'settingsGroup.session': 'SESSION AND CONTROL',
  'settingsGroup.system': 'SYSTEM',

  'settingsCategory.general': 'GENERAL',
  'settingsCategory.information': 'INFORMATION',
  'settingsCategory.layout': 'LAYOUT',
  'settingsCategory.tiles': 'TILES',
  'settingsCategory.themes': 'THEMES',
  'settingsCategory.styles': 'STYLES',
  'settingsCategory.colors': 'COLORS',
  'settingsCategory.typography': 'TYPOGRAPHY',
  'settingsCategory.sizes': 'SIZES',
  'settingsCategory.backgrounds': 'BACKGROUNDS',
  'settingsCategory.patterns': 'PATTERNS',
  'settingsCategory.animations': 'ANIMATIONS',
  'settingsCategory.startup': 'STARTUP',
  'settingsCategory.player': 'PLAYER',
  'settingsCategory.cameras': 'CAMERAS',
  'settingsCategory.map': 'MAP',
  'settingsCategory.tables': 'TABLES',
  'settingsCategory.popups': 'POPUPS',
  'settingsCategory.keybinds': 'KEYBINDS',
  'settingsCategory.localization': 'LOCALIZATION',
  'settingsCategory.dateTime': 'DATE AND TIME',
  'settingsCategory.telemetry': 'TELEMETRY',
  'settingsCategory.simulation': 'SIMULATION',
  'settingsCategory.groups': 'GROUPS',
  'settingsCategory.materials': 'MATERIALS',
  'settingsCategory.titlebar': 'TITLE BAR',
  'settingsCategory.statusline': 'STATUS LINE',
  'settingsCategory.accessibility': 'ACCESSIBILITY',
  'settingsCategory.performance': 'PERFORMANCE',
  'settingsCategory.privacy': 'PRIVACY',
  'settingsCategory.diagnostics': 'DIAGNOSTICS',
  'settingsCategory.github': 'GITHUB INTEGRATION',
  'settingsCategory.advanced': 'ADVANCED',

  'settings.awaitingFeature': 'NOT WIRED YET — changing this has no effect',

  'tileCategory.summary': 'SUMMARY',
  'tileCategory.records': 'REGISTRIES',
  'tileCategory.detail': 'CARDS',
  'tileCategory.navigation': 'NAVIGATION',
  'tileCategory.telemetry': 'TELEMETRY',
  'tileCategory.events': 'EVENTS',
  'tileCategory.geo': 'GEOGRAPHY',

  'tileMotion.inherit': 'SAME AS GROUP',
  'tileMotion.none': 'NO MOTION',
  'tileMotion.fade': 'FADE',
  'tileMotion.rise': 'RISE',
  'tileMotion.scan': 'SCAN',

  'tilePresentation.auto': 'SAME AS GROUP',
  'tilePresentation.full': 'FULL VIEW',
  'tilePresentation.compact': 'COMPACT VIEW',
  'tilePresentation.minimal': 'MINIMAL VIEW',

  'edit.tiles.heading': 'SCREEN TILES',
  'edit.tiles.groups': 'GROUPS',
  'edit.tiles.noneOnScreen':
    'No tiles on this screen right now -- picking them by name appears once you open a screen that has tiles. The groups below still switch without it.',
  'edit.tileMotion.heading': 'TILE MOTION',
  'edit.tileMotion.hint': 'Press a tile to give it a motion of its own.',
  'edit.tileMotion.tile': 'Motion of tile {tile}',
  'edit.tileMotion.category': 'Motion of group {category}',
  'edit.tilePresentation.heading': 'TILE VIEW',
  'edit.tilePresentation.hint': 'Press a tile to give it a view of its own.',
  'edit.tilePresentation.tile': 'View of tile {tile}',
  'edit.tilePresentation.category': 'View of group {category}',

  'edit.translation.heading': 'ELEMENT TRANSLATION',
  'edit.translation.hint': 'Press a tile to give it a caption in the current language.',
  'edit.translation.field': 'Caption of tile {element} in {locale}',
  'edit.translation.reset': 'Restore the original caption',
  'edit.translation.count': 'Own captions: {count}',
  'edit.translation.propose': 'TRANSLATION DRAFT',
  'edit.translation.proposeHint':
    'A GitHub form opens with the translation file already filled in. You create the pull request when you commit — this application never learns its address and cannot show a link to it.',

  'clock.mode.operation': 'OPER',
  'clock.mode.system': 'SYS',

  'statuslineElement.system': 'SYSTEM',
  'statuslineElement.route': 'CURRENT ROUTE',
  'statuslineElement.cpu': 'CPU LOAD',
  'statuslineElement.ram': 'MEMORY LOAD',
  'statuslineElement.net': 'NETWORK TRAFFIC',
  'statuslineElement.probe': 'SESSION TRANSPORT',
  'statuslineElement.alerts': 'ALERT COUNTER',
  'statuslineElement.encoding': 'ENCODING',
  'statuslineElement.clock': 'CLOCK',
  'statuslineElement.hints': 'KEYBIND HINTS',

  'titlebarElement.title': 'WINDOW TITLE',
  'titlebarElement.information': 'INFORMATION SLOT',
  'titlebarElement.minimize': 'MINIMIZE',
  'titlebarElement.maximize': 'MAXIMIZE',
  'titlebarElement.close': 'CLOSE',

  // The English catalogue reprints the schema's own words rather than
  // paraphrasing them: for this locale the schema and the catalogue would
  // otherwise disagree about the same setting's description for no reason.
  'settingDescription.general.localOnly': 'Keep this client usable without a group.',
  'settingDescription.general.brandTagline': 'Show the tagline under the operation mark.',
  'settingDescription.general.secureLinkBadge': 'Show the secure-link badge in the header.',
  'settingDescription.dateTime.showSeconds': 'Show seconds in the shell clock and the status line.',
  'settingDescription.dateTime.showModeLabel': 'Show which clock mode the status line is reading.',
  'settingDescription.dateTime.showClockRate': 'Show the clock rate beside the header clock.',
  'settingDescription.dateTime.showHeaderDate': 'Show the date in the header metadata.',
  'settingDescription.dateTime.mode':
    'Display operation or system time without changing the OS clock.',
  'settingDescription.diagnostics.showTransportProbe':
    'Show the transport probe in the status line.',
  'settingDescription.diagnostics.showKeybindHints': 'Show the keybind hint in the status line.',
  'settingDescription.information.showOperationalContext':
    'Show operation and sector context in panels.',
  'settingDescription.tiles.presentation':
    'Cap on how rich a tile may be drawn; auto leaves the choice to the layout.',
  'settingOption.dateTime.mode.operation': 'OPERATION',
  'settingOption.dateTime.mode.system': 'SYSTEM',

  'topbar.brand': 'GREMUCHAYA//MESH',
  'topbar.phase': '{code} / PHASE {phase}',
  'topbar.date': 'DATE',
  'topbar.session': 'SESSION',
  'topbar.operatorCode': 'OP-01',
  'topbar.link': 'LINK',
  'topbar.openActiveAlert': 'Open the active alert',
  'topbar.commandsLabel': 'COMMANDS',

  'nav.primaryLabel': 'Primary navigation',
  'nav.toggleCompact': 'Toggle compact navigation',

  'shell.openSystemStatus': 'Open system status',
  'shell.openLoadAnalytics': 'Open load analytics',
  'shell.openNewAlert': 'Open the new alert',
  'shell.toggleClockMode': 'Toggle clock mode',

  'transport.description': 'What this screen synchronises with the rest',
  'transport.detailsLabel': 'Transport details',
  'transport.busLabel': 'SCREEN BUS',
  'transport.busBroadcastDetail': 'BroadcastChannel — tabs of one browser',
  'transport.busFallbackDetail': 'storage events — BroadcastChannel unavailable',
  'transport.rpcDetail': 'ConnectRPC over binary gRPC-Web',
  'transport.screenLabel': 'SCREEN',
  'transport.groupSyncLabel': 'GROUP SYNCHRONISATION',
  'transport.authorityLabel': 'AUTHORITY',
  'transport.noGroupAssigned': 'No group assigned',
  'transport.eventChannelLabel': 'EVENT CHANNEL',
  'transport.linkPrimary': 'LINK · PRIMARY',
  'transport.linkSecondary': 'LINK · SECONDARY',
  'transport.otherPlaneUnused': 'ANOTHER CONTROL PLANE BASE — NOT USED',
  'transport.eventMarker': ' — event {sequence}',
  'transport.resyncMarker': ', {count} resyncs',
  'transport.groupClockLabel': 'GROUP CLOCK',
  'transport.notMeasured': 'Not measured',
  'transport.clockOffset': '{offset} ms offset, {latency} ms latency',
  'transport.localMirrorLabel': 'LOCAL MIRROR',
  'transport.mirrorNotPresent': 'None — values come from the build',
  'transport.mirrorUpdated': 'Updated {at}, revision {revision}',

  'field.sector': 'SECTOR',
  'field.clearance': 'CLEARANCE',
  'field.source': 'SOURCE',
  'field.object': 'OBJECT',
  'field.status': 'STATUS',
  'field.coordinates': 'COORDINATES',
  'field.name': 'NAME',
  'field.time': 'TIME',
  'field.objects': 'OBJECTS',
  'field.cases': 'CASES',
  'field.signal': 'SIGNAL',
  'field.stream': 'STREAM',
  'field.codec': 'CODEC',
  'field.length': 'LENGTH',
  'field.risk': 'RISK',
  'field.encryption': 'ENCRYPTION',
  'field.latency': 'LATENCY',
  'field.size': 'SIZE',
  'field.tags': 'TAGS',

  'unit.km': 'KM',
  'unit.min': 'MIN',

  'drawer.confirmAlert': '[A] ACKNOWLEDGE ALERT',
  'drawer.completeTask': '[X] MARK COMPLETE',
  'drawer.attachToCase': '[+] ATTACH TO CASE',
  'drawer.signalLevel': 'SIGNAL LEVEL',
  'drawer.progression': 'PROGRESSION',
  'drawer.linkedObjects': 'Linked objects: {list}',

  'production.panelLabel': 'Production panel',
  'production.heading': 'PRODUCTION STATE CONTROL',
  'production.presetLabel': 'Scene preset',
  'production.fixedTimeLabel': 'Production fixed time',
  'production.clockSpeedLabel': 'Clock speed',
  'production.saveSnapshot': '[S] SAVE SCENE STATE',

  'gallery.menuInspect': 'INSPECT CONTOUR',
  'gallery.menuInspectedTitle': 'CONTOUR INSPECTED',
  'gallery.menuInspectedDescription': 'ARIA AND KEYBOARD CONTRACT ACTIVE',
  'gallery.menuIsolate': 'ISOLATE NODE',
  'gallery.menuIsolatedTitle': 'NODE ISOLATED',
  'gallery.menuIsolatedDescription': 'UI CATALOG DEMO OPERATION',
  'gallery.screenTitle': 'UI CATALOG OF THE TERMINAL CONTOUR',
  'gallery.statusesPanel': 'STATUSES',
  'gallery.metricsPanel': 'METRICS',
  'gallery.progressPanel': 'PROGRESS AND CHARTS',
  'gallery.demoChart': 'Demo chart',
  'gallery.gaugePanel': 'GAUGE',
  'gallery.actionsPanel': 'ACTIONS',
  'gallery.tooltipDemo': 'A terminal tooltip with no rounded corners',
  'gallery.dialogTitle': 'CONTOUR CHECK',
  'gallery.dialogDescription': "Base UI's behaviour layer, headquarters' own visual layer.",
  'gallery.confirm': '[ENTER] CONFIRM',
  'gallery.menuLabel': 'Contour actions',
  'gallery.contextMenuLabel': 'Contour context actions',
  'gallery.toastReadyTitle': 'SYSTEM READY',
  'gallery.formPanel': 'FIELDS AND CHOICE',
  'gallery.sectorFieldDescription': 'A text field under the shared Field contract',
  'gallery.secureChannelLabel': 'Secure channel',
  'gallery.secureChannelSpan': 'SECURE CHANNEL',
  'gallery.accessGroupLabel': 'Access group',
  'gallery.optionAlpha': 'ALPHA',
  'gallery.optionBravo': 'BRAVO',
  'gallery.loadLabel': 'Load',
  'gallery.intensityLabel': 'Intensity',
  'gallery.observedObjectLabel': 'Observed object',
  'gallery.objectK17': 'K-17 / ALPHA',
  'gallery.objectDmc12': 'DMC-12 / DRONE',
  'gallery.objectFp2': 'FP-2 / PERIMETER',
  'gallery.compositePanel': 'COMPOSITE ELEMENTS',
  'gallery.diagnosticsLabel': 'Diagnostics',
  'gallery.statusTab': 'STATUS',
  'gallery.historyTab': 'HISTORY',
  'gallery.syncProgressLabel': 'SYNCHRONISATION',
  'gallery.standCommandsLabel': 'Stand commands',
  'gallery.scanCompleteToast': 'SCAN COMPLETE',
  'gallery.contourLockedToast': 'CONTOUR LOCKED',
  'gallery.popoverTitle': 'NODE STATE',
  'gallery.popoverDescription': 'A popover with focus management',
  'gallery.confirmOperationTitle': 'CONFIRM THE OPERATION',
  'gallery.confirmOperationDescription': 'A demonstration of safely confirming a critical action.',
  'gallery.operationConfirmedToast': 'OPERATION CONFIRMED',
  'gallery.emptyStatePanel': 'EMPTY STATE',
  'gallery.emptyStateText': 'NO DATA IN THIS SECTOR',
  'gallery.openExample': '[D] OPEN EXAMPLE',
  'gallery.typographyPanel': 'TYPOGRAPHY',
};

/**
 * Tolerant of an incomplete table on purpose.
 *
 * `en` above is annotated complete, so nothing in this repository can ship a
 * gap. The lookup still allows for one because the fallback chain -- target
 * locale, then {@link sourceLocale}, then the visible-missing marker -- is
 * what makes a future third locale contributable in pieces rather than only
 * whole.
 */
const tables: Readonly<Record<AppLocale, Readonly<Partial<Record<MessageId, string>>>>> = {
  ru,
  en,
};

/** Every id the catalogue declares, tokens included. Used by the tests. */
export const messageIds: readonly MessageId[] = [
  ...(Object.keys(ru) as (keyof typeof ru)[]),
  ...(Object.keys(tokens) as TokenId[]),
];

export function messagesFor(locale: AppLocale): Readonly<Partial<Record<MessageId, string>>> {
  return tables[locale];
}

const reportedMissing = new Set<string>();

/**
 * What a missing id renders as.
 *
 * Visible rather than plausible: rendering the id itself produces
 * `edit.tiles.heading` in the middle of a panel, which reads as a label
 * somebody chose and survives a review. The brackets do not, and the console
 * line names it once so a screen full of them is still one line per id.
 *
 * Production keeps the bare id: an operator on a shoot is better served by an
 * odd-looking label than by a decoration that suggests the build is broken.
 */
function missingMessage(id: string): string {
  if (process.env.NODE_ENV === 'production') return id;
  if (!reportedMissing.has(id)) {
    reportedMissing.add(id);
    console.error(`[localization] no message for id "${id}"`);
  }
  return `⟦${id}⟧`;
}

/** Test seam: the guard reports each id once per process, which a suite reuses. */
export function forgetMissingMessageReports(): void {
  reportedMissing.clear();
}

const placeholder = /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu;

/**
 * One message, in one locale.
 *
 * Pure: the locale is an argument, so a test can render both without touching
 * the store and the PR builder can compose a file for a locale nobody is
 * currently looking at. `locale.ts` holds the store-bound readers over it.
 *
 * A placeholder with no matching parameter is left standing rather than
 * replaced with an empty string, for the same reason a missing id is bracketed:
 * `Перейти: {target}` is a bug someone will notice, and `Перейти: ` is not.
 */
export function translateWith(locale: AppLocale, id: MessageId, params?: MessageParams): string {
  const token = (tokens as Readonly<Partial<Record<MessageId, string>>>)[id];
  const source = token ?? tables[locale][id] ?? tables[sourceLocale][id];
  if (source === undefined) return missingMessage(id);
  if (params === undefined) return source;
  return source.replaceAll(placeholder, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}
