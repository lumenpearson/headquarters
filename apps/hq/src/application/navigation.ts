/**
 * The primary navigation, in the order it is drawn and numbered.
 *
 * Lived inside `OperationsShell` until the keybind registry needed the same
 * list: the numbered badge beside each entry is a promise that the matching
 * digit key goes there, and two copies of the list is how that promise gets
 * broken quietly.
 *
 * Tuple of: route id, href, the badge drawn in the rail, the label.
 */
export const primaryNavigation = [
  ['overview', '/overview', '01', 'ОБЗОР'],
  ['objects', '/objects', '02', 'ОБЪЕКТЫ'],
  ['cases', '/cases', '03', 'ДЕЛА'],
  ['map', '/map', '04', 'КАРТА'],
  ['video', '/video', '05', 'ВИДЕО'],
  ['communications', '/communications', '06', 'СВЯЗЬ'],
  ['files', '/files', '07', 'ФАЙЛЫ'],
  ['archive', '/archive', '08', 'АРХИВ'],
  ['analytics', '/analytics', '09', 'АНАЛИТИКА'],
  ['reports', '/reports', '10', 'ОТЧЁТЫ'],
  ['search', '/search', '11', 'ПОИСК'],
  ['settings', '/settings', '12', 'НАСТРОЙКИ'],
  ['system', '/system', 'SY', 'СИСТЕМА'],
] as const;

export type PrimaryNavigationEntry = (typeof primaryNavigation)[number];
