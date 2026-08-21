import type {
  Alert,
  AnalyticalInsight,
  Attachment,
  Camera,
  CaseFile,
  CommunicationChannel,
  GeoPoint,
  OperationalObject,
  OperationsWorldData,
  OpsEvent,
  OpsReport,
  OpsStatus,
  OpsTask,
  Person,
  Sector,
  Sensor,
  SystemNode,
  TacticalRoute,
} from '@gremuchaya/domain';

const baseTimestamp = Date.parse('2026-09-12T07:42:15+03:00');

const personNames = [
  'Алексей Мельников',
  'Ирина Волкова',
  'Виктор Савельев',
  'Марина Лебедева',
  'Антон Жуков',
  'Елена Орлова',
  'Сергей Корнеев',
  'Дарья Белова',
  'Максим Рудин',
  'Ольга Данилова',
  'Николай Горин',
  'Татьяна Крылова',
  'Роман Седов',
  'Людмила Ракова',
  'Павел Титов',
  'Светлана Воронцова',
  'Илья Костин',
  'Наталья Фомина',
  'Денис Яров',
  'Ксения Ларина',
] as const;

const sectorNames = [
  'СЕВЕРНЫЙ КОНТУР',
  'ПРОМЫШЛЕННАЯ ЗОНА',
  'ТРАНСПОРТНЫЙ УЗЕЛ',
  'ЦЕНТРАЛЬНЫЙ СЕКТОР',
  'ЮЖНЫЙ КОРИДОР',
  'РЕЗЕРВНЫЙ ПЕРИМЕТР',
  'ВОСТОЧНЫЙ РУБЕЖ',
  'ЗАПАДНЫЙ РУБЕЖ',
] as const;

const statuses = [
  'ACTIVE',
  'READY',
  'WATCHED',
  'IN_PROGRESS',
  'NORMAL',
  'WAITING',
  'SECURED',
  'RESERVE',
] as const satisfies readonly OpsStatus[];

function valueAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index % values.length];
  if (value === undefined) throw new Error('Seed collection is empty');
  return value;
}

