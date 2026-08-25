import { describe, expect, it } from 'vitest';

import {
  defaultTileMotion,
  readCategoryMotions,
  readTileMotions,
  resolveTileMotion,
  withCategoryMotion,
  withTileMotion,
} from './tileMotion';

const base = {
  screen: 'overview',
  tile: 'brief',
  category: 'summary',
  tileEntries: [],
  categoryEntries: [],
  enteringAllowed: true,
} as const;

describe('per-tile animation', () => {
  it('lets a tile override its group', () => {
    const motion = resolveTileMotion({
      ...base,
      tileEntries: ['overview:brief=scan'],
      categoryEntries: ['summary=rise'],
    });

    // The narrower setting wins because that is the only order in which the two
    // are worth having: a group rule an operator cannot override for one tile
    // is a rule they would have to abandon for the whole group.
    expect(motion).toBe('scan');
  });

  it('falls back to the group, then to the default', () => {
    expect(resolveTileMotion({ ...base, categoryEntries: ['summary=rise'] })).toBe('rise');
    expect(resolveTileMotion(base)).toBe(defaultTileMotion);
  });

  it('lets the application-wide switch overrule both', () => {
    const motion = resolveTileMotion({
      ...base,
      tileEntries: ['overview:brief=scan'],
      categoryEntries: ['summary=rise'],
      enteringAllowed: false,
    });

    // A floor, not another tier. An operator who turned entering animation off
    // has said something about the room they are in, and a per-tile preference
    // is not an argument against it.
    expect(motion).toBe('none');
  });

  it('keys a tile by its screen, because a tile id is unique only within one', () => {
    const entries = ['overview:registry=scan', 'cases:registry=rise'];

    expect(resolveTileMotion({ ...base, tile: 'registry', tileEntries: entries })).toBe('scan');
    expect(
      resolveTileMotion({ ...base, screen: 'cases', tile: 'registry', tileEntries: entries }),
    ).toBe('rise');
    // `registry` is the table on four screens. Spans learned this the hard way,
    // and repeating the shape is what keeps the next per-tile setting from
    // repeating the mistake.
  });

  it('ignores an entry it cannot read rather than failing the screen', () => {
    expect(
      readTileMotions(['nonsense', 'overview:brief=teleport', 'overview:brief=fade']).size,
    ).toBe(1);
    expect(readCategoryMotions(['unknown-group=fade', 'summary=rise']).size).toBe(1);
  });

  it('drops an entry when the operator returns it to the group', () => {
    const withEntry = withTileMotion([], 'overview', 'brief', 'scan');
    expect(withEntry).toEqual(['overview:brief=scan']);

    // `inherit` means "no opinion of my own", so it removes the entry rather
    // than storing a value that repeats the group's.
    expect(withTileMotion(withEntry, 'overview', 'brief', 'inherit')).toEqual([]);
    expect(withCategoryMotion(['summary=rise'], 'summary', 'inherit')).toEqual([]);
  });

  it('replaces rather than accumulates when one tile is set twice', () => {
    const once = withTileMotion([], 'overview', 'brief', 'scan');
    const twice = withTileMotion(once, 'overview', 'brief', 'fade');

    expect(twice).toEqual(['overview:brief=fade']);
  });
});
