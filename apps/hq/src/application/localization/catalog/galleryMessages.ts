import type { CatalogModule } from './catalogTypes';

/**
 * The primitive gallery at `/dev/ui`.
 *
 * Kept in its own module because it is a developer surface: it draws every
 * `Terminal*` primitive in one place and none of its text appears on a route
 * an operator uses on a shoot.
 */
export const galleryMessages = {
  'gallery.accessGroupLabel': { ru: 'Группа доступа', en: 'Access group' },
  'gallery.actionsPanel': { ru: 'ДЕЙСТВИЯ', en: 'ACTIONS' },
  'gallery.compositePanel': { ru: 'КОМПОЗИТНЫЕ ЭЛЕМЕНТЫ', en: 'COMPOSITE ELEMENTS' },
  'gallery.confirm': { ru: '[ENTER] ПОДТВЕРДИТЬ', en: '[ENTER] CONFIRM' },
  'gallery.confirmOperationDescription': {
    ru: 'Демонстрация безопасного подтверждения критического действия.',
    en: 'A demonstration of safely confirming a critical action.',
  },
  'gallery.confirmOperationTitle': { ru: 'ПОДТВЕРДИТЬ ОПЕРАЦИЮ', en: 'CONFIRM THE OPERATION' },
  'gallery.contextMenuLabel': { ru: 'Контекстные действия контура', en: 'Contour context actions' },
  'gallery.contourLockedToast': { ru: 'КОНТУР ЗАБЛОКИРОВАН', en: 'CONTOUR LOCKED' },
  'gallery.demoChart': { ru: 'Демо график', en: 'Demo chart' },
  'gallery.diagnosticsLabel': { ru: 'Диагностика', en: 'Diagnostics' },
  'gallery.dialogDescription': {
    ru: 'Поведенческий слой Base UI, визуальный слой оперативного штаба.',
    en: "Base UI's behaviour layer, headquarters' own visual layer.",
  },
  'gallery.dialogTitle': { ru: 'ПРОВЕРКА КОНТУРА', en: 'CONTOUR CHECK' },
  'gallery.emptyStatePanel': { ru: 'ПУСТОЕ СОСТОЯНИЕ', en: 'EMPTY STATE' },
  'gallery.emptyStateText': {
    ru: 'ДАННЫЕ В ЭТОМ СЕКТОРЕ ОТСУТСТВУЮТ',
    en: 'NO DATA IN THIS SECTOR',
  },
  'gallery.formPanel': { ru: 'ПОЛЯ И ВЫБОР', en: 'FIELDS AND CHOICE' },
  'gallery.gaugePanel': { ru: 'ДАТЧИК', en: 'GAUGE' },
  'gallery.historyTab': { ru: 'ИСТОРИЯ', en: 'HISTORY' },
  'gallery.intensityLabel': { ru: 'Интенсивность', en: 'Intensity' },
  'gallery.loadLabel': { ru: 'Нагрузка', en: 'Load' },
  'gallery.menuInspect': { ru: 'ПРОВЕРИТЬ КОНТУР', en: 'INSPECT CONTOUR' },
  'gallery.menuInspectedDescription': {
    ru: 'ARIA И KEYBOARD-КОНТРАКТ АКТИВЕН',
    en: 'ARIA AND KEYBOARD CONTRACT ACTIVE',
  },
  'gallery.menuInspectedTitle': { ru: 'КОНТУР ПРОВЕРЕН', en: 'CONTOUR INSPECTED' },
  'gallery.menuIsolate': { ru: 'ИЗОЛИРОВАТЬ УЗЕЛ', en: 'ISOLATE NODE' },
  'gallery.menuIsolatedDescription': {
    ru: 'ДЕМО-ОПЕРАЦИЯ UI-КАТАЛОГА',
    en: 'UI CATALOG DEMO OPERATION',
  },
  'gallery.menuIsolatedTitle': { ru: 'УЗЕЛ ИЗОЛИРОВАН', en: 'NODE ISOLATED' },
  'gallery.menuLabel': { ru: 'Действия контура', en: 'Contour actions' },
  'gallery.metricsPanel': { ru: 'МЕТРИКИ', en: 'METRICS' },
  'gallery.objectDmc12': { ru: 'DMC-12 / ДРОН', en: 'DMC-12 / DRONE' },
  'gallery.objectFp2': { ru: 'FP-2 / РУБЕЖ', en: 'FP-2 / PERIMETER' },
  'gallery.objectK17': { ru: 'K-17 / АЛЬФА', en: 'K-17 / ALPHA' },
  'gallery.observedObjectLabel': { ru: 'Объект наблюдения', en: 'Observed object' },
  'gallery.openExample': { ru: '[D] ОТКРЫТЬ ПРИМЕР', en: '[D] OPEN EXAMPLE' },
  'gallery.operationConfirmedToast': { ru: 'ОПЕРАЦИЯ ПОДТВЕРЖДЕНА', en: 'OPERATION CONFIRMED' },
  'gallery.optionAlpha': { ru: 'АЛЬФА', en: 'ALPHA' },
  'gallery.optionBravo': { ru: 'БРАВО', en: 'BRAVO' },
  'gallery.popoverDescription': {
    ru: 'Всплывающая панель с управлением фокусом',
    en: 'A popover with focus management',
  },
  'gallery.popoverTitle': { ru: 'СОСТОЯНИЕ УЗЛА', en: 'NODE STATE' },
  'gallery.progressPanel': { ru: 'ПРОГРЕСС И ГРАФИКИ', en: 'PROGRESS AND CHARTS' },
  'gallery.scanCompleteToast': { ru: 'СКАНИРОВАНИЕ ЗАВЕРШЕНО', en: 'SCAN COMPLETE' },
  'gallery.screenTitle': {
    ru: 'UI КАТАЛОГ ТЕРМИНАЛЬНОГО КОНТУРА',
    en: 'UI CATALOG OF THE TERMINAL CONTOUR',
  },
  'gallery.sectorFieldDescription': {
    ru: 'Текстовое поле с общим Field-контрактом',
    en: 'A text field under the shared Field contract',
  },
  'gallery.secureChannelLabel': { ru: 'Защищённый канал', en: 'Secure channel' },
  'gallery.secureChannelSpan': { ru: 'ЗАЩИЩЁННЫЙ КАНАЛ', en: 'SECURE CHANNEL' },
  'gallery.standCommandsLabel': { ru: 'Команды стенда', en: 'Stand commands' },
  'gallery.statusTab': { ru: 'СТАТУС', en: 'STATUS' },
  'gallery.statusesPanel': { ru: 'СТАТУСЫ', en: 'STATUSES' },
  'gallery.syncProgressLabel': { ru: 'СИНХРОНИЗАЦИЯ', en: 'SYNCHRONISATION' },
  'gallery.toastReadyTitle': { ru: 'СИСТЕМА ГОТОВА', en: 'SYSTEM READY' },
  'gallery.tooltipDemo': {
    ru: 'Терминальная подсказка без скруглений',
    en: 'A terminal tooltip with no rounded corners',
  },
  'gallery.typographyPanel': { ru: 'ТИПОГРАФИКА', en: 'TYPOGRAPHY' },
} as const satisfies CatalogModule;
