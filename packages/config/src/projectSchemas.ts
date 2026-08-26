import { screenIds } from '@gremuchaya/domain';
import * as z from 'zod';

import {
  fileDisplayOverrideSchema,
  virtualMountRuleSchema,
  virtualPathSchema,
} from './explorerSchemas.js';
import { assetIdSchema, sceneIdSchema, screenIdSchema } from './sceneSchemas.js';

export const assetLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('static'), url: z.string().min(1) }),
  z.object({ kind: z.literal('projected-file'), nodeId: z.string().min(1) }),
  z.object({ kind: z.literal('emulated'), renderer: z.string().min(1) }),
]);

export const assetDefinitionSchema = z.object({
  id: assetIdSchema,
  type: z.enum(['image', 'video', 'audio', 'map', 'font', 'document']),
  status: z.enum(['placeholder', 'approved', 'final', 'missing']),
  location: assetLocationSchema,
  expectedMimeType: z.string().min(1),
  notes: z.string().optional(),
});

export const assetManifestSchema = z
  .object({
    version: z.literal(1),
    assets: z.array(assetDefinitionSchema),
  })
  .check((context) => {
    const ids = new Set<string>();
    for (const asset of context.value.assets) {
      if (ids.has(asset.id)) {
        context.issues.push({
          code: 'custom',
          input: asset.id,
          message: `Duplicate asset id: ${asset.id}`,
          path: ['assets'],
        });
      }
      ids.add(asset.id);
    }
  });

export const screenWindowSchema = z.object({
  screenId: screenIdSchema,
  monitorIndex: z.number().int().nonnegative(),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fullscreen: z.boolean().default(true),
});

export const projectConfigSchema = z.object({
  version: z.literal(1),
  projectName: z.string().min(1),
  buildId: z.string().min(1),
  runtimeMode: z.enum(['production', 'rehearsal', 'development']),
  developerAccessCode: z.string().regex(/^\d{4,12}$/u),
  defaultSceneId: sceneIdSchema.optional(),
  defaultWallPreset: z.string().min(1),
  fixedClock: z.string().regex(/^\d{2}:\d{2}:\d{2}$/u),
  bridgeUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  }, 'Bridge URL must resolve to localhost'),
  bridgeTransport: z.literal('grpc-web').default('grpc-web'),
  /**
   * Where the control plane answers, when this client is meant to join a group.
   *
   * Absent means local-only: no client is built and no request leaves the
   * machine. Unlike `bridgeUrl` this may name any host, because on a shoot day
   * the control plane is one machine on the set's LAN and every other screen
   * pairs with it over that network. The trust that follows is deliberate and
   * has to be known: the pairing code and the tokens it earns travel to
   * whatever this URL names, so the address comes from the project
   * configuration an operator controls, never from a query string or a page.
   * `https` is accepted and `http` is not refused, since a LAN with no
   * certificate authority is the normal case there; the tokens are then
   * protected only by the network they cross.
   */
  controlPlaneUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === ''
      );
    }, 'Control plane URL must be an http(s) URL without credentials')
    .optional(),
  screenWindows: z.array(screenWindowSchema),
  virtualMountRules: z.array(virtualMountRuleSchema),
  fileDisplayOverrides: z.array(fileDisplayOverrideSchema),
  freezeActiveMediaOnSourceChange: z.boolean(),
  maxTextPreviewBytes: z.number().int().positive(),
});

export const productionOverrideSchema = z.object({
  version: z.literal(1),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  assetOverrides: z.record(
    z.string(),
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('static'), url: z.string().min(1) }),
      z.object({ kind: z.literal('projected-file'), virtualPath: virtualPathSchema }),
      z.object({ kind: z.literal('emulated'), renderer: z.string().min(1) }),
    ]),
  ),
});

export const informationStatePresetSchema = z.object({
  id: z.string().min(1),
  module: z.enum(['satellite', 'comms', 'security', 'cctv', 'explorer']),
  label: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export const developerImportSchema = z.object({
  version: z.literal(1),
  stateOverrides: z.record(z.string(), z.record(z.string(), z.unknown())),
  entityOverrides: z.record(z.string(), z.record(z.string(), z.unknown())),
  assetOverrides: productionOverrideSchema.shape.assetOverrides,
  presets: z.array(informationStatePresetSchema),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ProductionOverride = z.infer<typeof productionOverrideSchema>;
export type AssetManifest = z.infer<typeof assetManifestSchema>;
export type DeveloperImport = z.infer<typeof developerImportSchema>;

export const defaultScreenWindows = screenIds.map((screenId, monitorIndex) => ({
  screenId,
  monitorIndex,
  fullscreen: true,
}));
