import { describe, expect, it } from 'vitest';

import {
  accessPayloadSchema,
  dossierPayloadSchema,
  graphPayloadSchema,
  localizedTextSchema,
  mapPayloadSchema,
} from './payloadSchemas.js';

describe('localizedTextSchema', () => {
  it('accepts a bare, trimmed non-empty string', () => {
    expect(localizedTextSchema.parse('Обухов / печать')).toBe('Обухов / печать');
  });

  it('accepts a partial record of locale tag to string', () => {
    const value = { ru: 'Обухов / печать', en: 'Obukhov / print' };
    expect(localizedTextSchema.parse(value)).toEqual(value);
  });

  it('accepts a record with only one locale, mid-translation', () => {
    expect(localizedTextSchema.parse({ ru: 'Обухов / печать' })).toEqual({
      ru: 'Обухов / печать',
    });
  });

  it('rejects an empty string', () => {
    expect(localizedTextSchema.safeParse('').success).toBe(false);
  });

  it('rejects an empty string inside the record', () => {
    expect(localizedTextSchema.safeParse({ ru: '' }).success).toBe(false);
  });

  it('rejects a value that is neither a string nor a record', () => {
    expect(localizedTextSchema.safeParse(42).success).toBe(false);
    expect(localizedTextSchema.safeParse(['ru']).success).toBe(false);
  });
});

describe('a display field carried through localizedTextSchema', () => {
  it('accepts mapPayloadSchema.title as a bare string, unchanged from before the migration', () => {
    const result = mapPayloadSchema.safeParse({
      mapAsset: 'map-hq',
      title: 'СОПРОВОЖДЕНИЕ ОБЪЕКТА',
      markers: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts mapPayloadSchema.title with an English side once one exists', () => {
    const result = mapPayloadSchema.safeParse({
      mapAsset: 'map-hq',
      title: { ru: 'СОПРОВОЖДЕНИЕ ОБЪЕКТА', en: 'OBJECT TRACKING' },
      markers: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts dossierPayloadSchema.status as a bare string, the free-text form the scene builders write', () => {
    const result = dossierPayloadSchema.safeParse({
      entityId: 'obukhov',
      displayName: 'ОБУХОВ',
      status: 'НАЙДЕНО',
    });
    expect(result.success).toBe(true);
  });
});

describe('an enum discriminant left out of the migration', () => {
  it('rejects a localized record for accessPayloadSchema.status, which stays a literal state enum', () => {
    const result = accessPayloadSchema.safeParse({
      title: 'ДОСТУП',
      status: { ru: 'ПРЕДОСТАВЛЕНО', en: 'GRANTED' },
      subject: 'ОБЪЕКТ',
      checkpoint: 'КПП-1',
      timestamp: '14:00:00',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a localized record for a graph node kind, which stays a literal render discriminant', () => {
    const result = graphPayloadSchema.safeParse({
      title: 'СХЕМА',
      nodes: [
        {
          id: 'n1',
          label: 'ОБЪЕКТ 01',
          kind: { ru: 'человек', en: 'person' },
          x: 0.5,
          y: 0.5,
        },
      ],
      edges: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('the bounds a localized value keeps', () => {
  it('refuses a string longer than the cap, in either branch of the union', () => {
    const tooLong = 'А'.repeat(601);
    expect(mapPayloadSchema.safeParse({ mapAsset: 'm', title: tooLong }).success).toBe(false);
    expect(
      mapPayloadSchema.safeParse({ mapAsset: 'm', title: { ru: 'КАРТА', en: tooLong } }).success,
    ).toBe(false);
  });

  it('refuses a value naming more locales than the cap', () => {
    const manyLocales = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`l${index}`, 'КАРТА']),
    );
    expect(mapPayloadSchema.safeParse({ mapAsset: 'm', title: manyLocales }).success).toBe(false);
  });

  it('accepts a value at the caps, so the bound is a limit and not an off-by-one refusal', () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`l${index}`, 'А'.repeat(600)]),
    );
    expect(mapPayloadSchema.safeParse({ mapAsset: 'm', title: atLimit }).success).toBe(true);
  });
});
