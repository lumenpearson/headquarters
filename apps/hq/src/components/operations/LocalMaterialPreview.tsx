'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import type { MaterialLibraryClient } from '@/infrastructure/materials/materialLibrary';
import {
  previewModeForMaterial,
  readMaterialBlob,
  readMaterialText,
} from '@/infrastructure/materials/MaterialPreviewReader';
import { useBooleanSetting, useNumberSetting } from '@/application/personalization/useSetting';

import { LocalMaterialPlayer, type LocalMaterialPlayerHandle } from './LocalMaterialPlayer';
import { MaterialAnnotationsPanel } from './MaterialAnnotationsPanel';
import { MaterialRenditionMenu, type RenditionOutcome } from './MaterialRenditionMenu';
import {
  findMaterialSubtitleTracks,
  releaseMaterialSubtitleTracks,
  type MaterialSubtitleTrack,
} from './materialSubtitleTracks';

/*
 * `materials.rememberPreviewPosition`'s storage: a page-session cache, not a
 * persisted one. The preview panel remounts on every material switch (its
 * caller keys it by `materialId`), which would otherwise lose `currentTime`
 * on the very reselect this setting exists for; a browser reload losing it
 * too is the deliberate trade-off of holding it here instead of adding a
 * twelfth `localStorage` key for what is, on this surface, a convenience.
 */
const rememberedPreviewPositions = new Map<string, number>();

type PreviewState =
  | { readonly type: 'loading' }
  | {
      readonly type: 'source';
      readonly url: string;
      readonly transport: 'blob' | 'range';
      readonly rendered: boolean;
    }
  | { readonly type: 'text'; readonly content: string }
  | { readonly type: 'error'; readonly message: string };

