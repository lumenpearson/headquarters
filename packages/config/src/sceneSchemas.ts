import {
  createAssetId,
  createSceneId,
  createVirtualPath,
  screenIds,
  type SceneDefinition,
} from '@gremuchaya/domain';
import * as z from 'zod';

import { moduleIdSchema, modulePayloadSchemas, modulePresetSchema } from './payloadSchemas.js';

export const screenIdSchema = z.enum(screenIds);
export const sceneIdSchema = z
  .string()
  .regex(/^s\d{2}-\d{1,3}[a-z]?$/u)
  .transform(createSceneId);
export const assetIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .transform(createAssetId);

const modulePayloadRecordSchema = z.record(z.string(), z.unknown()).readonly();

export const cueActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SET_MODULE'),
    screenId: screenIdSchema,
    module: moduleIdSchema,
    payload: modulePayloadRecordSchema,
  }),
  z.object({
    type: z.literal('PATCH_MODULE'),
    screenId: screenIdSchema,
    payload: modulePayloadRecordSchema,
  }),
  z.object({
    type: z.literal('PLAY_MEDIA'),
    screenId: screenIdSchema,
    assetId: assetIdSchema,
    loop: z.boolean().default(false),
  }),
  z.object({ type: z.literal('PAUSE_MEDIA'), screenId: screenIdSchema }),
  z.object({ type: z.literal('SET_WALL_PRESET'), wallId: z.string().min(1) }),
  z.object({
    type: z.literal('SET_BLACKOUT'),
    screenId: screenIdSchema.optional(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('SET_STANDBY'),
    screenId: screenIdSchema.optional(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('SHOW_GLITCH'),
    screenId: screenIdSchema,
    strength: z.number().min(0).max(1),
    durationMs: z.number().int().min(16).max(10_000),
  }),
  z.object({
    type: z.literal('FREEZE'),
    screenId: screenIdSchema.optional(),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal('SET_OPERATOR_NOTE'), text: z.string().max(500) }),
  z.object({
    type: z.literal('EXPLORER_NAVIGATE'),
    path: z.string().min(1).transform(createVirtualPath),
  }),
  z.object({ type: z.literal('EXPLORER_OPEN'), nodeId: z.string().min(1) }),
  z.object({ type: z.literal('WORKSPACE_FOCUS'), documentId: z.string().min(1) }),
  z.object({
    type: z.literal('APPLY_INFORMATION_PRESET'),
    presetId: z.string().min(1),
    screenId: screenIdSchema,
  }),
  z.object({
    type: z.literal('SEND_DOCUMENT_TO_SCREEN'),
    documentId: z.string().min(1),
    screenId: screenIdSchema,
  }),
]);

export const sceneCueSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(200),
    atMs: z.number().int().nonnegative().optional(),
    action: cueActionSchema,
  })
  .readonly();

export const sceneDefinitionSchema = z
  .object({
    id: sceneIdSchema,
    episode: z.number().int().nonnegative(),
    scene: z.string().trim().min(1),
    shootDate: z.iso.date(),
    title: z.string().trim().min(1).max(200),
    location: z.enum(['HQ', 'KIRILLOV', 'INTERROGATION', 'OTHER']),
    sourceLevel: z.enum(['kpp', 'script', 'derived']),
    description: z.string().trim().min(1),
    screens: z.partialRecord(screenIdSchema, modulePresetSchema),
    cues: z.array(sceneCueSchema),
    requiredScreens: z.array(screenIdSchema).default([]),
    optionalScreens: z.array(screenIdSchema).default([]),
    requiredAssetIds: z.array(assetIdSchema).default([]),
    optionalAssetIds: z.array(assetIdSchema).default([]),
    notes: z.array(z.string()).default([]),
  })
  .check((context) => {
    const cueIds = new Set<string>();
    for (const cue of context.value.cues) {
      if (cueIds.has(cue.id)) {
        context.issues.push({
          code: 'custom',
          input: cue.id,
          message: `Duplicate cue id: ${cue.id}`,
          path: ['cues'],
        });
      }
      cueIds.add(cue.id);

      if (cue.action.type === 'SET_MODULE') {
        const result = modulePayloadSchemas[cue.action.module].safeParse(cue.action.payload);
        if (!result.success) {
          context.issues.push({
            code: 'custom',
            input: cue.action.payload,
            message: `Invalid ${cue.action.module} payload in cue ${cue.id}: ${z.prettifyError(result.error)}`,
            path: ['cues', cue.id, 'action', 'payload'],
          });
        }
      }
    }

    const overlap = context.value.requiredScreens.filter((screenId) =>
      context.value.optionalScreens.includes(screenId),
    );
    if (overlap.length > 0) {
      context.issues.push({
        code: 'custom',
        input: overlap,
        message: `Screens cannot be both required and optional: ${overlap.join(', ')}`,
        path: ['requiredScreens'],
      });
    }
  });

export type SceneDefinitionConfig = z.infer<typeof sceneDefinitionSchema>;
export type SceneDefinitionInput = z.input<typeof sceneDefinitionSchema>;

export function parseSceneDefinition(input: unknown): SceneDefinition {
  return sceneDefinitionSchema.parse(input);
}

export function parseSceneCatalog(input: unknown): readonly SceneDefinition[] {
  const scenes = z.array(sceneDefinitionSchema).parse(input);
  const sceneIds = new Set<string>();
  for (const scene of scenes) {
    if (sceneIds.has(scene.id)) {
      throw new Error(`Duplicate scene id: ${scene.id}`);
    }
    sceneIds.add(scene.id);
  }
  return scenes;
}
