import { describe, expect, it } from 'vitest';

import {
  readCategoryPresentations,
  readTilePresentations,
  resolveTilePresentationCap,
  withCategoryPresentation,
  withTilePresentation,
} from './tilePresentation';

const base = {
  screen: 'overview',
  tile: 'brief',
  category: 'summary',
  tileEntries: [],
  categoryEntries: [],
  applicationCap: null,
} as const;

describe('per-tile presentation cap', () => {
  it('lets a tile override its group', () => {
    const cap = resolveTilePresentationCap({
      ...base,
      tileEntries: ['overview:brief=minimal'],
      categoryEntries: ['summary=compact'],
    });

    // The narrower setting wins, the same order `resolveTileMotion` uses: a
    // group rule an operator cannot override for one tile is a rule they
    // would have to abandon for the whole group.
    expect(cap).toBe('minimal');
  });

  it('falls back to the group, then to the application ceiling', () => {
    expect(resolveTilePresentationCap({ ...base, categoryEntries: ['summary=compact'] })).toBe(
      'compact',
    );
    expect(resolveTilePresentationCap(base)).toBeNull();
    expect(resolveTilePresentationCap({ ...base, applicationCap: 'minimal' })).toBe('minimal');
  });

  it('keys a tile by its screen, because a tile id is unique only within one', () => {
    const entries = ['overview:registry=minimal', 'cases:registry=compact'];

    expect(resolveTilePresentationCap({ ...base, tile: 'registry', tileEntries: entries })).toBe(
      'minimal',
    );
    expect(
      resolveTilePresentationCap({
        ...base,
        screen: 'cases',
        tile: 'registry',
        tileEntries: entries,
      }),
    ).toBe('compact');
  });

  it('ignores an entry it cannot read rather than failing the screen', () => {
    expect(
      readTilePresentations(['nonsense', 'overview:brief=huge', 'overview:brief=full']).size,
    ).toBe(1);
    expect(readCategoryPresentations(['unknown-group=full', 'summary=compact']).size).toBe(1);
  });

  it('drops an entry when the operator returns it to auto', () => {
    const withEntry = withTilePresentation([], 'overview', 'brief', 'minimal');
    expect(withEntry).toEqual(['overview:brief=minimal']);

    // `auto` means "no opinion of my own", so it removes the entry rather than
    // storing a value that repeats the tier below it.
    expect(withTilePresentation(withEntry, 'overview', 'brief', 'auto')).toEqual([]);
    expect(withCategoryPresentation(['summary=compact'], 'summary', 'auto')).toEqual([]);
  });

  it('replaces rather than accumulates when one tile is set twice', () => {
    const once = withTilePresentation([], 'overview', 'brief', 'minimal');
    const twice = withTilePresentation(once, 'overview', 'brief', 'compact');

    expect(twice).toEqual(['overview:brief=compact']);
  });
});