export function LocalMaterialPreview({
  material,
  client,
}: {
  readonly material: MaterialEntry;
  readonly client: MaterialLibraryClient;
}) {
  // The operator's own limits reach the reader as an argument; the module that
  // enforces them stays free of the store.
  const textBytes = useNumberSetting('materials.textPreviewLimitMb') * 1024 * 1024;
  const binaryBytes = useNumberSetting('materials.previewLimitMb') * 1024 * 1024;
  const limits = useMemo(() => ({ textBytes, binaryBytes }), [binaryBytes, textBytes]);
  const autoplayPreview = useBooleanSetting('materials.autoplayPreview');
  const loopPreview = useBooleanSetting('materials.loopPreview');
  const rememberPosition = useBooleanSetting('materials.rememberPreviewPosition');
  const mode = previewModeForMaterial(material, limits);
  const [state, setState] = useState<PreviewState>({ type: 'loading' });
  const renditions = useMemo(() => client.renditions(material), [client, material]);
  /*
   * Reset with the material, not merely on mount: the panel keeps one instance
   * across selections, and a 720p left over from the previous file would be
   * requested for a still image the operator had not asked anything about.
   */
  const [variant, setVariant] = useState('');
  const [variantFor, setVariantFor] = useState(material.materialId);
  if (variantFor !== material.materialId) {
    setVariantFor(material.materialId);
    setVariant('');
  }

  const playerHandleRef = useRef<LocalMaterialPlayerHandle>(null);
  const [playerTime, setPlayerTime] = useState(0);
  const [subtitleTracks, setSubtitleTracks] = useState<readonly MaterialSubtitleTrack[]>([]);

  /*
   * Companion `.vtt` tracks, resolved once per material through the same
   * bounded read the text preview uses (`materialSubtitleTracks.ts`) --
   * separate from the source-loading effect below because a subtitle-lookup
   * failure must never block or retry the video itself.
   */
  useEffect(() => {
    if (mode !== 'media' && mode !== 'media-stream') {
      // Deferred, not called synchronously in the effect body -- the same
      // idiom the source-loading effect below already uses for its own
      // `setState({ type: 'loading' })`.
      void Promise.resolve().then(() => setSubtitleTracks([]));
      return;
    }
    const controller = new AbortController();
    let released = false;
    let resolvedTracks: readonly MaterialSubtitleTrack[] = [];
    void findMaterialSubtitleTracks(client, material, controller.signal, limits).then((found) => {
      if (released) {
        releaseMaterialSubtitleTracks(found);
        return;
      }
      resolvedTracks = found;
      setSubtitleTracks(found);
    });
    return () => {
      released = true;
      controller.abort();
      releaseMaterialSubtitleTracks(resolvedTracks);
      void Promise.resolve().then(() => setSubtitleTracks([]));
    };
  }, [client, limits, material, mode]);

  useEffect(() => {
    if (
      mode !== 'image' &&
      mode !== 'media' &&
      mode !== 'media-stream' &&
      mode !== 'pdf' &&
      mode !== 'text'
    )
      return;
    const controller = new AbortController();
    let currentObjectUrl: string | undefined;
    let currentGrantId: string | undefined;
    let released = false;

    const release = () => {
      if (currentObjectUrl !== undefined) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = undefined;
      }
      if (currentGrantId !== undefined) {
        const grantId = currentGrantId;
        currentGrantId = undefined;
        void client.revokePlaybackGrant(grantId).catch(() => undefined);
      }
    };

    void Promise.resolve().then(() => {
      if (!released) setState({ type: 'loading' });
    });
    void (async () => {
      try {
        if (mode === 'text') {
          const content = await readMaterialText(client, material, controller.signal, limits);
          if (!released) setState({ type: 'text', content });
          return;
        }
        /*
         * A named rendition is asked for by name, whatever the material's size:
         * the bounded blob reads the stored object, so taking that path for a
         * variant would show the original and call it 720p.
         */
        if (variant.length > 0) {
          const rendition = renditions.find((candidate) => candidate.variant === variant);
          if (rendition !== undefined) {
            const source = await client.openRendition(material, rendition, controller.signal);
            currentGrantId = source.grantId;
            if (released) {
              release();
              return;
            }
            setState({
              type: 'source',
              url: source.url,
              transport: 'range',
              rendered: source.rendered,
            });
            return;
          }
        }
        if (mode === 'media-stream') {
          const grant = await client.getPlaybackGrant(material, controller.signal);
          currentGrantId = grant.grantId;
          if (released) {
            release();
            return;
          }
          setState({ type: 'source', url: grant.url, transport: 'range', rendered: false });
          return;
        }
        const blob = await readMaterialBlob(client, material, controller.signal, limits);
        currentObjectUrl = URL.createObjectURL(blob);
        if (released) {
          release();
          return;
        }
        setState({ type: 'source', url: currentObjectUrl, transport: 'blob', rendered: false });
      } catch (error: unknown) {
        if (!released && !controller.signal.aborted) {
          setState({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown local preview error.',
          });
        }
      }
    })();

    return () => {
      released = true;
      controller.abort();
      release();
    };
  }, [client, limits, material, mode, renditions, variant]);

  const outcome: RenditionOutcome =
    state.type === 'loading'
      ? 'pending'
      : state.type === 'error'
        ? 'failed'
        : state.type === 'source' && state.rendered
          ? 'rendered'
          : variant.length === 0
            ? 'pending'
            : 'original';

  if (mode === 'unsupported') {
    return <MetadataOnlyPreview reason="ПРЕДПРОСМОТР ЭТОГО ТИПА БУДЕТ ДОБАВЛЕН ОТДЕЛЬНЫМ VIEWER" />;
  }
  if (mode === 'oversize') {
    return (
      <MetadataOnlyPreview reason="МАТЕРИАЛ ПРЕВЫШАЕТ БЕЗОПАСНЫЙ ЛИМИТ ЛОКАЛЬНОГО ПРЕДПРОСМОТРА" />
    );
  }
  if (state.type === 'loading')
    return <MetadataOnlyPreview reason="ЧТЕНИЕ ЛОКАЛЬНОГО MATERIAL STREAM…" />;
  if (state.type === 'error')
    return <MetadataOnlyPreview reason={`ОШИБКА VIEWER: ${state.message}`} />;
  if (state.type === 'text') {
    return (
      <section
        className="local-material-preview local-material-preview--text"
        aria-label="Текстовый предпросмотр"
      >
        <pre>{state.content}</pre>
      </section>
    );
  }
  if (mode === 'media' || mode === 'media-stream') {
    return (
      <div className="local-material-preview local-material-preview--media">
        <LocalMaterialPlayer
          ref={playerHandleRef}
          sourceUrl={state.url}
          title={material.displayName}
          tracks={subtitleTracks}
          autoPlay={autoplayPreview}
          loop={loopPreview}
          initialTime={
            rememberPosition ? (rememberedPreviewPositions.get(material.materialId) ?? 0) : 0
          }
          onTimeUpdate={(seconds) => {
            setPlayerTime(seconds);
            if (rememberPosition) rememberedPreviewPositions.set(material.materialId, seconds);
          }}
          quality={
            <MaterialRenditionMenu
              renditions={renditions}
              variant={variant}
              onVariantChange={setVariant}
              outcome={outcome}
            />
          }
        />
        <MaterialAnnotationsPanel
          materialId={material.materialId}
          currentTime={playerTime}
          onSeek={(seconds) => playerHandleRef.current?.seekTo(seconds)}
        />
      </div>
    );
  }
  return mode === 'image' ? (
    <section className="local-material-preview local-material-preview--image">
      {/* Local Blob URLs cannot use Next image optimization without an HTTP grant. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.url} alt={`Предпросмотр ${material.displayName}`} />
      <MaterialRenditionMenu
        renditions={renditions}
        variant={variant}
        onVariantChange={setVariant}
        outcome={outcome}
      />
    </section>
  ) : (
    <section className="local-material-preview local-material-preview--pdf">
      <iframe
        src={state.url}
        title={`PDF предпросмотр ${material.displayName}`}
        sandbox=""
        referrerPolicy="no-referrer"
      />
    </section>
  );
}

function MetadataOnlyPreview({ reason }: { readonly reason: string }) {
  return (
    <section className="local-material-preview local-material-preview--status" role="status">
      <span>[LOCAL VIEWER]</span>
      <strong>{reason}</strong>
    </section>
  );
}
