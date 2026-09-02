import type { CatalogModule } from './catalogTypes';

/**
 * Edit mode: the panel, its tile controls and the translation proposal flow.
 */
export const editMessages = {
  'edit.tileMotion.category': {
    ru: 'Движение группы {category}',
    en: 'Motion of group {category}',
  },
  'edit.tileMotion.heading': { ru: 'ДВИЖЕНИЕ ПЛИТОК', en: 'TILE MOTION' },
  'edit.tileMotion.hint': {
    ru: 'Нажмите на плитку, чтобы задать её собственное движение.',
    en: 'Press a tile to give it a motion of its own.',
  },
  'edit.tileMotion.tile': { ru: 'Движение плитки {tile}', en: 'Motion of tile {tile}' },
  'edit.tilePresentation.category': { ru: 'Вид группы {category}', en: 'View of group {category}' },
  'edit.tilePresentation.heading': { ru: 'ВИД ПЛИТОК', en: 'TILE VIEW' },
  'edit.tilePresentation.hint': {
    ru: 'Нажмите на плитку, чтобы задать её собственный вид.',
    en: 'Press a tile to give it a view of its own.',
  },
  'edit.tilePresentation.tile': { ru: 'Вид плитки {tile}', en: 'View of tile {tile}' },
  'edit.tiles.groups': { ru: 'ГРУППЫ', en: 'GROUPS' },
  'edit.tiles.heading': { ru: 'ПЛИТКИ ЭКРАНА', en: 'SCREEN TILES' },
  'edit.tiles.noneOnScreen': {
    ru: 'На этом экране сейчас нет плиток — поимённый выбор появится, когда вы откроете экран с плитками. Группы ниже переключаются и без него.',
    en: 'No tiles on this screen right now -- picking them by name appears once you open a screen that has tiles. The groups below still switch without it.',
  },
  'edit.translation.count': { ru: 'Своих подписей: {count}', en: 'Own captions: {count}' },
  'edit.translation.field': {
    ru: 'Подпись плитки {element} на языке {locale}',
    en: 'Caption of tile {element} in {locale}',
  },
  'edit.translation.heading': { ru: 'ПЕРЕВОД ЭЛЕМЕНТА', en: 'ELEMENT TRANSLATION' },
  'edit.translation.hint': {
    ru: 'Нажмите на плитку, чтобы задать её подпись на текущем языке.',
    en: 'Press a tile to give it a caption in the current language.',
  },
  'edit.translation.propose': { ru: 'ЧЕРНОВИК ПЕРЕВОДА', en: 'TRANSLATION DRAFT' },
  'edit.translation.proposeHint': {
    ru: 'Откроется форма GitHub с готовым файлом перевода. Пулл-реквест создаёте вы при коммите — приложение не узнает его адрес и не может показать ссылку на него.',
    en: 'A GitHub form opens with the translation file already filled in. You create the pull request when you commit — this application never learns its address and cannot show a link to it.',
  },
  'edit.translation.reset': { ru: 'Вернуть исходную подпись', en: 'Restore the original caption' },
} as const satisfies CatalogModule;
