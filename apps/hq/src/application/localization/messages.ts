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
 * word no operator is looking for. Slice two of F11 routes the screens'
 * `BUS:BROADCAST`, `RPC:GRPC-WEB`, `UTF-8` and `PTZ` through here as it
 * converts them; the namespace exists now so that conversion is a lookup
 * rather than a fresh decision each time.
 */
export const tokens = {
  'token.utc': 'UTC',
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

  // Edit mode.
  'edit.tiles.heading': 'ПЛИТКИ ЭКРАНА',
  'edit.tiles.groups': 'ГРУППЫ',
  'edit.tileMotion.heading': 'ДВИЖЕНИЕ ПЛИТОК',
  'edit.tileMotion.hint': 'Нажмите на плитку, чтобы задать её собственное движение.',
  'edit.tileMotion.tile': 'Движение плитки {tile}',
  'edit.tileMotion.category': 'Движение группы {category}',

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

  'edit.tiles.heading': 'SCREEN TILES',
  'edit.tiles.groups': 'GROUPS',
  'edit.tileMotion.heading': 'TILE MOTION',
  'edit.tileMotion.hint': 'Press a tile to give it a motion of its own.',
  'edit.tileMotion.tile': 'Motion of tile {tile}',
  'edit.tileMotion.category': 'Motion of group {category}',

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
