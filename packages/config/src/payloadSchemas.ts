import { moduleIds, type LocalizedText } from '@gremuchaya/domain';
import * as z from 'zod';

export const moduleIdSchema = z.enum(moduleIds);

const normalizedCoordinateSchema = z.number().min(0).max(1);
const nonEmptyLabelSchema = z.string().trim().min(1).max(160);

/**
 * A trimmed non-empty string, or a partial record of locale tag to trimmed
 * non-empty string -- the trust-boundary counterpart of
 * `@gremuchaya/domain`'s `LocalizedText`.
 *
 * The bare-string branch is what makes the 52 scene definitions and the
 * operations seed parse unchanged: every value they hold today is already a
 * plain string, and this union accepts it without a migration. A field
 * needs this schema only if it is prose an operator or a viewer reads; an
 * identifier (`cameraId`, `jobId`, a slate number) stays `z.string()`, because
 * there is no English side of an identifier to be missing.
 *
 * Both branches stay bounded. Three of the fields converted here were capped
 * at 160 characters before, and widening a field's type is not a reason to
 * stop bounding its length: this schema is the trust boundary for a scene
 * file, and an unbounded value reaches a tile that has to draw it. The record
 * branch needs a second bound the string branch never did -- without a cap on
 * how many locales one value may carry, a single field can hold arbitrarily
 * many keys, which is a larger hole than the one string it replaced.
 */
const localizedTextValueSchema = z.string().trim().min(1).max(600);
const localizedTextLocaleLimit = 24;
export const localizedTextSchema: z.ZodType<LocalizedText> = z.union([
  localizedTextValueSchema,
  z
    .record(z.string().trim().min(1).max(35), localizedTextValueSchema)
    .refine((value) => Object.keys(value).length <= localizedTextLocaleLimit, {
      message: `A localized value may name at most ${localizedTextLocaleLimit} locales.`,
    })
    .readonly(),
]);

export const idlePayloadSchema = z
  .object({
    preset: z.string().trim().min(1).default('hq-default'),
    title: localizedTextSchema.optional(),
    subtitle: localizedTextSchema.optional(),
  })
  .readonly();

export const mapPayloadSchema = z
  .object({
    mapAsset: z.string().trim().min(1),
    title: localizedTextSchema,
    subtitle: localizedTextSchema.optional(),
    markers: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          x: normalizedCoordinateSchema,
          y: normalizedCoordinateSchema,
          label: localizedTextSchema.optional(),
          active: z.boolean().optional(),
          pulse: z.boolean().optional(),
          heading: z.number().min(0).max(360).optional(),
        }),
      )
      .default([]),
    routes: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          points: z.array(
            z.object({ x: normalizedCoordinateSchema, y: normalizedCoordinateSchema }),
          ),
          progress: normalizedCoordinateSchema.optional(),
        }),
      )
      .optional(),
    readout: z
      .object({
        object: localizedTextSchema.optional(),
        speed: localizedTextSchema.optional(),
        signal: localizedTextSchema.optional(),
        address: localizedTextSchema.optional(),
      })
      .optional(),
  })
  .readonly();

export const satellitePayloadSchema = z
  .object({
    assetId: z.string().trim().min(1),
    mode: z.enum(['ACQUIRE', 'ZOOM', 'TRACK', 'DEGRADED', 'LOST']),
    monochrome: z.boolean().optional(),
    zoom: z.number().min(1).max(16).optional(),
    target: z
      .object({
        x: normalizedCoordinateSchema,
        y: normalizedCoordinateSchema,
        label: localizedTextSchema.optional(),
      })
      .optional(),
    coordinates: z.string().optional(),
    signalQuality: z.number().min(0).max(100).optional(),
    sensorLabel: z.string().optional(),
    lossStage: z.enum(['clean', 'light', 'heavy', 'lost']).optional(),
  })
  .readonly();

export const cctvPayloadSchema = z
  .object({
    cameraId: nonEmptyLabelSchema,
    location: localizedTextSchema,
    timestamp: nonEmptyLabelSchema,
    assetId: z.string().trim().min(1),
    archive: z.boolean().optional(),
    muted: z.boolean().optional(),
    playing: z.boolean().optional(),
    mosaic: z.array(z.string().trim().min(1)).optional(),
    selectedCamera: z.number().int().min(0).optional(),
    audioEnabled: z.boolean().optional(),
  })
  .readonly();