function id(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(2, '0')}`;
}

function timestamp(minutesAgo: number): string {
  return new Date(baseTimestamp - minutesAgo * 60_000).toISOString();
}

function point(index: number, offset = 0): GeoPoint {
  const x = 8 + ((index * 17 + offset * 11) % 84);
  const y = 10 + ((index * 23 + offset * 7) % 78);
  return {
    lat: Number((55.69 + y * 0.0011).toFixed(6)),
    lng: Number((37.49 + x * 0.0016).toFixed(6)),
    x,
    y,
  };
}

const sectors: readonly Sector[] = sectorNames.map((name, index) => ({
  id: id('SEC', index),
  name,
  code: `S-${String(index + 1).padStart(2, '0')}`,
  threat: index === 2 ? 78 : 22 + ((index * 13) % 45),
  readiness: 94 - ((index * 7) % 31),
  center: point(index, 2),
  status: index === 2 ? 'ALERT' : valueAt(statuses, index),
}));

const people: readonly Person[] = personNames.map((fullName, index) => ({
  id: id('P', index),
  objectId: id('K', index),
  fullName,
  aliases: [`${valueAt(['СЕВЕР', 'КЕДР', 'РУБЕЖ', 'ГРАНИТ'], index)}-${index + 1}`],
  birthDate: `${1974 + (index % 20)}-${String((index % 12) + 1).padStart(2, '0')}-${String(((index * 3) % 27) + 1).padStart(2, '0')}`,
  citizenship: 'РФ',
  role: valueAt(['ОБЪЕКТ НАБЛЮДЕНИЯ', 'СВЯЗНОЙ', 'ОПЕРАТОР', 'КООРДИНАТОР'], index),
  status: index === 16 ? 'WATCHED' : valueAt(statuses, index),
  riskScore: index === 16 ? 87 : 28 + ((index * 9) % 59),
  documentCode: `ДОК-${String(4100 + index * 17)}`,
  addresses: [
    `СЕКТОР ${valueAt(sectors, index).code} / ТОЧКА ${String(index + 12).padStart(3, '0')}`,
    `РЕЗЕРВНЫЙ АДРЕС / ЯЧЕЙКА ${String(index + 1).padStart(2, '0')}`,
  ],
  tags: [valueAt(['КОНТРОЛЬ', 'СВЯЗЬ', 'ЛОГИСТИКА', 'ФИНАНСЫ'], index), 'ГРЕМУЧАЯ СМЕСЬ'],
}));

const objects: readonly OperationalObject[] = Array.from({ length: 32 }, (_, index) => {
  const objectId = id('K', index);
  const isPrimary = objectId === 'K-17';
  const kind = valueAt(
    ['person', 'vehicle', 'person', 'device', 'group', 'organization', 'point', 'address'] as const,
    index,
  );
  return {
    id: objectId,
    name: index < personNames.length ? valueAt(personNames, index) : `ОБЪЕКТ ${objectId}`,
    callsign: isPrimary
      ? 'ВЕКТОР-17'
      : `${valueAt(['РУБИН', 'КЕДР', 'ФАКЕЛ', 'БАРС'], index)}-${index + 1}`,
    kind,
    status: isPrimary ? 'SIGNAL_LOST' : valueAt(statuses, index),
    sectorId: valueAt(sectors, index).id,
    position: point(index, 4),
    speed: kind === 'vehicle' ? 34 + ((index * 7) % 56) : 2 + (index % 8),
    altitude: kind === 'device' ? 42 + index * 3 : 0,
    threat: isPrimary ? 91 : 18 + ((index * 11) % 72),
    signal: isPrimary ? 12 : 58 + ((index * 9) % 41),
    channelId: id('CH', index % 10),
    source: valueAt(['СПУТНИК', 'ОПТИКА', 'РАДИОКАНАЛ', 'ОПЕРАТОР', 'ДАТЧИК'], index),
    lastSeenAt: timestamp(index * 3),
    linkedCaseIds: [id('CASE', index % 30), id('CASE', (index + 7) % 30)],
    linkedFileIds: [id('FILE', index % 24), id('FILE', (index + 5) % 24)],
  };
});

const cameras: readonly Camera[] = Array.from({ length: 16 }, (_, index) => {
  const cameraId = index === 0 ? 'K-17' : id('CAM', index);
  const primary = cameraId === 'K-17';
  return {
    id: cameraId,
    objectId: primary ? 'K-17' : id('K', (index + 8) % 32),
    location: primary
      ? 'ТРАНСПОРТНЫЙ УЗЕЛ / ПЛАТФОРМА 3'
      : `${valueAt(sectorNames, index)} / ПОСТ ${index + 1}`,
    sectorId: primary ? 'SEC-03' : valueAt(sectors, index).id,
    position: primary ? point(16, 4) : point(index, 6),
    status: index === 13 ? 'SIGNAL_LOST' : index === 6 ? 'ALERT' : 'ACTIVE',
    signal: primary ? 92 : index === 13 ? 11 : 62 + ((index * 11) % 37),
    resolution: index % 3 === 0 ? '3840×2160' : '1920×1080',
    fps: index % 2 === 0 ? 25 : 30,
    bitrate: `${4 + (index % 5)}.${index % 10} Mbit/s`,
    codec: index % 3 === 0 ? 'H.265' : 'H.264',
    recording: true,
    ptz: index % 3 !== 1,
    uptime: `${18 + index * 3}ч ${String(index * 7).padStart(2, '0')}м`,
  };
});

const attachments: readonly Attachment[] = Array.from({ length: 24 }, (_, index) => ({
  id: id('FILE', index),
  title: `${valueAt(['ФОТОФИКСАЦИЯ', 'ПЕРЕХВАТ', 'ОТЧЁТ', 'КАРТА', 'ВИДЕО', 'ПРОТОКОЛ', 'ТЕЛЕМЕТРИЯ'], index)} ${String(index + 1).padStart(3, '0')}`,
  kind: valueAt(['image', 'audio', 'document', 'map', 'video', 'report', 'data'] as const, index),
  status: index % 7 === 0 ? 'RESTRICTED' : 'ARCHIVED',
  createdAt: timestamp(index * 47),
  source: valueAt(['CAM/K-17', 'RADIO/CH-03', 'OPS/CENTER', 'SAT/LOCAL'], index),
  classification: valueAt(['БЕТА', 'АЛЬФА', 'А1'] as const, index),
  tags: [valueAt(['ВИДЕО', 'АУДИО', 'ДОКУМЕНТ', 'СЕКТОР', 'ОБЪЕКТ'], index), id('K', index % 32)],
  linkedCaseIds: [id('CASE', index % 30)],
  linkedObjectIds: [id('K', index % 32)],
  sizeLabel: `${2 + ((index * 13) % 740)}.${index % 10} MB`,
  preview: valueAt(
    [
      'ЛОКАЛЬНАЯ ФОТОГРАММЕТРИЯ / КАДР ПОДТВЕРЖДЁН',
      'ЗАЩИЩЁННЫЙ АУДИОКАНАЛ / ТРАНСКРИПТ ДОСТУПЕН',
      'СЛУЖЕБНЫЙ ДОКУМЕНТ / КОНТРОЛЬНАЯ СУММА ПРОВЕРЕНА',
      'ТАКТИЧЕСКИЙ СЛОЙ / КООРДИНАТЫ СИНХРОНИЗИРОВАНЫ',
    ],
    index,
  ),
}));

const cases: readonly CaseFile[] = Array.from({ length: 30 }, (_, index) => ({
  id: id('CASE', index),
  code: `Д-${String(2026001 + index)}`,
  title: `${valueAt(['НАБЛЮДЕНИЕ', 'КАНАЛ СВЯЗИ', 'МАРШРУТ', 'ФИНАНСОВЫЙ КОНТУР', 'ТЕХНИЧЕСКИЙ УЗЕЛ'], index)} / ${id('K', index % 32)}`,
  status: index % 9 === 0 ? 'RESTRICTED' : valueAt(statuses, index),
  createdAt: timestamp(index * 180),
  source: valueAt(['ОПЕРАТИВНАЯ ГРУППА', 'ВИДЕОКОНТУР', 'АНАЛИТИЧЕСКИЙ ОТДЕЛ'], index),
  dossierCode: `DOS-${String(5100 + index)}`,
  subjectPersonId: id('P', index % 20),
  linkedObjectIds: [id('K', index % 32), id('K', (index + 4) % 32)],
  attachmentIds: [id('FILE', index % 24), id('FILE', (index + 3) % 24)],
  tags: [valueAt(['ПРИОРИТЕТ', 'КОНТРОЛЬ', 'АРХИВ', 'МАРШРУТ'], index), 'ГС'],
  priority: 1 + (index % 5),
}));

const events: readonly OpsEvent[] = Array.from({ length: 120 }, (_, index) => {
  const eventTypes = [
    'object.updated',
    'object.enteredSector',
    'camera.motion',
    'communication.intercepted',
    'case.updated',
    'file.added',
    'task.completed',
    'system.warning',
  ] as const;
  const objectId = index === 0 ? 'K-17' : id('K', index % 32);
  const critical = index === 0 || index % 29 === 0;
  return {
    id: `EV-${String(1001 + index)}`,
    type: index === 0 ? 'camera.signalLost' : valueAt(eventTypes, index),
    timestamp: timestamp(index * 6),
    severity: critical ? 'critical' : index % 7 === 0 ? 'warning' : 'normal',
    source: valueAt(['MAP', 'VIDEO', 'COMMS', 'SYSTEM', 'OPERATOR'], index),
    title:
      index === 0
        ? 'K-17: ПОТЕРЯ СИГНАЛА'
        : `${objectId}: ${valueAt(['ОБНОВЛЕНА ПОЗИЦИЯ', 'ВХОД В СЕКТОР', 'НОВАЯ ФИКСАЦИЯ', 'СОБЫТИЕ ПОДТВЕРЖДЕНО'], index)}`,
    description:
      index === 0
        ? 'Телеметрия объекта и ближайшей камеры недоступна. Активирован резервный канал.'
        : `Синтетическое событие оперативного мира. Источник ${valueAt(['SAT', 'OPT', 'RF', 'OPS'], index)}.`,
    linkedObjectIds: [objectId],
    linkedCaseIds: [id('CASE', index % 30)],
    linkedCameraId: index % 3 === 0 ? valueAt(cameras, index).id : null,
    coordinates: point(index, 7),
    status: critical ? 'ALERT' : 'ACTIVE',
  };
});

const alerts: readonly Alert[] = Array.from({ length: 10 }, (_, index) => ({
  id: `AL-${101 + index}`,
  level: index === 0 ? 'critical' : index < 4 ? 'warning' : 'info',
  source: valueAt(['VIDEO', 'MAP', 'COMMS', 'SYSTEM'], index),
  timestamp: timestamp(index * 14),
  title:
    index === 0
      ? 'ПОТЕРЯ СИГНАЛА K-17'
      : valueAt(
          [
            'ВТОРЖЕНИЕ В ЗОНУ',
            'ОТКЛОНЕНИЕ ОТ МАРШРУТА',
            'НЕИЗВЕСТНЫЙ ОБЪЕКТ',
            'ЗАДЕРЖКА СИНХРОНИЗАЦИИ',
          ],
          index,
        ),
  description: `Тревога ${String(index + 1).padStart(2, '0')} требует проверки оператором.`,
  linkedEntityId: index === 0 ? 'K-17' : id('K', index),
  lifecycle: index < 4 ? 'NEW' : index < 7 ? 'ACKNOWLEDGED' : 'RESOLVED',
  sectorId: valueAt(sectors, index).id,
  coordinates: point(index, 8),
}));

const tasks: readonly OpsTask[] = Array.from({ length: 18 }, (_, index) => ({
  id: `TASK-${String(index + 1).padStart(3, '0')}`,
  title: valueAt(
    [
      'ПРОВЕРИТЬ РЕЗЕРВНЫЙ КАНАЛ',
      'СОПОСТАВИТЬ МАРШРУТЫ',
      'ПОДТВЕРДИТЬ ФОТОФИКСАЦИЮ',
      'ОБНОВИТЬ КАРТОЧКУ ДЕЛА',
      'ПРОВЕСТИ АНАЛИЗ ТРАФИКА',
    ],
    index,
  ),
  direction: valueAt(
    ['intelligence', 'collection', 'analysis', 'operations', 'support'] as const,
    index,
  ),
  status: valueAt(['completed', 'active', 'waiting', 'blocked'] as const, index),
  progress: index % 4 === 0 ? 100 : 18 + ((index * 17) % 75),
  linkedObjectIds: [id('K', index % 32)],
  linkedCaseIds: [id('CASE', index % 30)],
}));

const tacticalRoutes: readonly TacticalRoute[] = Array.from({ length: 8 }, (_, index) => ({
  id: id('RT', index),
  name: valueAt(['ОСНОВНОЙ', 'АЛЬТЕРНАТИВНЫЙ', 'РЕЗЕРВНЫЙ', 'ЭВАКУАЦИОННЫЙ'], index),
  kind: valueAt(['primary', 'alternative', 'reserve', 'evacuation'] as const, index),
  status: index === 1 ? 'ALERT' : valueAt(statuses, index),
  lengthKm: Number((8.4 + index * 3.75).toFixed(1)),
  etaMinutes: 12 + index * 7,
  risk: 18 + ((index * 13) % 73),
  progress: 11 + ((index * 19) % 82),
  points: [point(index, 1), point(index + 2, 2), point(index + 5, 3), point(index + 8, 4)],
}));

const channels: readonly CommunicationChannel[] = Array.from({ length: 10 }, (_, index) => ({
  id: id('CH', index),
  name: `${valueAt(['АЛЬФА', 'БЕТА', 'ГАММА', 'РЕЗЕРВ'], index)} / ${String(index + 1).padStart(2, '0')}`,
  kind: valueAt(['voice', 'data', 'intercept', 'reserve'] as const, index),
  status: index === 2 ? 'SIGNAL_LOST' : 'SECURED',
  encryption: valueAt(['ГОСТ-КУЗНЕЧИК', 'AES-256/GCM', 'КОНТУР-R4'], index),
  load: 18 + ((index * 17) % 79),
  packetLoss: index === 2 ? 18.4 : Number(((index * 0.37) % 3.2).toFixed(1)),
  latency: 12 + index * 9,
  signal: index === 2 ? 23 : 61 + ((index * 7) % 38),
  operator: `ОП-${String(index + 1).padStart(2, '0')}`,
  transcript: [
    `[07:${42 + index}:12] Канал установлен.`,
    `[07:${42 + index}:28] Контрольная точка подтверждена.`,
    `[07:${42 + index}:44] Ожидаю дальнейшие указания.`,
  ],
}));

const sensors: readonly Sensor[] = Array.from({ length: 12 }, (_, index) => ({
  id: id('SNS', index),
  name: `${valueAt(['РАДАР', 'ОПТИКА', 'ИК', 'АКУСТИКА', 'DATA LINK'], index)}-${index + 1}`,
  kind: valueAt(['radar', 'optical', 'infrared', 'acoustic', 'data-link'] as const, index),
  status: index === 5 ? 'ALERT' : 'ACTIVE',
  signal: 54 + ((index * 13) % 45),
  sectorId: valueAt(sectors, index).id,
}));

const systemNodes: readonly SystemNode[] = Array.from({ length: 10 }, (_, index) => ({
  id: id('NODE', index),
  name: `${valueAt(['CORE', 'DB', 'STORAGE', 'MONITOR', 'RESERVE'], index)}-${String(index + 1).padStart(2, '0')}`,
  kind: valueAt(['server', 'database', 'storage', 'monitoring', 'reserve'] as const, index),
  status: index === 7 ? 'ALERT' : 'NORMAL',
  load: 24 + ((index * 11) % 69),
  temperature: 36 + ((index * 3) % 28),
  ip: `10.42.${index + 1}.${20 + index}`,
}));

const insights: readonly AnalyticalInsight[] = Array.from({ length: 8 }, (_, index) => ({
  id: id('INS', index),
  priority: index < 2 ? 'critical' : index < 5 ? 'warning' : 'normal',
  title: valueAt(
    [
      'КОРРЕЛЯЦИЯ ПОТЕРЬ СИГНАЛА',
      'ИЗМЕНЕНИЕ МАРШРУТА K-17',
      'РОСТ АКТИВНОСТИ В СЕКТОРЕ S-03',
      'СВЯЗАННЫЙ КЛАСТЕР СОБЫТИЙ',
    ],
    index,
  ),
  explanation:
    'Вывод рассчитан локальным аналитическим контуром на связанных синтетических событиях.',
  timestamp: timestamp(index * 38),
  linkedObjectIds: [index === 0 ? 'K-17' : id('K', index)],
  completed: index > 5,
}));

const reports: readonly OpsReport[] = [
  'operation',
  'object',
  'sector',
  'incident',
  'communications',
  'video',
  'system',
  'analytics',
].map((kind, index) => ({
  id: id('REP', index),
  title: `${valueAt(['ОПЕРАТИВНАЯ СВОДКА', 'ОБЪЕКТ', 'СЕКТОР', 'ИНЦИДЕНТ', 'СВЯЗЬ', 'КАМЕРЫ', 'СИСТЕМА', 'АНАЛИТИКА'], index)} / ГС`,
  kind: kind as OpsReport['kind'],
  createdAt: timestamp(index * 240),
  status: index < 3 ? 'READY' : 'WAITING',
}));

export const operationsSeed: OperationsWorldData = {
  operation: {
    id: 'OP-GS-042',
    code: 'ГС/042-26',
    title: 'ГРЕМУЧАЯ СМЕСЬ',
    summary:
      'Контроль связанной инфраструктуры, маршрутов и каналов группы объектов в секторах транспортного узла. Все источники локальные и синтетические.',
    status: 'IN_PROGRESS',
    progress: 68,
    priority: 'ОСОБЫЙ КОНТРОЛЬ',
    threatLevel: 'HIGH',
    startedAt: '2026-09-09T05:40:00+03:00',
    expectedEndAt: '2026-09-19T23:30:00+03:00',
    currentPhase: 4,
  },
  sectors,
  objects,
  people,
  cameras,
  cases,
  attachments,
  events,
  alerts,
  tasks,
  routes: tacticalRoutes,
  channels,
  sensors,
  systemNodes,
  insights,
  reports,
};

export const objectStaticIds = objects.map((object) => object.id);
export const caseStaticIds = cases.map((caseFile) => caseFile.id);
