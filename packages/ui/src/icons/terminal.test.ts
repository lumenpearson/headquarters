import { describe, expect, it } from 'vitest';

import { terminalIconAdapter } from './terminal.js';
import { iconNames } from './types.js';

describe('terminalIconAdapter', () => {
  it('answers every IconName with at least one child element', () => {
    for (const name of iconNames) {
      expect(terminalIconAdapter[name], name).toBeDefined();
      expect(terminalIconAdapter[name].length, name).toBeGreaterThan(0);
    }
  });

  it('keeps the settings-card sixteen the shape settingsCardIcons.tsx always drew', () => {
    // Spot-checked rather than transcribed whole: the tuple form has to carry
    // the exact same geometry `glyph()`'s JSX did, or `styles.iconSet` at its
    // `'terminal'` default would move the settings-card grid.
    expect(terminalIconAdapter.simulation).toEqual([
      ['polyline', { points: '3,13 8,13 10,7 14,17 16,13 21,13', key: '0' }],
    ]);
    expect(terminalIconAdapter.appearance).toEqual([
      ['circle', { cx: 12, cy: 12, r: 9, key: '0' }],
      ['path', { d: 'M12 3a9 9 0 0 1 0 18z', fill: 'currentColor', stroke: 'none', key: '1' }],
    ]);
  });

  it('computes the cog spokes at the same six angles settingsCardIcons.tsx mapped over', () => {
    const system = terminalIconAdapter.system;
    expect(system).toHaveLength(7); // one hub circle, six spokes
    const [hub, ...spokes] = system;
    expect(hub).toEqual(['circle', { cx: 12, cy: 12, r: 4, key: 'hub' }]);
    // The 0-degree spoke: cos(0)=1, sin(0)=0, so it runs due east of the hub.
    expect(spokes[0]).toEqual(['line', { x1: 18, y1: 12, x2: 21, y2: 12, key: 'spoke-0' }]);
  });
});
