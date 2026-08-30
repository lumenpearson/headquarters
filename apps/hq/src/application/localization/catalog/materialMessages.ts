import type { CatalogModule } from './catalogTypes';

/**
 * Materials, their transport and lifecycle, the record drawer and the
 * production panel -- the surfaces built around a file rather than around a
 * screen.
 */
export const materialMessages = {
  'drawer.attachToCase': { ru: '[+] ПРИКРЕПИТЬ К ДЕЛУ', en: '[+] ATTACH TO CASE' },
  'drawer.completeTask': { ru: '[X] ОТМЕТИТЬ ВЫПОЛНЕННЫМ', en: '[X] MARK COMPLETE' },
  'drawer.confirmAlert': { ru: '[A] ПОДТВЕРДИТЬ ТРЕВОГУ', en: '[A] ACKNOWLEDGE ALERT' },
  'drawer.linkedObjects': { ru: 'Связанные объекты: {list}', en: 'Linked objects: {list}' },
  'drawer.progression': { ru: 'ПРОХОЖДЕНИЕ', en: 'PROGRESSION' },
  'drawer.signalLevel': { ru: 'УРОВЕНЬ СИГНАЛА', en: 'SIGNAL LEVEL' },
  'field.cases': { ru: 'ДЕЛА', en: 'CASES' },
  'field.clearance': { ru: 'ДОПУСК', en: 'CLEARANCE' },
  'field.codec': { ru: 'КОДЕК', en: 'CODEC' },
  'field.coordinates': { ru: 'КООРДИНАТЫ', en: 'COORDINATES' },
  'field.encryption': { ru: 'ШИФРОВАНИЕ', en: 'ENCRYPTION' },
  'field.latency': { ru: 'ЗАДЕРЖКА', en: 'LATENCY' },
  'field.length': { ru: 'ДЛИНА', en: 'LENGTH' },
  'field.name': { ru: 'НАЗВАНИЕ', en: 'NAME' },
  'field.object': { ru: 'ОБЪЕКТ', en: 'OBJECT' },
  'field.objects': { ru: 'ОБЪЕКТЫ', en: 'OBJECTS' },
  'field.risk': { ru: 'РИСК', en: 'RISK' },
  'field.sector': { ru: 'СЕКТОР', en: 'SECTOR' },
  'field.signal': { ru: 'СИГНАЛ', en: 'SIGNAL' },
  'field.size': { ru: 'РАЗМЕР', en: 'SIZE' },
  'field.source': { ru: 'ИСТОЧНИК', en: 'SOURCE' },
  'field.status': { ru: 'СТАТУС', en: 'STATUS' },
  'field.stream': { ru: 'ПОТОК', en: 'STREAM' },
  'field.tags': { ru: 'ТЕГИ', en: 'TAGS' },
  'field.time': { ru: 'ВРЕМЯ', en: 'TIME' },
  'production.clockSpeedLabel': { ru: 'Скорость часов', en: 'Clock speed' },
  'production.fixedTimeLabel': {
    ru: 'Фиксированное время production',
    en: 'Production fixed time',
  },
  'production.heading': { ru: 'УПРАВЛЕНИЕ СЪЁМОЧНЫМ СОСТОЯНИЕМ', en: 'PRODUCTION STATE CONTROL' },
  'production.panelLabel': { ru: 'Панель съёмочного режима', en: 'Production panel' },
  'production.presetLabel': { ru: 'Сценарный preset', en: 'Scene preset' },
  'production.saveSnapshot': { ru: '[S] СОХРАНИТЬ СОСТОЯНИЕ СЦЕНЫ', en: '[S] SAVE SCENE STATE' },
  'transport.authorityLabel': { ru: 'АВТОРИТЕТ', en: 'AUTHORITY' },
  'transport.busBroadcastDetail': {
    ru: 'BroadcastChannel — вкладки одного браузера',
    en: 'BroadcastChannel — tabs of one browser',
  },
  'transport.busFallbackDetail': {
    ru: 'storage-события — BroadcastChannel недоступен',
    en: 'storage events — BroadcastChannel unavailable',
  },
  'transport.busLabel': { ru: 'ШИНА ЭКРАНОВ', en: 'SCREEN BUS' },
  'transport.clockOffset': {
    ru: 'Сдвиг {offset} мс, задержка {latency} мс',
    en: '{offset} ms offset, {latency} ms latency',
  },
  'transport.description': {
    ru: 'Чем этот экран синхронизируется с остальными',
    en: 'What this screen synchronises with the rest',
  },
  'transport.detailsLabel': { ru: 'Подробности транспорта', en: 'Transport details' },
  'transport.eventChannelLabel': { ru: 'КАНАЛ СОБЫТИЙ', en: 'EVENT CHANNEL' },
  'transport.eventMarker': { ru: ' — событие {sequence}', en: ' — event {sequence}' },
  'transport.groupClockLabel': { ru: 'ЧАСЫ ГРУППЫ', en: 'GROUP CLOCK' },
  'transport.groupSyncLabel': { ru: 'ГРУППОВАЯ СИНХРОНИЗАЦИЯ', en: 'GROUP SYNCHRONISATION' },
  'transport.linkPrimary': { ru: 'СВЯЗЬ · ОСНОВНАЯ', en: 'LINK · PRIMARY' },
  'transport.linkSecondary': { ru: 'СВЯЗЬ · ЗАПАСНАЯ', en: 'LINK · SECONDARY' },
  'transport.localMirrorLabel': { ru: 'ЛОКАЛЬНАЯ КОПИЯ', en: 'LOCAL MIRROR' },
  'transport.mirrorNotPresent': {
    ru: 'Нет — значения берутся из сборки',
    en: 'None — values come from the build',
  },
  'transport.mirrorUpdated': {
    ru: 'Обновлена {at}, ревизия {revision}',
    en: 'Updated {at}, revision {revision}',
  },
  'transport.noGroupAssigned': { ru: 'Группа не назначена', en: 'No group assigned' },
  'transport.notMeasured': { ru: 'Не измерены', en: 'Not measured' },
  'transport.otherPlaneUnused': {
    ru: 'ДРУГАЯ БАЗА CONTROL PLANE — НЕ ИСПОЛЬЗУЕТСЯ',
    en: 'ANOTHER CONTROL PLANE BASE — NOT USED',
  },
  'transport.resyncMarker': { ru: ', пересинхронизаций {count}', en: ', {count} resyncs' },
  'transport.rpcDetail': {
    ru: 'ConnectRPC поверх бинарного gRPC-Web',
    en: 'ConnectRPC over binary gRPC-Web',
  },
  'transport.screenLabel': { ru: 'ЭКРАН', en: 'SCREEN' },
  'unit.km': { ru: 'КМ', en: 'KM' },
  'unit.min': { ru: 'МИН', en: 'MIN' },
} as const satisfies CatalogModule;
