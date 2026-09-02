import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import {
  materialPreviewLimits,
  readMaterialText,
  type MaterialPreviewLimits,
} from '@/infrastructure/materials/MaterialPreviewReader';
import type { MaterialLibraryClient } from '@/infrastructure/materials/materialLibrary';

/** One subtitle track ready for `<Track>`: a `text/vtt` blob URL, never a raw path. */
export interface MaterialSubtitleTrack {
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly srcLang: string;
  readonly default: boolean;
}

/**
 * `clip.vtt` (no language) or `clip.en.vtt` / `clip.ru-RU.vtt` (BCP 47-ish
 * language tag before the extension) -- the naming convention an operator
 * already uses for sidecar subtitle files outside this app.
 */
const subtitleFileNamePattern = /^(?<stem>.+?)(?:\.(?<lang>[a-z]{2,3}(?:-[a-z]{2})?))?\.vtt$/iu;

export function materialStem(displayName: string): string {
  const dot = displayName.lastIndexOf('.');
  return dot > 0 ? displayName.slice(0, dot) : displayName;
}

/**
 * Finds and reads a video material's companion WebVTT tracks, from the same
 * library `material` came from.
 *
 * The read path is the one the text preview already trusts --
 * `readMaterialText`, bounded by `materials.textPreviewLimitMb` -- so a
 * subtitle file is never streamed unbounded or read through a raw filesystem
 * or bridge URL handed straight to `<Track src>`. A companion above the limit,
 * or one that fails to read, is skipped: the video is still playable without it.
 *
 * Bounded to one page of the library's listing (the same page size the
 * library's own screens page by) rather than every page that exists -- a
 * shoot's subtitle companions sit beside their video in import order, and
 * scanning an entire library on every preview open would cost more than the
 * feature is worth.
 */
export async function findMaterialSubtitleTracks(
  client: MaterialLibraryClient,
  material: MaterialEntry,
  signal?: AbortSignal,
  limits: MaterialPreviewLimits = materialPreviewLimits,
): Promise<readonly MaterialSubtitleTrack[]> {
  if (!material.mimeType.toLocaleLowerCase('en-US').startsWith('video/')) return [];
  const stem = materialStem(material.displayName).toLocaleLowerCase('en-US');
  if (stem.length === 0) return [];

  let candidates: readonly MaterialEntry[];
  try {
    candidates = (await client.list(undefined, 200, signal)).materials;
  } catch {
    return [];
  }

  const matches = candidates
    .filter((entry) => entry.materialId !== material.materialId)
    .flatMap((entry) => {
      const match = subtitleFileNamePattern.exec(entry.displayName);
      const matchedStem = match?.groups?.stem;
      if (matchedStem === undefined) return [];
      if (matchedStem.toLocaleLowerCase('en-US') !== stem) return [];
      return [{ entry, lang: match?.groups?.lang ?? '' }];
    });

  const tracks: MaterialSubtitleTrack[] = [];
  for (const { entry, lang } of matches) {
    if (signal?.aborted === true) break;
    if (entry.byteSize > BigInt(limits.textBytes)) continue;
    try {
      const content = await readMaterialText(client, entry, signal, limits);
      tracks.push({
        id: entry.materialId,
        url: URL.createObjectURL(new Blob([content], { type: 'text/vtt' })),
        label: lang.length > 0 ? lang.toLocaleUpperCase('en-US') : 'SUBTITLES',
        srcLang: lang.length > 0 ? lang : 'en',
        // The first companion that actually resolves, not the first match --
        // a candidate that fails this same bounded read is skipped above and
        // must not leave every resolved track un-default.
        default: tracks.length === 0,
      });
    } catch {
      // A companion that fails the same bounded read the text preview uses is
      // skipped, not surfaced as a player error.
    }
  }
  return tracks;
}

/** Blob URLs pin their bytes for the life of the document until revoked. */
export function releaseMaterialSubtitleTracks(tracks: readonly MaterialSubtitleTrack[]): void {
  for (const track of tracks) URL.revokeObjectURL(track.url);
}
