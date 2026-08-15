import type { ReactNode } from 'react';
import Image from 'next/image';

export function AssetSurface({
  assetId,
  children,
  tone = 'default',
}: {
  readonly assetId?: string | undefined;
  readonly children?: ReactNode;
  readonly tone?: 'default' | 'map' | 'video';
}) {
  return (
    <div className={`asset-surface asset-surface--${tone}`}>
      <Image
        src="/assets/placeholders/media-placeholder.svg"
        alt=""
        fill
        sizes="100vw"
        loading="eager"
        unoptimized
        draggable={false}
      />
      <div className="asset-surface__scan" />
      {assetId === undefined ? null : <span className="asset-surface__id">{assetId}</span>}
      {children}
    </div>
  );
}
