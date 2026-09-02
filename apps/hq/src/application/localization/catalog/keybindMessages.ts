import type { CatalogModule } from './catalogTypes';

/**
 * Keybind descriptions and their category headings.
 *
 * `keybind.navigate` is the one entry with a parameter: the nine numbered
 * routes take their target from the rail's own label rather than writing it
 * a second time.
 */
export const keybindMessages = {
  'keybind.developer.toggle': { ru: 'Панель разработчика', en: 'Developer panel' },
  'keybind.edit.dockPanel': {
    ru: 'Пристыковать панель редактирования к следующему краю',
    en: 'Dock the edit panel to the next edge',
  },
  'keybind.edit.toggle': { ru: 'Режим редактирования', en: 'Edit mode' },
  'keybind.files.import': { ru: 'Импорт материалов', en: 'Material import' },
  'keybind.keybinds.list': { ru: 'Список сочетаний клавиш', en: 'Keyboard shortcut list' },
  'keybind.navigate': { ru: 'Перейти: {target}', en: 'Go to: {target}' },
  'keybind.scene.commandPalette': { ru: 'Палитра команд сцены', en: 'Scene command palette' },
  'keybind.scene.nextCue': { ru: 'Следующая реплика сцены', en: 'Next scene cue' },
  'keybind.scene.previousCue': { ru: 'Предыдущая реплика сцены', en: 'Previous scene cue' },
  'keybind.scene.resetScene': { ru: 'Сбросить сцену', en: 'Reset the scene' },
  'keybind.scene.sectionFiles': { ru: 'Раздел: файлы', en: 'Section: files' },
  'keybind.scene.sectionMap': { ru: 'Раздел: карта', en: 'Section: map' },
  'keybind.shell.dismiss': { ru: 'Закрыть панель или ящик', en: 'Close the panel or drawer' },
  'keybind.shell.fullscreen': { ru: 'Полный экран', en: 'Full screen' },
  'keybind.shell.productionPanel': { ru: 'Панель режиссёра', en: 'Director panel' },
  'keybind.shell.search': { ru: 'Глобальный поиск', en: 'Global search' },
  'keybind.shell.togglePlayback': {
    ru: 'Пуск и пауза видео (на видеоэкранах)',
    en: 'Play and pause video (on video screens)',
  },
  'keybindCategory.developer': { ru: 'РАЗРАБОТКА', en: 'DEVELOPMENT' },
  'keybindCategory.editing': { ru: 'РЕДАКТИРОВАНИЕ', en: 'EDITING' },
  'keybindCategory.navigation': { ru: 'НАВИГАЦИЯ', en: 'NAVIGATION' },
  'keybindCategory.operation': { ru: 'ОПЕРАЦИЯ', en: 'OPERATION' },
} as const satisfies CatalogModule;
