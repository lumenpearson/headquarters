'use client';

import { useEffect, useMemo, useState } from 'react';

import type {
  BridgeMaterialClient,
  MaterialEntry,
} from '@/infrastructure/materials/BridgeMaterialClient';
import {
  previewModeForMaterial,
  readMaterialBlob,
  readMaterialText,
} from '@/infrastructure/materials/MaterialPreviewReader';
import { useNumberSetting } from '@/application/personalization/useSetting';

import { LocalMaterialPlayer } from './LocalMaterialPlayer';

type PreviewState =
  | { readonly type: 'loading' }
  | { readonly type: 'source'; readonly url: string; readonly transport: 'blob' | 'range' }
  | { readonly type: 'text'; readonly content: string }
  | { readonly type: 'error'; readonly message: string };

export function LocalMaterialPreview({
  material,
  client,
}: {
  readonly material: MaterialEntry;
  readonly client: BridgeMaterialClient;
}) {
  // The operator's own limits reach the reader as an argument; the module that
  // enforces them stays free of the store.
  const textBytes = useNumberSetting('materials.textPreviewLimitMb') * 1024 * 1024;
  const binaryBytes = useNumberSetting('materials.previewLimitMb') * 1024 * 1024;
  const limits = useMemo(() => ({ textBytes, binaryBytes }), [binaryBytes, textBytes]);
  const mode = previewModeForMaterial(material, limits);
  const [state, setState] = useState<PreviewState>({ type: 'loading' });

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
        if (mode === 'media-stream') {
          const grant = await client.getPlaybackGrant(material, controller.signal);
          currentGrantId = grant.grantId;
          if (released) {
            release();
            return;
          }
          setState({ type: 'source', url: grant.url, transport: 'range' });
          return;
        }
        const blob = await readMaterialBlob(client, material, controller.signal, limits);
        currentObjectUrl = URL.createObjectURL(blob);
        if (released) {
          release();
          return;
        }
        setState({ type: 'source', url: currentObjectUrl, transport: 'blob' });
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
  }, [client, limits, material, mode]);

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
    return <LocalMaterialPlayer sourceUrl={state.url} title={material.displayName} />;
  }
  return mode === 'image' ? (
    <section className="local-material-preview local-material-preview--image">
      {/* Local Blob URLs cannot use Next image optimization without an HTTP grant. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.url} alt={`Предпросмотр ${material.displayName}`} />
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
