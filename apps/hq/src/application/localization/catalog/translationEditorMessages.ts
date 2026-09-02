import type { CatalogModule } from './catalogTypes';

/**
 * The in-app translation editor (`TranslationEditorSection.tsx`): its own
 * settings section heading, the toolbar, the per-row controls and the label
 * for every reason `translationOverrides.ts`'s validator can refuse an entry.
 *
 * `settingsSection.translations` lives here rather than in `systemMessages.ts`
 * -- which owns every other `settingsSection.*` id -- because that file is
 * outside this module's reach this wave; the catalogue merge is a flat
 * namespace, and the duplicate-id test is what would catch two modules
 * naming the same id, not a rule that one file owns one prefix.
 */
export const translationEditorMessages = {
  'settingsSection.translations': { ru: 'ПЕРЕВОДЫ', en: 'TRANSLATIONS' },
  'translationEditor.eyebrow': { ru: 'ПРАВКИ КАТАЛОГА', en: 'CATALOGUE EDITS' },
  'translationEditor.scopeNotice': {
    ru: 'Здесь можно переопределить текст, который уже показывает приложение — на русском и на английском. Русский остаётся исходным языком каталога; добавить третий язык через этот редактор нельзя, список языков задаётся в коде.',
    en: 'This overrides text the application already shows — in Russian and in English. Russian stays the catalogue’s source language; this editor cannot add a third language, the list of languages is set in code.',
  },
  'translationEditor.localeTabsLabel': { ru: 'Язык для правки', en: 'Locale being edited' },
  'translationEditor.localeRu': { ru: 'RU (ИСТОЧНИК)', en: 'RU (SOURCE)' },
  'translationEditor.localeEn': { ru: 'EN (АНГЛИЙСКИЙ)', en: 'EN (ENGLISH)' },
  'translationEditor.localeSummary': { ru: 'ПРАВОК: {count}', en: 'OVERRIDES: {count}' },
  'translationEditor.searchLabel': {
    ru: 'Поиск по идентификатору или тексту',
    en: 'Search by id or text',
  },
  'translationEditor.searchPlaceholder': { ru: '[ПОИСК]', en: '[SEARCH]' },
  'translationEditor.jumpLabel': { ru: 'Перейти к идентификатору', en: 'Jump to id' },
  'translationEditor.jumpPlaceholder': { ru: '[ИД]', en: '[ID]' },
  'translationEditor.jumpEmptyLabel': { ru: '[ НЕТ СОВПАДЕНИЙ ]', en: '[ NO MATCHES ]' },
  'translationEditor.resultsSummary': {
    ru: 'ПОКАЗАНО {shown} ИЗ {total}',
    en: 'SHOWING {shown} OF {total}',
  },
  'translationEditor.noResults': { ru: 'Нет совпадений.', en: 'No matches.' },
  'translationEditor.tableAriaLabel': { ru: 'Каталог сообщений', en: 'Message catalogue' },
  'translationEditor.columnId': { ru: 'ИД', en: 'ID' },
  'translationEditor.columnSourceRu': { ru: 'RU (ИСТОЧНИК)', en: 'RU (SOURCE)' },
  'translationEditor.columnBuiltInEn': { ru: 'EN (ШТАТНЫЙ)', en: 'EN (BUILT-IN)' },
  'translationEditor.columnOverride': {
    ru: 'ПРАВКА ОПЕРАТОРА ({locale})',
    en: 'OPERATOR OVERRIDE ({locale})',
  },
  'translationEditor.columnActions': { ru: 'ДЕЙСТВИЯ', en: 'ACTIONS' },
  'translationEditor.overrideAriaLabel': { ru: 'Правка для {id}', en: 'Override for {id}' },
  'translationEditor.resetButton': { ru: 'СБРОСИТЬ', en: 'RESET' },
  'translationEditor.resetAriaLabel': {
    ru: 'Сбросить правку для {id}',
    en: 'Reset the override for {id}',
  },
  'translationEditor.tokenTag': { ru: 'ТОКЕН', en: 'TOKEN' },
  'translationEditor.pluralTag': { ru: 'МНОЖ. ЧИСЛО', en: 'PLURAL' },
  'translationEditor.refusedInline': { ru: 'Отклонено: {reason}', en: 'Refused: {reason}' },
  'translationEditor.clearAllButton': { ru: 'ОЧИСТИТЬ ВСЁ', en: 'CLEAR ALL' },
  'translationEditor.clearAllDialogTitle': {
    ru: 'ОЧИСТИТЬ ВСЕ ПРАВКИ?',
    en: 'CLEAR EVERY OVERRIDE?',
  },
  'translationEditor.clearAllDialogDescription': {
    ru: 'Все правки перевода на обоих языках вернутся к штатному тексту приложения. Действие нельзя отменить через CTRL+Z.',
    en: 'Every translation override in both languages returns to the application’s built-in text. This cannot be undone with CTRL+Z.',
  },
  'translationEditor.clearAllConfirmLabel': { ru: 'ОЧИСТИТЬ', en: 'CLEAR' },
  'translationEditor.exportButton': { ru: '[↓] ЭКСПОРТ', en: '[↓] EXPORT' },
  'translationEditor.importButton': { ru: '[↑] ИМПОРТ', en: '[↑] IMPORT' },
  'translationEditor.importFileAriaLabel': {
    ru: 'Импорт правок перевода',
    en: 'Import translation overrides',
  },
  'translationEditor.importSuccessStatus': {
    ru: '[✓] ИМПОРТИРОВАНО: {count} ({locale})',
    en: '[✓] IMPORTED: {count} ({locale})',
  },
  'translationEditor.importMalformedStatus': {
    ru: '[!] ФАЙЛ ОТКЛОНЁН: НЕВЕРНЫЙ ФОРМАТ',
    en: '[!] FILE REJECTED: WRONG SHAPE',
  },
  'translationEditor.importUnknownLocaleStatus': {
    ru: '[!] ФАЙЛ ОТКЛОНЁН: НЕИЗВЕСТНЫЙ ЯЗЫК «{locale}»',
    en: '[!] FILE REJECTED: UNKNOWN LOCALE "{locale}"',
  },
  'translationEditor.importEntryRefusedStatus': {
    ru: '[!] ЗАПИСЬ «{id}» ОТКЛОНЕНА: {reason}',
    en: '[!] ENTRY "{id}" REFUSED: {reason}',
  },
  'translationEditor.importCapStatus': {
    ru: '[!] ФАЙЛ ОТКЛОНЁН: ПРЕВЫШЕН ЛИМИТ ЗАПИСЕЙ',
    en: '[!] FILE REJECTED: ENTRY LIMIT EXCEEDED',
  },
  // One label per `TranslationOverrideRefusalReason` (`translationOverrides.ts`),
  // so a reason code the validator returns always has somewhere to resolve to
  // -- a reason added there with no line here is a compile error, the same
  // guarantee `settingLocalization.ts` holds for a setting id.
  'translationEditor.reasonUnknownLocale': { ru: 'неизвестный язык', en: 'unknown locale' },
  'translationEditor.reasonUnknownId': {
    ru: 'нет такого идентификатора',
    en: 'no such id',
  },
  'translationEditor.reasonNonCatalogId': {
    ru: 'это токен, правке не подлежит',
    en: 'this is a token, not editable',
  },
  'translationEditor.reasonPluralMessage': {
    ru: 'запись со счётом, правка пока недоступна',
    en: 'a counted message, override not yet supported',
  },
  'translationEditor.reasonEmpty': { ru: 'пустой текст', en: 'empty text' },
  'translationEditor.reasonTooLong': {
    ru: 'текст длиннее 512 символов',
    en: 'text longer than 512 characters',
  },
  'translationEditor.reasonControlCharacter': {
    ru: 'содержит управляющий символ',
    en: 'contains a control character',
  },
  'translationEditor.reasonBidiOverride': {
    ru: 'содержит символ смены направления письма',
    en: 'contains a bidi-override character',
  },
  'translationEditor.reasonPlaceholderMismatch': {
    ru: 'набор плейсхолдеров не совпадает с исходным текстом',
    en: 'the placeholder set does not match the source text',
  },
  'translationEditor.reasonEntryCountCap': {
    ru: 'достигнут предел количества правок',
    en: 'the entry count cap is reached',
  },
} as const satisfies CatalogModule;
