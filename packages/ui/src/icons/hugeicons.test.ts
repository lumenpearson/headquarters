import { describe, expect, it } from 'vitest';

import { hugeiconsIconAdapter } from './hugeicons.js';
import { iconNames } from './types.js';

describe('hugeiconsIconAdapter', () => {
  it('answers every IconName with at least one child element', () => {
    for (const name of iconNames) {
      expect(hugeiconsIconAdapter[name], name).toBeDefined();
      expect(hugeiconsIconAdapter[name].length, name).toBeGreaterThan(0);
    }
  });

  /*
   * The case this adapter exists to fix. Every `@hugeicons/core-free-icons`
   * shape bakes `stroke`, `strokeLinecap`, `strokeLinejoin` and `strokeWidth`
   * onto *each path*, confirmed against the package's own source
   * (`Cancel01Icon`, `PanelLeftOpenIcon`, …). Left in place, a CSS rule that
   * only reaches the `<svg>` -- exactly what `TerminalIcon`'s own class does
   * -- cannot cascade down to a child that already specifies its own value:
   * inheritance never runs for a property an element already has one for.
   * `stripPresentation` has to remove all four from every path, for every
   * name, or the size/colour a call site sets stops reaching the shape.
   */
  it('strips every baked stroke/fill attribute so the outer svg keeps deciding', () => {
    const presentationKeys = ['stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fill'];
    for (const name of iconNames) {
      for (const [, attrs] of hugeiconsIconAdapter[name]) {
        for (const key of presentationKeys) {
          expect(key in attrs, `${name}.${key}`).toBe(false);
        }
      }
    }
  });

  it('still carries the geometry the stripped attributes sat beside', () => {
    // A stripped node that lost its `d` too would render an empty path --
    // this is what would have caught it.
    for (const name of iconNames) {
      for (const [tag, attrs] of hugeiconsIconAdapter[name]) {
        const hasGeometry =
          'd' in attrs || 'cx' in attrs || 'x1' in attrs || 'x' in attrs || 'points' in attrs;
        expect(hasGeometry, `${name} <${tag}>`).toBe(true);
      }
    }
  });
});
