import type {
  MaterialEntry,
  MaterialImportProgress,
  MaterialImportResult,
  MaterialPage,
} from './BridgeMaterialClient';
import type { MaterialSourceClient } from './MaterialSource';

/**
 * Which library holds a material's bytes.
 *
 * Not a cosmetic label: the two answer different questions. The loopback
 * mirror is content on this machine and needs no group; the group library is
 * content the whole shoot shares and needs an admitted session. A surface that
 * prints one when it is reading the other tells the operator the wrong thing
 * about where a file went.
 */
export type MaterialOrigin = 'local-mirror' | 'group-library';

/** How the operator reads each origin, in the shell's Latin eyebrow register. */
export function materialOriginLabel(origin: MaterialOrigin): string {
  return origin === 'group-library' ? 'GROUP LIBRARY' : 'LOCAL MIRROR';
}

/**
 * One rendition of a material, as the quality menu offers it.
 *
 * `variant` is the string `GetPreviewGrant.variant` carries -- the only
 * rendition selector the material contract has. The empty string asks for the
 * stored object, which is also what a library with no rendition ladder can
 * ever answer.
 */
export interface MaterialRendition {
  readonly variant: string;
  readonly label: string;
}

/** The stored object, which every library can serve. */
export const originalRendition: MaterialRendition = { variant: '', label: 'ORIGINAL' };

/**
 * A rendition opened for playback, and what the server actually answered with.
 *
 * `rendered` is the honest half. No deployment in this repository builds a
 * rendition ladder -- `s3-grant-issuer.ts`'s `issuePreview` presigns the same
 * object for every variant and says so by reporting the original's MIME type --
 * so a menu that simply switched sources would be a control that changes
 * nothing, which is the C25 failure repeated one screen over. The flag lets the
 * surface print what came back instead of implying a rendition exists.
 */
export interface MaterialRenditionSource {
  readonly grantId: string;
  readonly url: string;
  readonly mimeType: string;
  readonly variant: string;
  readonly rendered: boolean;
}

/**
 * What a screen needs of a material library, whichever one is behind it.
 *
 * `FilesScreen` and `VideoScreen` hold this and never the concrete client, so
 * the choice between the loopback bridge and the control plane is taken once,
 * in `selectMaterialLibrary`, instead of once per screen.
 */
export interface MaterialLibraryClient extends MaterialSourceClient {
  readonly origin: MaterialOrigin;
  /**
   * The same library, declaring the operator's category on what it imports next.
   *
   * A method rather than an argument on `importFile` because the two libraries
   * disagree about where a category belongs: `MaterialService.BeginUpload`
   * carries one on the wire, `FileBridgeService.BeginMaterialImport` has no
   * field for it at all. The bridge therefore answers with itself, and the
   * category is kept where it is true of both -- the store's import record.
   */
  withCategory(category: string): MaterialLibraryClient;
  importFile(
    file: File,
    onProgress?: (progress: MaterialImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<MaterialImportResult>;
  list(cursor?: string, pageSize?: number, signal?: AbortSignal): Promise<MaterialPage>;
  /** The renditions this library can be asked for, original first. */
  renditions(material: MaterialEntry): readonly MaterialRendition[];
  openRendition(
    material: MaterialEntry,
    rendition: MaterialRendition,
    signal?: AbortSignal,
  ): Promise<MaterialRenditionSource>;
}

export interface MaterialLibrarySelection {
  /** The loopback mirror, which is always available and never needs a group. */
  readonly bridge: MaterialLibraryClient;
  /** Built by `GroupChannelRuntime` while a group is joined; `null` otherwise. */
  readonly group: MaterialLibraryClient | null;
  /** `connection.mode`, as `ControlPlaneSession` last left it. */
  readonly online: boolean;
  /** `GetCapabilities` answered `materials` enabled. */
  readonly materialsCapability: boolean;
}

/**
 * Which library this session reads and writes.
 *
 * The group library is chosen only when all three hold: the session is
 * admitted (`connection.mode === 'online'`), the control plane answered
 * `GetCapabilities` with `materials` enabled, and a group client was actually
 * built. Anything else -- `general.localOnly`, no configured address, a
 * control plane without the collaborator, a session between refreshes, a
 * deployment whose bucket is unconfigured -- is the loopback bridge, which
 * needs no group and no network beyond this machine.
 *
 * Stated once, as a pure function over four facts, because the alternative is
 * the same condition written out in two screens and drifting between them.
 */
export function selectMaterialLibrary(selection: MaterialLibrarySelection): MaterialLibraryClient {
  if (selection.online && selection.materialsCapability && selection.group !== null) {
    return selection.group;
  }
  return selection.bridge;
}

/**
 * The ladder a library can be asked for, given what the material declares.
 *
 * These are requests, not promises. The contract offers one free-form
 * `variant` string and no way to enumerate what a deployment has built, so the
 * client can only name renditions it would accept; whether one exists is
 * something only the returned grant can say. The names are the ones an
 * operator already reads on the overlay -- a picture height for video, a
 * thumbnail for a still -- rather than invented identifiers.
 */
export function renditionsForMaterial(material: MaterialEntry): readonly MaterialRendition[] {
  const mimeType = material.mimeType.toLocaleLowerCase('en-US');
  if (mimeType.startsWith('video/')) {
    return [
      originalRendition,
      { variant: '1080p', label: '1080P' },
      { variant: '720p', label: '720P' },
      { variant: '480p', label: '480P' },
    ];
  }
  if (mimeType.startsWith('image/')) {
    return [originalRendition, { variant: 'thumbnail', label: 'THUMBNAIL' }];
  }
  return [originalRendition];
}

/**
 * The rendition a camera's own declaration asks for (R21, C25).
 *
 * `Camera.codec` and `Camera.bitrate` were declared in the domain and printed
 * on the overlay while no playback call read either, so choosing a camera with
 * a different codec changed nothing about what streamed. This turns the two
 * fields into the one thing the material contract can carry them in: a
 * `GetPreviewGrant.variant`. It reaches the server on every grant request for
 * a material-backed camera.
 *
 * It reaches only material-backed cameras. `GetPreviewGrantRequest` addresses a
 * material by id and a version by id and has no other selector, so a camera
 * served by the native RTSP gateway or by the demo loop has nothing to name in
 * such a request -- there is no material behind it -- and its declared codec
 * and bitrate stay what they have always been there: text on the overlay.
 * Closing that would take a field on the stream contract the gateway serves,
 * which `material.proto` is not.
 *
 * `null` when the camera declares neither, so the menu shows no empty entry.
 */
export function cameraDeclaredRendition(codec: string, bitrate: string): MaterialRendition | null {
  const tokens = [codec, bitrate].map(toVariantToken).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const declared = [codec, bitrate]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return { variant: tokens.join('@'), label: `DECLARED ${declared.join(' / ')}` };
}

function toVariantToken(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
}
