import { describe, expect, it } from 'vitest';

import { resolveDockEdge } from './EditPanelDock';

const viewport = { width: 1920, height: 1080 };

describe('magnetic panel docking', () => {
  it('snaps to whichever edge the pointer is nearest', () => {
    expect(resolveDockEdge({ x: 40, y: 500 }, viewport, 120)).toBe('left');
    expect(resolveDockEdge({ x: 1890, y: 500 }, viewport, 120)).toBe('right');
    expect(resolveDockEdge({ x: 900, y: 30 }, viewport, 120)).toBe('top');
    expect(resolveDockEdge({ x: 900, y: 1050 }, viewport, 120)).toBe('bottom');
  });

  it('picks the closer edge in a corner, where two are both within the threshold', () => {
    // Without a distance comparison the result would depend on which edge is
    // checked first, and the panel would flip between two edges as the pointer
    // moved a pixel inside the corner.
    expect(resolveDockEdge({ x: 20, y: 60 }, viewport, 120)).toBe('left');
    expect(resolveDockEdge({ x: 60, y: 20 }, viewport, 120)).toBe('top');
  });

  it('still returns an edge when the pointer is nowhere near one', () => {
    // The request asks for magnetic alignment to the sides, so there is no
    // "floating" outcome: released mid-screen, the panel goes to the nearest
    // edge rather than staying where it was dropped.
    expect(resolveDockEdge({ x: 960, y: 400 }, viewport, 120)).toBe('top');
    expect(resolveDockEdge({ x: 300, y: 540 }, viewport, 120)).toBe('left');
  });

  it('resolves a tie deterministically rather than by iteration order', () => {
    // At the centre of a 16:9 viewport the vertical edges are the near ones
    // (540 away) and they tie with each other; the horizontal edges are 960
    // away. The particular winner matters less than it being the same winner
    // every time: a panel that jumps elsewhere on identical input reads as a
    // bug to the operator.
    const centre = { x: 960, y: 540 };
    const first = resolveDockEdge(centre, viewport, 120);
    expect(resolveDockEdge(centre, viewport, 120)).toBe(first);
    expect(first).toBe('top');
  });

  it('docks to the edge the pointer left through, not the one it is nearest', () => {
    // Released 10px to the left but 920px below. Clamping out-of-viewport
    // distances to zero would tie every outside edge and hand the result to
    // array order, docking left; keeping the negative distance picks bottom,
    // which is where the pointer actually went.
    expect(resolveDockEdge({ x: -10, y: 2000 }, viewport, 120)).toBe('bottom');
    expect(resolveDockEdge({ x: -2000, y: 1090 }, viewport, 120)).toBe('left');
  });

  it('tolerates a pointer released outside the viewport', () => {
    // Pointer capture can report coordinates past the edge during a fast drag,
    // so an out-of-viewport release must still resolve rather than throw or
    // return something unusable.
    expect(resolveDockEdge({ x: -50, y: 500 }, viewport, 120)).toBe('left');
    expect(resolveDockEdge({ x: 500, y: 2000 }, viewport, 120)).toBe('bottom');
  });
});
