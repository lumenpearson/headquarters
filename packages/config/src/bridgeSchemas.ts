import * as z from 'zod';

import { virtualPathSchema } from './explorerSchemas.js';

export const bridgeMountConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  label: z.string().min(1),
  root: z.string().min(1),
  virtualPath: virtualPathSchema,
});

export const bridgeConfigSchema = z
  .object({
    version: z.literal(1),
    transport: z.literal('grpc-web').default('grpc-web'),
    port: z.number().int().min(1024).max(65_535),
    /** A bridge is read-only unless a loopback operator explicitly enables imports. */
    readOnly: z.boolean().default(true),
    allowedOrigins: z.array(
      z.url().refine((value) => {
        const url = new URL(value);
        return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      }, 'Only localhost origins are allowed'),
    ),
    mounts: z.array(bridgeMountConfigSchema),
    stableFile: z.object({
      probeIntervalMs: z.number().int().min(50).max(2_000),
      timeoutMs: z.number().int().min(500).max(120_000),
    }),
    watchDebounceMs: z.number().int().min(25).max(1_000),
    materialImport: z
      .object({
        enabled: z.boolean().default(false),
        maxFileBytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024 * 1024)
          .default(5 * 1024 * 1024 * 1024),
        chunkSizeBytes: z
          .number()
          .int()
          .min(64 * 1024)
          .max(16 * 1024 * 1024)
          .default(1024 * 1024),
      })
      .default({
        enabled: false,
        maxFileBytes: 5 * 1024 * 1024 * 1024,
        chunkSizeBytes: 1024 * 1024,
      }),
  })
  .superRefine((config, context) => {
    if (config.materialImport.enabled && config.readOnly) {
      context.addIssue({
        code: 'custom',
        path: ['materialImport', 'enabled'],
        message: 'Material imports require readOnly to be false.',
      });
    }
  });

export const bridgeHealthSchema = z.object({
  service: z.literal('gremuchaya-file-bridge'),
  protocolVersion: z.literal(2),
  status: z.literal('ok'),
  startedAt: z.iso.datetime(),
  transport: z.literal('grpc-web+protobuf'),
});

export const bridgeEntrySchema = z.object({
  name: z.string(),
  path: virtualPathSchema,
  kind: z.enum(['file', 'directory']),
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  modifiedAt: z.iso.datetime(),
});

export const bridgeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FILE_ADDED'), mountId: z.string(), path: virtualPathSchema }),
  z.object({ type: z.literal('FILE_CHANGED'), mountId: z.string(), path: virtualPathSchema }),
  z.object({ type: z.literal('FILE_REMOVED'), mountId: z.string(), path: virtualPathSchema }),
  z.object({ type: z.literal('DIRECTORY_CHANGED'), mountId: z.string(), path: virtualPathSchema }),
  z.object({ type: z.literal('FILE_READY'), mountId: z.string(), path: virtualPathSchema }),
]);

export const nativeMonitorSchema = z.object({
  name: z.string().nullable(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scaleFactor: z.number().positive(),
  primary: z.boolean(),
});

export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export type BridgeHealth = z.infer<typeof bridgeHealthSchema>;
export type BridgeEntry = z.infer<typeof bridgeEntrySchema>;
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
export type NativeMonitor = z.infer<typeof nativeMonitorSchema>;
