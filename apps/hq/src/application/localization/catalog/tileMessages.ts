import type { CatalogModule } from './catalogTypes';

/**
 * Tile categories, motion and presentation.
 *
 * Each table is keyed by a union the consumer declares as
 * `Record<Union, MessageId>`, so a union member with no message is a compile
 * error rather than a lookup that misses at runtime.
 */
export const tileMessages = {
  'tileCategory.detail': { ru: 'КАРТОЧКИ', en: 'CARDS' },
  'tileCategory.events': { ru: 'СОБЫТИЯ', en: 'EVENTS' },
  'tileCategory.geo': { ru: 'ГЕОГРАФИЯ', en: 'GEOGRAPHY' },
  'tileCategory.navigation': { ru: 'НАВИГАЦИЯ', en: 'NAVIGATION' },
  'tileCategory.records': { ru: 'РЕЕСТРЫ', en: 'REGISTRIES' },
  'tileCategory.summary': { ru: 'СВОДКА', en: 'SUMMARY' },
  'tileCategory.telemetry': { ru: 'ТЕЛЕМЕТРИЯ', en: 'TELEMETRY' },
  'tileMotion.fade': { ru: 'ПРОЯВЛЕНИЕ', en: 'FADE' },
  'tileMotion.inherit': { ru: 'КАК У ГРУППЫ', en: 'SAME AS GROUP' },
  'tileMotion.none': { ru: 'БЕЗ ДВИЖЕНИЯ', en: 'NO MOTION' },
  'tileMotion.rise': { ru: 'ПОДЪЁМ', en: 'RISE' },
  'tileMotion.scan': { ru: 'РАЗВЁРТКА', en: 'SCAN' },
  'tilePresentation.auto': { ru: 'КАК У ГРУППЫ', en: 'SAME AS GROUP' },
  'tilePresentation.compact': { ru: 'КОМПАКТНЫЙ ВИД', en: 'COMPACT VIEW' },
  'tilePresentation.full': { ru: 'ПОЛНЫЙ ВИД', en: 'FULL VIEW' },
  'tilePresentation.minimal': { ru: 'МИНИМАЛЬНЫЙ ВИД', en: 'MINIMAL VIEW' },
} as const satisfies CatalogModule;
