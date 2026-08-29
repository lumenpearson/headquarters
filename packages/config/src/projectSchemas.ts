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

/**
 * One control-plane address.
 *
 * Split out of {@link projectConfigSchema} because the field now holds either a
 * single address or a list of them and both branches have to enforce exactly
 * the same rule; two copies of the refinement would be two places for "no
 * credentials in the URL" to drift apart.
 */
const controlPlaneAddressSchema = z.url().refine((value) => {
  // `new URL` can still throw on strings `z.url()` accepts, and Zod does not
  // turn an exception inside `.refine` into a validation issue -- it escapes
  // `safeParse` as a crash. A throwing value is a failing value.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === ''
  );
}, 'Control plane URL must be an http(s) URL without credentials');

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
    // Same contract as controlPlaneAddressSchema: a throwing value fails.
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  }, 'Bridge URL must resolve to localhost'),
  bridgeTransport: z.literal('grpc-web').default('grpc-web'),
  /**
   * Where the control plane answers, when this client is meant to join a group.
   *
   * An empty list means local-only: no client is built and no request leaves
   * the machine. Unlike `bridgeUrl` these may name any host, because on a shoot
   * day the control plane is one machine on the set's LAN and every other
   * screen pairs with it over that network. The trust that follows is
   * deliberate and has to be known: the pairing code and the tokens it earns
   * travel to whatever these URLs name, so the addresses come from the project
   * configuration an operator controls, never from a query string or a page.
   * `https` is accepted and `http` is not refused, since a LAN with no
   * certificate authority is the normal case there; the tokens are then
   * protected only by the network they cross.
   *
   * **A list, because one group may be reachable two ways at once** (F14,
   * stage 7). A control plane on the set's LAN and one deployed to the public
   * internet in front of *the same database* are two addresses for one group:
   * the near one answers in milliseconds over a socket, the far one on a poll
   * cadence, and a screen on the LAN holds both so that the group behaves the
   * same for everybody in it. Order is the operator's statement of preference
   * and the only thing that ranks the addresses -- there is no discovery on the
   * LAN and there is not going to be one, so the near plane is the one the
   * operator writes first.
   *
   * **The singular key is kept on purpose.** A bare string is accepted and read
   * as a list of one, because `project.override.json` on a shoot machine
   * already carries `controlPlaneUrl` as a string, and an object schema strips
   * a key it does not know: renaming the field would make that override
   * silently do nothing, which is the worst way for a shoot-day file to fail.
   * Absent, one address and several therefore all parse, and the first two
   * behave exactly as they did before this field could hold more than one.
   *
   * The ceiling of four is not a guess about topology: every address costs a
   * client, a probe and -- where the plane serves no socket -- a poll on a
   * metered invocation budget, so a mistyped list must not be able to spend it.
   */
  controlPlaneUrl: z
    .union([controlPlaneAddressSchema, z.array(controlPlaneAddressSchema).max(4)])
    .transform((value) => (typeof value === 'string' ? [value] : value))
    .refine(
      (value) => new Set(value).size === value.length,
      'Control plane URLs must not repeat an address',
    )
    .default([]),
  screenWindows: z.array(screenWindowSchema),
  virtualMountRules: z.array(virtualMountRuleSchema),
  fileDisplayOverrides: z.array(fileDisplayOverrideSchema),
  freezeActiveMediaOnSourceChange: z.boolean(),
  maxTextPreviewBytes: z.number().int().positive(),
});

export const productionOverrideSchema = z.object({
  version: z.literal(1),
  /**
   * The project-configuration fields this shoot machine overrides.
   *
   * Scalars, and one array of strings: `controlPlaneUrl` may name more than one
   * address (F14, stage 7), and the override file is where an operator names
   * the second one. Arrays of objects are still out -- `screenWindows` and the
   * explorer rules are structures the override was never meant to carry -- and
   * the result is re-parsed by `projectConfigSchema`, which is what actually
   * decides whether a value belongs in the field it was written for.
   */
  values: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    )
    .default({}),
  assetOverrides: z
    .record(
      z.string(),
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('static'), url: z.string().min(1) }),
        z.object({ kind: z.literal('projected-file'), virtualPath: virtualPathSchema }),
        z.object({ kind: z.literal('emulated'), renderer: z.string().min(1) }),
      ]),
    )
    .default({}),
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
