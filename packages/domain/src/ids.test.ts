import { describe, expect, it } from 'vitest';

import { isMaterialId } from './ids.js';

describe('material identifiers', () => {
  it('accepts the identifiers the material bridge issues', () => {
    expect(isMaterialId('018f0f1a-8000-7000-8000-000000000000')).toBe(true);
    expect(isMaterialId('018F0F1A-8000-7000-8000-000000000000')).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a nil UUID, whose version nibble is zero', '00000000-0000-0000-0000-000000000000'],
    ['a version outside 1..8', '018f0f1a-8000-9000-8000-000000000000'],
    ['a variant outside 8..b', '018f0f1a-8000-7000-c000-000000000000'],
    ['a path, which a material id must never be confused with', '/Материалы/Фон.jpg'],
    ['a URL', 'https://example.test/a.jpg'],
    ['trailing whitespace', '018f0f1a-8000-7000-8000-000000000000 '],
  ])('rejects %s', (_reason, value) => {
    expect(isMaterialId(value)).toBe(false);
  });
});
