import type { MaterialEntry } from './BridgeMaterialClient';
import {
  materialPreviewLimits,
  readMaterialBlob,
  type MaterialChunkReader,
} from './MaterialPreviewReader';

export type MaterialTransport = 'BOUNDED_BLOB' | 'RANGE_GRANT';

export interface ResolvedMaterialSource {
  readonly url: string;
  readonly transport: MaterialTransport;
}

export interface MaterialPlaybackGrant {
  readonly grantId: string;
  readonly url: string;
}

export interface MaterialSourceClient extends MaterialChunkReader {
  getPlaybackGrant(material: MaterialEntry, signal?: AbortSignal): Promise<MaterialPlaybackGrant>;
  revokePlaybackGrant(grantId: string, signal?: AbortSignal): Promise<boolean>;
}

export interface MaterialSourceHandle {
  readonly opened: Promise<ResolvedMaterialSource>;
  /** Idempotent, and safe to call before `opened` settles. */
  release(): void;
}

/**
 * Turns a material into something an `<img>`, `<video>` or CSS `url()` can
 * point at, and hands back the one function that undoes it.
 *
 * Two transports, chosen by size. Below the bounded preview limit the bytes are
 * read into a blob, which needs no server-side state. Above it the bridge
 * issues a range-streaming grant instead: pulling tens of megabytes into memory
 * to show a background would defeat the point of streaming them.
 *
 * Both transports leak if nobody undoes them -- an object URL pins its blob for
 * the life of the document, and a grant stays open on the bridge -- and the
 * callers are React effects that are routinely torn down mid-read. So release
 * is part of the handle rather than the caller's problem, and calling it early
 * is normal: the resource is freed as soon as it exists.
 */
export function openMaterialSource(
  client: MaterialSourceClient,
  material: MaterialEntry,
  signal?: AbortSignal,
): MaterialSourceHandle {
  let released = false;
  let revoke: (() => void) | undefined;

  const release = () => {
    released = true;
    const pending = revoke;
    revoke = undefined;
    pending?.();
  };

  const opened = (async (): Promise<ResolvedMaterialSource> => {
    if (material.byteSize <= BigInt(materialPreviewLimits.binaryBytes)) {
      const blob = await readMaterialBlob(client, material, signal);
      const url = URL.createObjectURL(blob);
      revoke = () => URL.revokeObjectURL(url);
      if (released) release();
      return { url, transport: 'BOUNDED_BLOB' };
    }

    const grant = await client.getPlaybackGrant(material, signal);
    revoke = () => void client.revokePlaybackGrant(grant.grantId).catch(() => undefined);
    if (released) release();
    return { url: grant.url, transport: 'RANGE_GRANT' };
  })();

  return { opened, release };
}
