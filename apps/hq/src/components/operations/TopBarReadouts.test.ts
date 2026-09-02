import type { Sector } from '@gremuchaya/domain';
import { describe, expect, it } from 'vitest';

import { clearanceReadout, secureLinkReadout, sectorFocus } from './TopBarReadouts';

function sector(
  overrides: Partial<Sector> & Pick<Sector, 'id' | 'code' | 'name' | 'threat'>,
): Sector {
  return {
    readiness: 90,
    center: { lat: 0, lng: 0, x: 0, y: 0 },
    status: 'ACTIVE',
    ...overrides,
  };
}

describe('sectorFocus', () => {
  it('picks the sector with the highest threat reading', () => {
    const sectors = {
      'SEC-0': sector({ id: 'SEC-0', code: 'S-01', name: 'СЕВЕРНЫЙ КОНТУР', threat: 22 }),
      'SEC-2': sector({ id: 'SEC-2', code: 'S-03', name: 'ТРАНСПОРТНЫЙ УЗЕЛ', threat: 78 }),
      'SEC-3': sector({ id: 'SEC-3', code: 'S-04', name: 'ЦЕНТРАЛЬНЫЙ СЕКТОР', threat: 61 }),
    };

    expect(sectorFocus(sectors)).toEqual({ code: 'S-03', abbreviation: 'ТУ' });
  });

  it('reports nothing for a world with no sectors', () => {
    expect(sectorFocus({})).toBeUndefined();
  });
});

describe('clearanceReadout', () => {
  it('reads the highest tier for a session with no group, which is not "no clearance"', () => {
    expect(clearanceReadout(undefined)).toEqual({ tier: 'АЛЬФА', code: 'А1' });
  });

  it('names the paired role once one exists', () => {
    expect(clearanceReadout({ role: 'ADMIN' })).toEqual({ tier: 'АЛЬФА', code: 'А1' });
    expect(clearanceReadout({ role: 'EDITOR' })).toEqual({ tier: 'БЕТА', code: 'В2' });
    expect(clearanceReadout({ role: 'VIEWER' })).toEqual({ tier: 'ГАММА', code: 'С3' });
  });
});

describe('secureLinkReadout', () => {
  it('names every connection mode exactly once', () => {
    const modes = [
      'local-only',
      'offline',
      'connecting',
      'online',
      'reauth-required',
      'installation-changed',
    ] as const;
    const named = modes.map((mode) => secureLinkReadout(mode));

    expect(new Set(named).size).toBe(modes.length);
  });

  it('claims secured only for the mode it is actually true of', () => {
    expect(secureLinkReadout('online')).toBe('ЗАЩИЩЕНА');
    expect(secureLinkReadout('local-only')).not.toBe('ЗАЩИЩЕНА');
    expect(secureLinkReadout('offline')).not.toBe('ЗАЩИЩЕНА');
  });
});