export const dossierPayloadSchema = z
  .object({
    entityId: z.string().trim().min(1),
    displayName: nonEmptyLabelSchema,
    fullName: z.string().optional(),
    alias: z.string().optional(),
    status: localizedTextSchema.optional(),
    category: localizedTextSchema.optional(),
    summary: localizedTextSchema.optional(),
    facts: z.array(z.string()).default([]),
    portraitAssetIds: z.array(z.string().trim().min(1)).default([]),
    relatedMaterials: z.array(z.string()).default([]),
  })
  .readonly();

export const osintPayloadSchema = z
  .object({
    query: z.string(),
    stage: z.enum(['SEARCH', 'RESULTS', 'PROFILE', 'PHOTO', 'SELECT']),
    title: localizedTextSchema,
    profileName: z.string().optional(),
    assetIds: z.array(z.string()).default([]),
    selectedAssetId: z.string().optional(),
    results: z
      .array(
        z.object({
          id: z.string(),
          title: localizedTextSchema,
          metadata: z.string(),
          assetId: z.string().optional(),
        }),
      )
      .default([]),
  })
  .readonly();

export const faceRecognitionPayloadSchema = z
  .object({
    state: z.enum(['IDLE', 'DETECT', 'COMPARE', 'MATCH', 'NO_MATCH']),
    sourceAssetId: z.string().optional(),
    archiveAssetId: z.string().optional(),
    candidateName: z.string().optional(),
    similarity: z.number().min(0).max(100).optional(),
    sourceBox: z
      .object({
        x: normalizedCoordinateSchema,
        y: normalizedCoordinateSchema,
        width: normalizedCoordinateSchema,
        height: normalizedCoordinateSchema,
      })
      .optional(),
  })
  .readonly();

export const vehicleRecognitionPayloadSchema = z
  .object({
    assetId: z.string(),
    title: localizedTextSchema,
    vehicles: z.array(
      z.object({
        id: z.string(),
        label: localizedTextSchema,
        class: z.string(),
        direction: z.string(),
        timestamp: z.string(),
        active: z.boolean(),
        x: normalizedCoordinateSchema,
        y: normalizedCoordinateSchema,
        width: normalizedCoordinateSchema,
        height: normalizedCoordinateSchema,
      }),
    ),
  })
  .readonly();

export const commsPayloadSchema = z
  .object({
    target: nonEmptyLabelSchema,
    source: localizedTextSchema,
    status: z.enum(['RINGING', 'CONNECTING', 'CONNECTED', 'ENDED']),
    intercept: z.boolean().optional(),
    duration: z.string().optional(),
    hops: z
      .array(
        z.object({
          label: localizedTextSchema,
          x: normalizedCoordinateSchema,
          y: normalizedCoordinateSchema,
        }),
      )
      .optional(),
  })
  .readonly();

export const graphPayloadSchema = z
  .object({
    title: localizedTextSchema,
    stage: z.string().optional(),
    nodes: z.array(
      z.object({
        id: z.string(),
        label: localizedTextSchema,
        // A rendering discriminant (which icon a node draws), not display
        // text on its own -- stays a literal enum so a caller can switch on
        // it, the way `apps/hq/src/screens/TacticalMapScreen.tsx` already
        // switches on the structurally identical `object.kind`.
        kind: z.enum(['phone', 'person', 'vehicle', 'location']),
        active: z.boolean().optional(),
        x: normalizedCoordinateSchema,
        y: normalizedCoordinateSchema,
      }),
    ),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        weight: z.number().optional(),
        active: z.boolean().optional(),
      }),
    ),
  })
  .readonly();

export const newsPayloadSchema = z
  .object({
    title: localizedTextSchema,
    subtitle: localizedTextSchema.optional(),
    mode: z.enum(['LIVE', 'ARCHIVE']),
    assetId: z.string().optional(),
    lowerThird: z.string().optional(),
  })
  .readonly();

export const accessPayloadSchema = z
  .object({
    title: localizedTextSchema,
    status: z.enum(['GRANTED', 'DENIED', 'PENDING']),
    subject: z.string(),
    checkpoint: z.string(),
    timestamp: z.string(),
  })
  .readonly();

export const systemTablesPayloadSchema = z
  .object({
    title: localizedTextSchema,
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number()]))),
  })
  .readonly();

