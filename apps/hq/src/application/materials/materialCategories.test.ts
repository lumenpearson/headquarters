import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import {
  importPhaseLabel,
  materialCategoryLabel,
  materialCategoryOptions,
} from './materialCategories';

describe('materialCategoryOptions', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('offers every category the schema declares, each under a real label', () => {
    const options = materialCategoryOptions();

    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.label).not.toMatch(/^⟦/u);
    }
  });

  it('follows the locale', () => {
    expect(materialCategoryLabel('video')).toBe('ВИДЕО');

    operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);

    expect(materialCategoryLabel('video')).toBe('VIDEO');
    const options = materialCategoryOptions();
    const video = options.find((option) => option.value === 'video');
    expect(video?.label).toBe('VIDEO');
  });

  it('falls back to the bare identifier for a value this table does not name', () => {
    expect(materialCategoryLabel('unheard-of-category')).toBe('UNHEARD-OF-CATEGORY');
  });
});

describe('importPhaseLabel', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('names every phase of MaterialImportProgress', () => {
    for (const phase of ['starting', 'hashing', 'uploading', 'verifying', 'completed'] as const) {
      expect(importPhaseLabel(phase)).not.toMatch(/^⟦/u);
    }
  });

  it('follows the locale', () => {
    expect(importPhaseLabel('uploading')).toBe('ЗАГРУЗКА');

    operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);

    expect(importPhaseLabel('uploading')).toBe('UPLOADING');
  });
});
