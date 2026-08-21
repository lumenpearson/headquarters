'use client';

import { useEffect, useMemo, useState } from 'react';

import { useMaterialCatalog } from '@/components/settings/MaterialCatalog';
import { BridgeMaterialClient } from '@/infrastructure/materials/BridgeMaterialClient';
import { openMaterialSource } from '@/infrastructure/materials/MaterialSource';

/**
 * Resolves the material a background setting points at into something the
 * shell can paint, and lets go of it when the choice changes.
 *
 * Pass an empty id to resolve nothing: that is how the shell expresses "this
 * background kind is not selected", and it keeps the hook unconditional while
 * still not reading a file nobody is going to see.
 */
export function useBackgroundMaterialUrl(materialId: string): string | null {
  const catalog = useMaterialCatalog();
  const requestCatalog = catalog.request;

  useEffect(() => {
    if (materialId !== '') requestCatalog();
  }, [materialId, requestCatalog]);

  const material = useMemo(
    () =>
      materialId === ''
        ? undefined
        : catalog.materials.find((entry) => entry.materialId === materialId),
    [catalog.materials, materialId],
  );

  // Keyed by the material it belongs to, so "no material chosen" and "a
  // different material chosen" are both derived rather than written. Storing a
  // bare URL would let the previous background stay on screen for a frame
  // after the operator picked a new one.
  const [resolved, setResolved] = useState<ResolvedBackground | null>(null);

  useEffect(() => {
    if (material === undefined) return;
    const controller = new AbortController();
    const handle = openMaterialSource(new BridgeMaterialClient(), material, controller.signal);
    const openedFor = material.materialId;
    void handle.opened
      .then((source) => {
        if (!controller.signal.aborted) setResolved({ materialId: openedFor, url: source.url });
      })
      .catch(() => {
        // A material that cannot be read is not a broken application: the
        // background falls back to the placeholder grid and the shell carries
        // on. Leaving `resolved` alone is enough -- it no longer matches.
      });
    return () => {
      controller.abort();
      handle.release();
    };
  }, [material]);

  return resolved !== null && resolved.materialId === materialId ? resolved.url : null;
}

interface ResolvedBackground {
  readonly materialId: string;
  readonly url: string;
}

/**
 * The video background layer.
 *
 * A real `<video>` rather than CSS, because CSS cannot play one, drawn behind
 * the shell's content and inert to the pointer. Muted and `playsInline` are not
 * decoration: without them a browser refuses to autoplay it at all.
 */
export function BackgroundVideoLayer({
  source,
  paused,
}: {
  readonly source: string;
  readonly paused: boolean;
}) {
  return (
    <div className="ops-shell__background-video" aria-hidden="true">
      <video
        src={source}
        muted
        loop
        playsInline
        autoPlay={!paused}
        // Decoding a clip nobody asked to move wastes the battery this app is
        // meant to survive a shoot day on, so a paused background really stops.
        ref={(element) => {
          if (element === null) return;
          if (paused) element.pause();
          else void element.play().catch(() => undefined);
        }}
      />
    </div>
  );
}
