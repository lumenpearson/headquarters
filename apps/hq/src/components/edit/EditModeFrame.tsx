'use client';

import { useOperationsStore } from '../../state/operationsStore';

/**
 * The accent-gradient border shown around the window while edit mode is on.
 *
 * A sibling of `.ops-shell`'s content rather than a modification of it: the
 * border must not shift the layout of anything beneath it, so it is drawn as
 * a `position: fixed` overlay with `pointer-events: none`. Its
 * animation-attachment rule and keyframe stay in edit.css; everything else --
 * including the paint itself -- is a Tailwind class below.
 *
 * The paint is four edge gradients fading to transparent within
 * `--edit-frame-reach`, plus the glow as an inset shadow. Drawn this way
 * rather than as an opaque fill clipped with `mask-composite: exclude`: the
 * previous construction painted the fill over the whole window on a runtime
 * that ignores that composite. No layer here can ever cover the workspace
 * with a fill.
 */
export function EditModeFrame() {
  const active = useOperationsStore((state) => state.edit.active);
  if (!active) return null;
  return (
    <div
      className="edit-mode-frame fixed inset-0 z-[var(--z-devtools)] pointer-events-none [--edit-frame-reach:clamp(36px,5vw,96px)] bg-[linear-gradient(to_right,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_var(--edit-frame-reach)),linear-gradient(to_left,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_var(--edit-frame-reach)),linear-gradient(to_bottom,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_var(--edit-frame-reach)),linear-gradient(to_top,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_var(--edit-frame-reach))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_70%,transparent),inset_0_0_28px_color-mix(in_srgb,var(--accent)_26%,transparent),inset_0_0_96px_color-mix(in_srgb,var(--accent)_12%,transparent)]"
      aria-hidden="true"
    />
  );
}