export const audioPayloadSchema = z
  .object({
    channels: z.array(
      z.object({
        id: z.string(),
        label: localizedTextSchema,
        level: z.number().min(0).max(1),
        waveform: z.array(z.number().min(-1).max(1)),
      }),
    ),
    timestamp: z.string(),
    recording: z.boolean(),
  })
  .readonly();

export const photoArchivePayloadSchema = z
  .object({
    title: localizedTextSchema,
    assetIds: z.array(z.string()),
    selectedIndex: z.number().int().min(0).default(0),
    labels: z.array(z.string()).optional(),
    comparison: z.boolean().optional(),
  })
  .readonly();

export const interrogationPayloadSchema = z
  .object({
    room: z.string(),
    assetId: z.string(),
    timestamp: z.string(),
    playing: z.boolean(),
    audioChannel: z.string().optional(),
  })
  .readonly();

export const securityPayloadSchema = z
  .object({
    cameraId: z.string(),
    status: z.enum(['ONLINE', 'LINK DISABLED', 'RECONNECTING']),
    assetId: z.string().optional(),
    attempt: z.number().int().min(0).optional(),
  })
  .readonly();

export const explorerPayloadSchema = z
  .object({
    path: z.string(),
    selectedNodeId: z.string().optional(),
    takeover: z.boolean().optional(),
  })
  .readonly();

export const printPayloadSchema = z
  .object({
    jobId: z.string(),
    documentLabel: z.string(),
    status: z.enum(['QUEUED', 'SENDING', 'PRINTING', 'PRINTED', 'FAILED']),
    progress: z.number().min(0).max(100),
  })
  .readonly();

export const modulePresetSchema = z.discriminatedUnion('module', [
  z.object({ module: z.literal('idle'), payload: idlePayloadSchema }),
  z.object({ module: z.literal('map'), payload: mapPayloadSchema }),
  z.object({ module: z.literal('satellite'), payload: satellitePayloadSchema }),
  z.object({ module: z.literal('cctv'), payload: cctvPayloadSchema }),
  z.object({ module: z.literal('dossier'), payload: dossierPayloadSchema }),
  z.object({ module: z.literal('osint'), payload: osintPayloadSchema }),
  z.object({ module: z.literal('face-recognition'), payload: faceRecognitionPayloadSchema }),
  z.object({ module: z.literal('vehicle-recognition'), payload: vehicleRecognitionPayloadSchema }),
  z.object({ module: z.literal('comms'), payload: commsPayloadSchema }),
  z.object({ module: z.literal('graph'), payload: graphPayloadSchema }),
  z.object({ module: z.literal('news'), payload: newsPayloadSchema }),
  z.object({ module: z.literal('access'), payload: accessPayloadSchema }),
  z.object({ module: z.literal('system-tables'), payload: systemTablesPayloadSchema }),
  z.object({ module: z.literal('audio'), payload: audioPayloadSchema }),
  z.object({ module: z.literal('photo-archive'), payload: photoArchivePayloadSchema }),
  z.object({ module: z.literal('interrogation'), payload: interrogationPayloadSchema }),
  z.object({ module: z.literal('security'), payload: securityPayloadSchema }),
  z.object({ module: z.literal('explorer'), payload: explorerPayloadSchema }),
  z.object({ module: z.literal('print'), payload: printPayloadSchema }),
]);

export type ModulePresetConfig = z.infer<typeof modulePresetSchema>;

export const modulePayloadSchemas = {
  idle: idlePayloadSchema,
  map: mapPayloadSchema,
  satellite: satellitePayloadSchema,
  cctv: cctvPayloadSchema,
  dossier: dossierPayloadSchema,
  osint: osintPayloadSchema,
  'face-recognition': faceRecognitionPayloadSchema,
  'vehicle-recognition': vehicleRecognitionPayloadSchema,
  comms: commsPayloadSchema,
  graph: graphPayloadSchema,
  news: newsPayloadSchema,
  access: accessPayloadSchema,
  'system-tables': systemTablesPayloadSchema,
  audio: audioPayloadSchema,
  'photo-archive': photoArchivePayloadSchema,
  interrogation: interrogationPayloadSchema,
  security: securityPayloadSchema,
  explorer: explorerPayloadSchema,
  print: printPayloadSchema,
} as const satisfies Readonly<Record<(typeof moduleIds)[number], z.ZodType>>;
