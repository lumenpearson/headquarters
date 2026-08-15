import { createSceneId, createVirtualPath, screenIds } from '@gremuchaya/domain';
import * as z from 'zod';

import { moduleIdSchema } from './payloadSchemas.js';
import { screenIdSchema } from './sceneSchemas.js';

export const screenStateSchema = z.object({
  id: screenIdSchema,
  module: moduleIdSchema,
  payload: z.record(z.string(), z.unknown()),
  blackout: z.boolean(),
  standby: z.boolean(),
  frozen: z.boolean(),
  glitch: z.number().min(0).max(1),
  revision: z.number().int().nonnegative(),
});

export const explorerSnapshotSchema = z.object({
  activePath: z.string().transform(createVirtualPath),
  selectedNodeId: z.string().nullable(),
  expandedNodeIds: z.array(z.string()),
  viewMode: z.enum(['list', 'grid']),
  searchQuery: z.string(),
});

export const workspaceWindowSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  title: z.string(),
  kind: z.enum(['person', 'vehicle', 'image', 'video', 'map', 'graph', 'text', 'metadata']),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  state: z.enum(['normal', 'maximized', 'minimized']),
  zOrder: z.number().int().nonnegative(),
});

export const workspaceSnapshotSchema = z.object({
  activeSection: z.string(),
  windows: z.array(workspaceWindowSchema),
  activeDocumentId: z.string().nullable(),
});

export const appSnapshotSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  createdAt: z.iso.datetime(),
  sceneId: z.string().transform(createSceneId).nullable(),
  cueIndex: z.number().int().min(-1),
  screens: z.record(z.enum(screenIds), screenStateSchema),
  explorer: explorerSnapshotSchema,
  workspace: workspaceSnapshotSchema,
  clock: z.object({
    mode: z.enum(['real', 'fixed', 'scene']),
    fixedTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/u),
  }),
  wallPreset: z.string(),
  developerStateOverrides: z.record(z.string(), z.unknown()),
});

export type AppSnapshotConfig = z.infer<typeof appSnapshotSchema>;
