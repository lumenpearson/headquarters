/**
 * The quality ladder: which renditions a stored object may be asked for, and
 * exactly how each one is produced.
 *
 * This module is the server's half of a agreement the client already keeps.
 * `apps/hq/src/infrastructure/materials/materialLibrary.ts` offers `1080p`,
 * `720p` and `480p` for a video and `thumbnail` for a still, and sends the
 * chosen name in `GetPreviewGrant.variant`. Until now nothing on this side knew
 * what those four words meant, so `issuePreview` signed the original object for
 * every one of them and the menu printed «ВАРИАНТ НЕ СОБРАН — ОТДАН ОРИГИНАЛ».
 * The names here are those names, spelled the same way, because a ladder whose
 * rungs the client cannot ask for is not a ladder.
 *
 * Three properties are deliberate.
 *
 * **The ladder never upscales.** Every video rung scales to
 * `min(target, source)` height, so a 480p source asked for `1080p` produces a
 * 480p-tall object rather than a blurred enlargement four times its size. The
 * dimensions recorded against the rendition are then *measured* from the output
 * rather than copied from this table -- see the renderer -- so a grant reports
 * what the file is, not what was asked for.
 *
 * **The arguments are a fixed list, never a string.** Nothing a client sends
 * reaches ffmpeg: the variant name selects a rung by exact match against this
 * table and is never interpolated into an argument. A variant that is not a
 * rung has no conversion at all, which is what keeps `GetPreviewGrant` from
 * being a way to run a process of the caller's choosing.
 *
 * **A rung declares its own container and codec.** `mimeType` is what the
 * preview grant reports and what the client uses to decide that it received a
 * built variant rather than the original, so it has to be the type of the file
 * the arguments actually produce.
 */

/** One rung: a name the contract carries and the exact command that fills it. */
export interface RenditionSpec {
  /** The `GetPreviewGrant.variant` string this rung answers, matched exactly. */
  readonly variant: string;
  /** The type of the object the arguments produce, reported by the grant. */
  readonly mimeType: string;
  /** The file extension the rendition's storage key ends in. */
  readonly extension: string;
  /**
   * The tallest picture this rung produces. It is a ceiling, not a target: the
   * scale filter takes `min(this, source height)`, so a smaller source passes
   * through at its own size.
   */
  readonly maxHeight: number;
  /**
   * The ffmpeg arguments between the input and the output path, as a fixed
   * list. No element is ever built from request data.
   */
  readonly ffmpegArguments: readonly string[];
}

/**
 * The width filter every video rung shares.
 *
 * `-2` on the width keeps the source aspect ratio and rounds to an even number,
 * which H.264 requires of both dimensions. `min(H,ih)` is the no-upscale rule.
 */
function videoScale(maxHeight: number): string {
  return `scale=-2:'min(${maxHeight.toString()},ih)'`;
}

function videoRung(variant: string, maxHeight: number): RenditionSpec {
  return {
    variant,
    mimeType: 'video/mp4',
    extension: 'mp4',
    maxHeight,
    ffmpegArguments: [
      '-vf',
      videoScale(maxHeight),
      // Constant-quality H.264 rather than a fixed bitrate: the ladder's rungs
      // differ by picture size, and a fixed bitrate would make a short static
      // shot and a fast-moving one cost the same while looking nothing alike.
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      // 4:2:0 with even dimensions is what every browser decoder and every
      // WebView2 build accepts; ffmpeg would otherwise keep a source's 4:2:2.
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      // The index at the front, so a preview can start playing before the
      // whole object has been fetched from the bucket.
      '-movflags',
      '+faststart',
    ],
  };
}

const imageThumbnail: RenditionSpec = {
  variant: 'thumbnail',
  mimeType: 'image/jpeg',
  extension: 'jpg',
  maxHeight: 320,
  ffmpegArguments: ['-vf', videoScale(320), '-frames:v', '1', '-q:v', '4'],
};

const videoLadder: readonly RenditionSpec[] = [
  videoRung('1080p', 1080),
  videoRung('720p', 720),
  videoRung('480p', 480),
];

const imageLadder: readonly RenditionSpec[] = [imageThumbnail];

/**
 * The rungs declared for a stored object's own type.
 *
 * The empty list is a real answer and the common one: a document, an archive or
 * an `application/octet-stream` has no ladder, so nothing is ever queued for it
 * and `GetPreviewGrant` keeps serving the original for any variant. The match
 * is on the type's family rather than its exact value because a container is
 * named a dozen ways -- `video/quicktime`, `video/x-matroska`, `video/mp4` --
 * and ffmpeg reads all of them by inspection rather than by declaration.
 */
export function renditionLadderFor(mimeType: string): readonly RenditionSpec[] {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith('video/')) return videoLadder;
  if (normalized.startsWith('image/')) return imageLadder;
  return [];
}

/** The rung a variant names, or `undefined` when the type has no such rung. */
export function renditionSpecFor(mimeType: string, variant: string): RenditionSpec | undefined {
  return renditionLadderFor(mimeType).find((spec) => spec.variant === variant);
}

/**
 * Where a rendition's bytes live.
 *
 * Keyed by the *source content hash* rather than by the version id, for the
 * same reason `material_objects` is: two materials that deduplicated onto one
 * object would otherwise transcode the identical bytes twice and store two
 * identical results. The variant and the extension are appended from the rung's
 * own table, never from request data, so no caller can steer the key.
 */
export function renditionStorageKeyFor(
  groupId: string,
  contentHash: string,
  spec: RenditionSpec,
): string {
  return `renditions/${groupId}/${contentHash}/${spec.variant}.${spec.extension}`;
}
