import type { CatalogModule } from './catalogTypes';

/**
 * The group pairing dialog (R27): the control-plane address and its state,
 * the stepped path an unpaired device takes to join or start a group, group
 * administration, the device roster, presence and the links a paired session
 * holds to the group.
 *
 * `pairing.step.*` names the wizard `GroupPairingDialog.tsx` swaps between --
 * `choose`, then `join` or `create` -- rather than the fields those screens
 * hold, which live under `pairing.field.*` so a field shared by more than one
 * step (`deviceName`) is one id instead of two.
 */
export const pairingMessages = {
  'pairing.action.forgetAndRepair': {
    ru: '[U] ЗАБЫТЬ СЕССИЮ И СПАРИТЬСЯ ЗАНОВО',
    en: '[U] FORGET THE SESSION AND PAIR AGAIN',
  },
  'pairing.action.forgetPair': { ru: '[U] ЗАБЫТЬ ПАРУ', en: '[U] FORGET THE PAIRING' },
  'pairing.action.leaveGroup': { ru: '[L] ВЫЙТИ ИЗ ГРУППЫ', en: '[L] LEAVE THE GROUP' },
  'pairing.address.clear': { ru: '[O] ОЧИСТИТЬ', en: '[O] CLEAR' },
  'pairing.address.fieldAriaLabel': { ru: 'Адрес control plane', en: 'Control plane address' },
  'pairing.address.fieldDescription': {
    ru: 'Один адрес или до четырёх через запятую — сначала ближний по сети, затем облачный',
    en: 'One address, or up to four separated by commas — the nearest on the network first, then the cloud one',
  },
  'pairing.address.fieldLabel': { ru: 'АДРЕС CONTROL PLANE', en: 'CONTROL PLANE ADDRESS' },
  'pairing.address.localOnlyOff': { ru: 'ЛОКАЛЬНЫЙ РЕЖИМ: ВЫКЛ', en: 'LOCAL-ONLY MODE: OFF' },
  'pairing.address.localOnlyOn': { ru: 'ЛОКАЛЬНЫЙ РЕЖИМ: ВКЛ', en: 'LOCAL-ONLY MODE: ON' },
  'pairing.address.localOnlySwitchLabel': { ru: 'Локальный режим', en: 'Local-only mode' },
  'pairing.address.noteLocalOnly': {
    ru: 'РЕЖИМ ТОЛЬКО ЭТОЙ МАШИНЫ. УКАЖИТЕ АДРЕС CONTROL PLANE НИЖЕ И ВЫКЛЮЧИТЕ ЛОКАЛЬНЫЙ РЕЖИМ, ЧТОБЫ ВОЙТИ В ГРУППУ. ФАЙЛ /runtime/project.override.json И ПЕРЕМЕННАЯ NEXT_PUBLIC_HQ_CONTROL_PLANE_URL — ЗАПАСНЫЕ СПОСОБЫ ЗАДАТЬ АДРЕС, ЕСЛИ ЭТО ПОЛЕ ПУСТО.',
    en: 'THIS-MACHINE-ONLY MODE. ENTER THE CONTROL PLANE ADDRESS BELOW AND TURN OFF LOCAL-ONLY MODE TO JOIN A GROUP. THE /runtime/project.override.json FILE AND THE NEXT_PUBLIC_HQ_CONTROL_PLANE_URL VARIABLE ARE FALLBACK WAYS TO SET THE ADDRESS WHILE THIS FIELD IS EMPTY.',
  },
  'pairing.address.noteNotRunning': {
    ru: 'КЛИЕНТ СИНХРОНИЗАЦИИ НЕ ЗАПУЩЕН.',
    en: 'THE SYNC CLIENT IS NOT RUNNING.',
  },
  'pairing.address.save': { ru: '[S] СОХРАНИТЬ', en: '[S] SAVE' },
  'pairing.address.saved': { ru: 'АДРЕС СОХРАНЁН', en: 'ADDRESS SAVED' },
  'pairing.address.source': { ru: 'ИСТОЧНИК АДРЕСА: {source}', en: 'ADDRESS SOURCE: {source}' },
  'pairing.admin.codeExpiresAt': { ru: 'ДЕЙСТВУЕТ ДО {time}', en: 'VALID UNTIL {time}' },
  'pairing.admin.codeNoExpiry': { ru: 'СРОК НЕ УКАЗАН', en: 'NO DEADLINE GIVEN' },
  'pairing.admin.heading': { ru: 'УПРАВЛЕНИЕ ГРУППОЙ', en: 'GROUP ADMINISTRATION' },
  'pairing.admin.issueCode': { ru: '[C] ВЫПУСТИТЬ КОД ПАРЫ', en: '[C] ISSUE A PAIRING CODE' },
  'pairing.admin.nonAdminHint': {
    ru: 'ЭТИМИ КОМАНДАМИ РАСПОРЯЖАЕТСЯ АДМИНИСТРАТОР ГРУППЫ. ПОПРОСИТЕ ЕГО ПОВЫСИТЬ ЭТО УСТРОЙСТВО.',
    en: 'THE GROUP ADMINISTRATOR CONTROLS THESE COMMANDS. ASK THEM TO PROMOTE THIS DEVICE.',
  },
  'pairing.admin.pairingRoleFieldDescription': {
    ru: 'Код подключает одно устройство с этой ролью; администратора назначают повышением',
    en: 'The code connects one device with this role; an administrator is made by promoting one',
  },
  'pairing.admin.pairingRoleFieldLabel': {
    ru: 'РОЛЬ ДЛЯ НОВОГО УСТРОЙСТВА',
    en: 'ROLE FOR THE NEW DEVICE',
  },
  'pairing.admin.pairingRoleSelectLabel': {
    ru: 'Роль для нового устройства',
    en: 'Role for the new device',
  },
  'pairing.admin.renameFieldAriaLabel': { ru: 'Новое имя группы', en: 'New group name' },
  'pairing.admin.renameFieldDescription': {
    ru: 'Имя видят все устройства группы',
    en: 'Every device in the group sees this name',
  },
  'pairing.admin.renameFieldLabel': { ru: 'НОВОЕ ИМЯ ГРУППЫ', en: 'NEW GROUP NAME' },
  'pairing.admin.renameSubmit': { ru: '[R] ПЕРЕИМЕНОВАТЬ ГРУППУ', en: '[R] RENAME THE GROUP' },
  'pairing.capabilities.none': { ru: 'НЕТ', en: 'NONE' },
  'pairing.demotionLock.lastAdmin': {
    ru: 'В ГРУППЕ ДОЛЖЕН ОСТАТЬСЯ ХОТЯ БЫ ОДИН АДМИНИСТРАТОР',
    en: 'THE GROUP MUST KEEP AT LEAST ONE ADMINISTRATOR',
  },
  'pairing.demotionLock.transferLeader': {
    ru: 'ПЕРЕДАЙТЕ ГЛАВНУЮ СЕССИЮ ДРУГОМУ УСТРОЙСТВУ, ЧТОБЫ ПОНИЗИТЬ ЭТО',
    en: 'HAND THE LEADER SESSION TO ANOTHER DEVICE TO DEMOTE THIS ONE',
  },
  'pairing.devices.heading': { ru: 'УСТРОЙСТВА ГРУППЫ', en: 'GROUP DEVICES' },
  'pairing.devices.leaderBadge': { ru: 'ГЛАВНАЯ', en: 'LEADER' },
  'pairing.devices.makeLeader': { ru: '[G] ГЛАВНАЯ', en: '[G] LEADER' },
  'pairing.devices.revoke': { ru: '[X] ОТОЗВАТЬ', en: '[X] REVOKE' },
  'pairing.devices.roleLabel': { ru: 'Роль устройства {device}', en: 'Role of device {device}' },
  'pairing.dialog.description': {
    ru: 'Общая группа сессий: одна главная или все главные, с общими часами',
    en: 'A shared group of sessions: one leader or every session leading, with a shared clock',
  },
  'pairing.dialog.title': { ru: 'СИНХРОНИЗАЦИЯ ГРУППЫ', en: 'GROUP SYNCHRONISATION' },
  'pairing.field.code.ariaLabel': { ru: 'Код пары', en: 'Pairing code' },
  'pairing.field.code.description': {
    ru: 'Код выдаёт администратор группы',
    en: 'The administrator of the group issues the code',
  },
  'pairing.field.code.label': { ru: 'КОД ПАРЫ', en: 'PAIRING CODE' },
  'pairing.field.deviceName.ariaLabel': { ru: 'Имя устройства', en: 'Device name' },
  'pairing.field.deviceName.description': {
    ru: 'Как эта сессия видна остальным',
    en: 'How this session appears to everyone else',
  },
  'pairing.field.deviceName.label': { ru: 'ИМЯ УСТРОЙСТВА', en: 'DEVICE NAME' },
  'pairing.field.groupName.ariaLabel': { ru: 'Имя новой группы', en: 'New group name' },
  'pairing.field.groupName.description': {
    ru: 'Как группа названа для всех её устройств',
    en: 'What the group is called for every one of its devices',
  },
  'pairing.field.groupName.label': { ru: 'ИМЯ НОВОЙ ГРУППЫ', en: 'NEW GROUP NAME' },
  'pairing.field.groupName.placeholder': { ru: 'ШТАБ', en: 'HQ' },
  'pairing.field.secret.ariaLabel': { ru: 'Секрет развёртывания', en: 'Deployment secret' },
  'pairing.field.secret.description': {
    ru: 'Задан на control plane. Не сохраняется на этом устройстве и стирается при закрытии окна',
    en: 'Set on the control plane. Never saved on this device, and cleared when the dialog closes',
  },
  'pairing.field.secret.label': { ru: 'СЕКРЕТ РАЗВЁРТЫВАНИЯ', en: 'DEPLOYMENT SECRET' },
  'pairing.foreignInstallation.body': {
    ru: 'АДРЕС ОТВЕЧАЕТ, НО ЗА НИМ ДРУГАЯ БАЗА CONTROL PLANE — НЕ ТА, С КОТОРОЙ СПАРЕНО ЭТО УСТРОЙСТВО. СОХРАНЁННАЯ СЕССИЯ ОСТАВЛЕНА НЕТРОНУТОЙ, ГРУППА НЕ ЧИТАЕТСЯ, ЛОКАЛЬНЫЕ НАСТРОЙКИ НЕ ПЕРЕЗАПИСАНЫ. ЕСЛИ БАЗУ ДЕЙСТВИТЕЛЬНО ПЕРЕСОЗДАЛИ — ЗАБУДЬТЕ СЕССИЮ И ЗАПРОСИТЕ НОВЫЙ КОД ПАРЫ.',
    en: 'THE ADDRESS ANSWERS, BUT A DIFFERENT CONTROL PLANE DATABASE IS BEHIND IT — NOT THE ONE THIS DEVICE PAIRED WITH. THE STORED SESSION IS LEFT UNTOUCHED, THE GROUP DOES NOT READ, LOCAL SETTINGS ARE NOT OVERWRITTEN. IF THE DATABASE WAS GENUINELY RECREATED — FORGET THE SESSION AND REQUEST A NEW PAIRING CODE.',
  },
  'pairing.links.heading': { ru: 'СВЯЗИ С ГРУППОЙ', en: 'LINKS TO THE GROUP' },
  'pairing.links.otherDatabase': {
    ru: 'ДРУГАЯ БАЗА CONTROL PLANE — СВЯЗЬ НЕ ИСПОЛЬЗУЕТСЯ',
    en: 'A DIFFERENT CONTROL PLANE DATABASE — THE LINK IS NOT USED',
  },
  'pairing.links.primary': { ru: 'ОСНОВНАЯ', en: 'PRIMARY' },
  'pairing.links.secondary': { ru: 'ЗАПАСНАЯ', en: 'BACKUP' },
  'pairing.presence.clockOffset': { ru: 'СДВИГ ЧАСОВ {ms} MS', en: 'CLOCK OFFSET {ms} MS' },
  'pairing.presence.heading': { ru: 'ПРИСУТСТВИЕ', en: 'PRESENCE' },
  'pairing.step.back': { ru: '[←] НАЗАД', en: '[←] BACK' },
  'pairing.step.choose.createAction': {
    ru: '[N] СОЗДАТЬ НОВУЮ ГРУППУ',
    en: '[N] CREATE A NEW GROUP',
  },
  'pairing.step.choose.createHint': {
    ru: 'Один раз на постановку — остальные устройства подключаются по коду, который выпустит эта группа',
    en: 'Once per production — every other device joins with a code this group then issues',
  },
  'pairing.step.choose.heading': { ru: 'СПОСОБ ВХОДА', en: 'HOW TO JOIN' },
  'pairing.step.choose.joinAction': { ru: '[P] ВОЙТИ ПО КОДУ', en: '[P] JOIN WITH A CODE' },
  'pairing.step.choose.joinHint': {
    ru: 'Код выдаёт администратор уже существующей группы',
    en: 'The administrator of an existing group issues the code',
  },
  'pairing.step.create.heading': { ru: 'СОЗДАНИЕ ГРУППЫ', en: 'CREATE THE GROUP' },
  'pairing.step.create.submit': { ru: '[N] СОЗДАТЬ ГРУППУ', en: '[N] CREATE THE GROUP' },
  'pairing.step.join.heading': { ru: 'ВХОД В ГРУППУ', en: 'JOIN THE GROUP' },
  'pairing.step.join.submit': {
    ru: '[P] ПОДКЛЮЧИТЬСЯ К ГРУППЕ',
    en: '[P] CONNECT TO THE GROUP',
  },
  'pairing.summary.authority': { ru: 'АВТОРИТЕТ', en: 'AUTHORITY' },
  'pairing.summary.capabilities': { ru: 'ВОЗМОЖНОСТИ', en: 'CAPABILITIES' },
  'pairing.summary.clock': { ru: 'ЧАСЫ', en: 'CLOCK' },
  'pairing.summary.clockNotMeasured': { ru: 'НЕ ИЗМЕРЕНЫ', en: 'NOT MEASURED' },
  'pairing.summary.clockReading': {
    ru: 'СДВИГ {offset} MS / ЗАДЕРЖКА {latency} MS',
    en: 'OFFSET {offset} MS / LATENCY {latency} MS',
  },
  'pairing.summary.database': { ru: 'БАЗА', en: 'DATABASE' },
  'pairing.summary.device': { ru: 'УСТРОЙСТВО', en: 'DEVICE' },
  'pairing.summary.group': { ru: 'ГРУППА', en: 'GROUP' },
  'pairing.summary.leader': { ru: 'ГЛАВНАЯ СЕССИЯ', en: 'LEADER SESSION' },
  'pairing.summary.state': { ru: 'СОСТОЯНИЕ', en: 'STATE' },
} as const satisfies CatalogModule;
