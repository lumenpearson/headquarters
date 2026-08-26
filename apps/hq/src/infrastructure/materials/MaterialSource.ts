import type { MaterialEntry } from './BridgeMaterialClient';
import type { MaterialLibraryClient, MaterialRendition } from './materialLibrary';
import {
  materialPreviewLimits,
  readMaterialBlob,
  type MaterialChunkReader,
} from './MaterialPreviewReader';

export type MaterialTransport = 'BOUNDED_BLOB' | 'RANGE_GRANT';

export interface ResolvedMaterialSource {
  readonly url: string;
  readonly transport: MaterialTransport;
  /** The variant that was asked for; empty for the stored object. */
  readonly variant: string;
  /** Whether the library answered with something other than the stored object. */
  readonly rendered: boolean;
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
      return { url, transport: 'BOUNDED_BLOB', variant: '', rendered: false };
    }

    const grant = await client.getPlaybackGrant(material, signal);
    revoke = () => void client.revokePlaybackGrant(grant.grantId).catch(() => undefined);
    if (released) release();
    return { url: grant.url, transport: 'RANGE_GRANT', variant: '', rendered: false };
  })();

  return { opened, release };
}

/**
 * The same, for one named rendition of a material (R21).
 *
 * The original goes through `openMaterialSource` unchanged -- for a small file
 * the blob is still the transport that needs no server-side state. Anything
 * else is opened through its grant and never as a blob: the blob path streams
 * the stored object, so reading a rendition that way would serve the original
 * under the rendition's name, which is the one failure a quality menu must not
 * have.
 */
export function openMaterialRendition(
  client: MaterialLibraryClient,
  material: MaterialEntry,
  rendition: MaterialRendition,
  signal?: AbortSignal,
): MaterialSourceHandle {
  if (rendition.variant.length === 0) return openMaterialSource(client, material, signal);

  let released = false;
  let revoke: (() => void) | undefined;
  const release = () => {
    released = true;
    const pending = revoke;
    revoke = undefined;
    pending?.();
  };

  const opened = (async (): Promise<ResolvedMaterialSource> => {
    const source = await client.openRendition(material, rendition, signal);
    revoke = () => void client.revokePlaybackGrant(source.grantId).catch(() => undefined);
    if (released) release();
    return {
      url: source.url,
      transport: 'RANGE_GRANT',
      variant: source.variant,
      rendered: source.rendered,
    };
  })();

  return { opened, release };
}
