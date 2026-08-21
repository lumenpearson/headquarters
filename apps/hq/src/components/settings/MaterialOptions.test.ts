import { describe, expect, it } from 'vitest';

import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import { materialOptionsFor, unsetMaterialOption } from './MaterialOptions';

const entry = (name: string, mimeType: string, id: string): MaterialEntry => ({
  materialId: id,
  displayName: name,
  mimeType,
  byteSize: 10n,
  contentHash: '',
  createdAt: '2026-08-21T00:00:00.000Z',
});

const photo = entry('Фон.png', 'image/png', '018f0f1a-8000-7000-8000-000000000001');
const clip = entry('Петля.webm', 'video/webm', '018f0f1a-8000-7000-8000-000000000002');
const shouty = entry('Скан.JPG', 'IMAGE/JPEG', '018f0f1a-8000-7000-8000-000000000003');

describe('material picker options', () => {
  it('offers only material whose type the setting accepts', () => {
    const options = materialOptionsFor([photo, clip], ['image/'], '');
    expect(options.map((option) => option.value)).toEqual([unsetMaterialOption, photo.materialId]);
  });

  it('matches the media type case-insensitively', () => {
    // Media types arrive from a filesystem, not from a controlled vocabulary.
    const options = materialOptionsFor([shouty], ['image/'], '');
    expect(options.map((option) => option.value)).toContain(shouty.materialId);
  });

  it('always offers a way back to no material at all', () => {
    expect(materialOptionsFor([], ['image/'], '')[0]).toEqual({
      value: unsetMaterialOption,
      label: '[НЕ ВЫБРАН]',
    });
  });

  it('keeps a chosen material visible after it disappears from the catalogue', () => {
    // Silently dropping it would show the operator "not chosen" while the
    // setting still holds a reference, and the next reset would look like a
    // no-op. A disabled row says what actually happened.
    const options = materialOptionsFor([], ['image/'], photo.materialId);
    expect(options).toContainEqual({
      value: photo.materialId,
      label: '[ОТСУТСТВУЕТ] 018f0f1a-800',
      disabled: true,
    });
  });

  it('does not duplicate the chosen material when it is present', () => {
    const options = materialOptionsFor([photo], ['image/'], photo.materialId);
    expect(options.filter((option) => option.value === photo.materialId)).toHaveLength(1);
  });
});
