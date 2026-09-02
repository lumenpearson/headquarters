import type { EditDockEdge } from '../../state/operationsStore';

export interface PanelPoint {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Decides which edge a dragged edit panel snaps to.
 *
 * Pure, and separated from the panel component, so the snapping rule can be
 * tested without a DOM: React decides where the pointer went, this decides
 * where the panel lands.
 *
 * Distance always decides, including outside `threshold`. A rule that snapped
 * only within the band would leave the panel floating mid-screen, and the
 * request asks for magnetic alignment to the sides rather than free placement.
 * `threshold` therefore narrows the candidates when the pointer is genuinely
 * near an edge, and is ignored when it is not.
 */
export function resolveDockEdge(
  point: PanelPoint,
  viewport: Viewport,
  threshold: number,
): EditDockEdge {
  // Deliberately not clamped to zero. Pointer capture can report coordinates
  // beyond the viewport during a fast drag, and a negative distance is exactly
  // the signal we want: the further past an edge the pointer went, the smaller
  // that edge's number, so the edge it actually left through wins. Clamping
  // would flatten every outside edge to zero and resolve the result by array
  // order instead — a release at (-10, 2000) would dock left rather than
  // bottom, though it exited 920px below and only 10px to the side.
  const distances: readonly (readonly [EditDockEdge, number])[] = [
    ['left', point.x],
    ['top', point.y],
    ['right', viewport.width - point.x],
    ['bottom', viewport.height - point.y],
  ];

  const withinThreshold = distances.filter(([, distance]) => distance <= threshold);
  const candidates = withinThreshold.length > 0 ? withinThreshold : distances;

  // Strict `<` keeps the first candidate on a tie, so an ambiguous release —
  // a corner, or the exact centre — always resolves the same way instead of
  // depending on how the array happened to be ordered.
  return candidates.reduce((nearest, candidate) =>
    candidate[1] < nearest[1] ? candidate : nearest,
  )[0];
}

/** The four edges pointer dragging can dock to, in the order the keyboard cycles them. */
const dockEdgeOrder: readonly EditDockEdge[] = ['left', 'top', 'right', 'bottom'];

/**
 * The edge a keyboard dock moves the panel to next.
 *
 * Dragging picks an edge directly, by where the pointer left the window;
 * nothing about the keyboard says "leave through here" the way a release
 * point does, so the keyboard path cycles the same four edges instead of
 * guessing one. Pure, and separate from the component, for the same reason
 * `resolveDockEdge` is: the rule is tested without a DOM.
 */
export function nextDockEdge(current: EditDockEdge): EditDockEdge {
  const index = dockEdgeOrder.indexOf(current);
  // The fallback is unreachable -- `dockEdgeOrder` holds all four edges, so the
  // modulo is always one of its indices -- and exists only because
  // `noUncheckedIndexedAccess` cannot see that from the arithmetic.
  return dockEdgeOrder[(index + 1) % dockEdgeOrder.length] ?? 'left';
}
