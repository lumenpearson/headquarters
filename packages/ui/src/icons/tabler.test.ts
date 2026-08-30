import { describe, expect, it } from 'vitest';

import { tablerIconAdapter } from './tabler.js';
import { iconNames } from './types.js';

describe('tablerIconAdapter', () => {
  it('answers every IconName with at least one child element', () => {
    for (const name of iconNames) {
      expect(tablerIconAdapter[name], name).toBeDefined();
      expect(tablerIconAdapter[name].length, name).toBeGreaterThan(0);
    }
  });

  it('resolves every deep per-icon import, not just the names typed at build time', () => {
    expect(Object.values(tablerIconAdapter).every((node) => node.length > 0)).toBe(true);
  });

  it('carries no baked stroke, fill or colour on any child', () => {
    // `createReactComponent`'s own `stroke` prop actually sets stroke-*width*
    // (its `color` prop sets the DOM `stroke` attribute), which the outer
    // component always writes regardless of what a caller passes -- the
    // reason this adapter reads the raw `__iconNode` instead. `width`/
    // `height` are excluded here too: a `<rect>` child's own are geometry.
    const presentationKeys = ['stroke', 'strokeWidth', 'fill', 'color'];
    for (const name of iconNames) {
      for (const [, attrs] of tablerIconAdapter[name]) {
        for (const key of presentationKeys) {
          expect(key in attrs, `${name}.${key}`).toBe(false);
        }
      }
    }
  });
});
