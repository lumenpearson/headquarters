'use client';

import { useOperationsStore } from '../../state/operationsStore';

/**
 * The accent-gradient border shown around the window while edit mode is on.
 *
 * A sibling of `.ops-shell`'s content rather than a modification of it: the
 * border must not shift the layout of anything beneath it, so it is drawn as
 * a `position: fixed` overlay with `pointer-events: none` in edit.css.
 */
export function EditModeFrame() {
  const active = useOperationsStore((state) => state.edit.active);
  if (!active) return null;
  return <div className="edit-mode-frame" aria-hidden="true" />;
}
