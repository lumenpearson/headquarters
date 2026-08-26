import { describe, expect, it } from 'vitest';

import { clampPrefilledBody, codePointLength, codeSpan } from './prefilledUrl';

describe('the shared prefilled-link helpers', () => {
  it('measures in code points, not in UTF-16 units', () => {
    // The whole reason this is a function rather than `.length`: an astral
    // character counts twice in UTF-16, so a cut taken on that count can land
    // between the halves of a surrogate pair. Both links cut on this measure.
    expect('🛰'.length).toBe(2);
    expect(codePointLength('🛰')).toBe(1);
    expect(codePointLength('K-17 🛰 ОБЪЕКТ')).toBe(13);
    expect('K-17 🛰 ОБЪЕКТ'.length).toBe(14);
  });

  it('fences a code span longer than the longest run inside it', () => {
    // Markdown's own rule. A naive pair of backticks would let one operator
    // value close its own span and rewrite the rest of the list as headings.
    expect(codeSpan('a``b')).toBe('```a``b```');
    expect(codeSpan('`a`')).toBe('`` `a` ``');
  });

  it('flattens newlines rather than letting a value end its own row', () => {
    expect(codeSpan('первая\nвторая')).toBe('`первая ⏎ вторая`');
  });

  it('leaves a body that fits exactly as it was', () => {
    expect(clampPrefilledBody('short', ' …', 10)).toBe('short');
  });

  it('cuts a long body on a code-point boundary and says that it did', () => {
    const notice = ' …';
    const clamped = clampPrefilledBody('🛰'.repeat(50), notice, 12);

    expect(codePointLength(clamped)).toBe(12);
    expect(clamped.endsWith(notice)).toBe(true);
    // A lone surrogate is what the URL serializer answers with U+FFFD, so the
    // last character of the list would arrive as a replacement mark.
    expect(clamped).not.toContain('�');
    expect(clamped.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)).toBeNull();
  });
});
