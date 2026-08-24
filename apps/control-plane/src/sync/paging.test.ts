import { describe, expect, it } from 'vitest';

import { normalizePageSize } from './paging.js';

const bounds = { defaultPageSize: 50, maxPageSize: 100 };

describe('page size', () => {
  it('reads zero as the caller expressing no preference', () => {
    // Zero is the proto3 default for an unset field, so it cannot mean "none".
    expect(normalizePageSize(0, bounds)).toBe(50);
  });

  it('refuses a size past the ceiling instead of quietly serving fewer rows', () => {
    // A clamp looks like success and is not: a client that asked for five
    // thousand rows and received a hundred cannot tell that from a group with a
    // hundred rows, and will stop paging.
    expect(() => normalizePageSize(5000, bounds)).toThrow('page_size must be between 1 and 100');
  });

  it('refuses a size that is not a whole positive number', () => {
    for (const requested of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizePageSize(requested, bounds)).toThrow('page_size must be between');
    }
  });

  it('passes a size inside the bounds through unchanged', () => {
    expect(normalizePageSize(1, bounds)).toBe(1);
    expect(normalizePageSize(100, bounds)).toBe(100);
  });
});
