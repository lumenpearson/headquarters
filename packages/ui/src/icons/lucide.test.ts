import { describe, expect, it } from 'vitest';

import { lucideIconAdapter } from './lucide.js';
import { iconNames } from './types.js';

describe('lucideIconAdapter', () => {
  it('answers every IconName with at least one child element', () => {
    for (const name of iconNames) {
      expect(lucideIconAdapter[name], name).toBeDefined();
      expect(lucideIconAdapter[name].length, name).toBeGreaterThan(0);
    }
  });

  it('resolves every deep per-icon import, not just the names typed at build time', () => {
    // `satisfies IconAdapter` only proves the *type* is total; the ambient
    // wildcard declaration in `icon-modules.d.ts` matches a deep path whether
    // or not the file actually exists, so this is what actually exercises
    // module resolution against `node_modules` for all twenty-three imports.
    expect(Object.values(lucideIconAdapter).every((node) => node.length > 0)).toBe(true);
  });

  it('carries no baked stroke, fill or colour on any child', () => {
    // The reason this adapter can bypass `createLucideIcon`'s own component:
    // lucide's raw `__iconNode` never carries a presentation attribute, only
    // geometry (`d`, or a primitive's own coordinates, which do include a
    // `width`/`height` on a `<rect>` -- that is shape, not styling) and `key`.
    const presentationKeys = ['stroke', 'strokeWidth', 'fill', 'color'];
    for (const name of iconNames) {
      for (const [, attrs] of lucideIconAdapter[name]) {
        for (const key of presentationKeys) {
          expect(key in attrs, `${name}.${key}`).toBe(false);
        }
      }
    }
  });
});
