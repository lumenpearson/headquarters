import type { CatalogModule } from './catalogTypes';

/**
 * The in-app updater and the autostart switch beside it.
 */
export const updateMessages = {
  'update.availableVersion': { ru: 'ДОСТУПНА ВЕРСИЯ', en: 'VERSION AVAILABLE' },
  'update.cancel': { ru: '[C] ОТМЕНИТЬ', en: '[C] CANCEL' },
  'update.check': { ru: '[U] ПРОВЕРИТЬ ОБНОВЛЕНИЕ', en: '[U] CHECK FOR UPDATE' },
  'update.currentVersion': { ru: 'ТЕКУЩАЯ ВЕРСИЯ', en: 'CURRENT VERSION' },
  'update.download': { ru: '[D] СКАЧАТЬ', en: '[D] DOWNLOAD' },
  'update.heading': { ru: 'ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ', en: 'APPLICATION UPDATE' },
  'update.install': { ru: '[I] УСТАНОВИТЬ И ПЕРЕЗАПУСТИТЬ', en: '[I] INSTALL AND RESTART' },
  'update.notes': { ru: 'ЧТО ИЗМЕНИЛОСЬ', en: 'WHAT CHANGED' },
  'update.pause': { ru: '[P] ПАУЗА', en: '[P] PAUSE' },
  'update.progress': { ru: 'СКАЧАНО {percent}%', en: '{percent}% DOWNLOADED' },
  'update.progressUnknown': {
    ru: 'СКАЧИВАНИЕ, РАЗМЕР НЕИЗВЕСТЕН',
    en: 'DOWNLOADING, SIZE UNKNOWN',
  },
  'update.resume': { ru: '[R] ПРОДОЛЖИТЬ', en: '[R] RESUME' },
  'update.state.available': { ru: 'ОБНОВЛЕНИЕ ДОСТУПНО', en: 'UPDATE AVAILABLE' },
  'update.state.checking': { ru: 'ПРОВЕРКА…', en: 'CHECKING…' },
  'update.state.error': { ru: 'ОШИБКА: {message}', en: 'ERROR: {message}' },
  'update.state.idle': { ru: 'ПРОВЕРКА НЕ ВЫПОЛНЯЛАСЬ', en: 'NOT CHECKED YET' },
  'update.state.installing': { ru: 'УСТАНОВКА…', en: 'INSTALLING…' },
  'update.state.paused': { ru: 'СКАЧИВАНИЕ ПРИОСТАНОВЛЕНО', en: 'DOWNLOAD PAUSED' },
  'update.state.ready': { ru: 'ГОТОВО К УСТАНОВКЕ', en: 'READY TO INSTALL' },
  'update.state.upToDate': { ru: 'УСТАНОВЛЕНА ПОСЛЕДНЯЯ ВЕРСИЯ', en: 'RUNNING THE LATEST VERSION' },
  'update.unavailable': {
    ru: 'ОБНОВЛЕНИЕ ИЗНУТРИ ДОСТУПНО ТОЛЬКО В ДЕСКТОПНОЙ СБОРКЕ',
    en: 'IN-APP UPDATES ARE A DESKTOP-BUILD FEATURE',
  },
} as const satisfies CatalogModule;
