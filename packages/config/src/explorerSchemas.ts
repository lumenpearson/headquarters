import { createAssetId, createEntityId, createVirtualPath } from '@gremuchaya/domain';
import * as z from 'zod';

export const virtualPathSchema = z.string().transform(createVirtualPath);

export const emulatedFileContentSchema = z.discriminatedUnion('renderer', [
  z.object({
    renderer: z.literal('person-dossier'),
    entityId: z.string().transform(createEntityId),
  }),
  z.object({
    renderer: z.literal('vehicle-dossier'),
    entityId: z.string().transform(createEntityId),
  }),
  z.object({ renderer: z.literal('text'), body: z.string() }),
  z.object({ renderer: z.literal('image'), assetId: z.string().transform(createAssetId) }),
  z.object({ renderer: z.literal('video'), assetId: z.string().transform(createAssetId) }),
  z.object({ renderer: z.literal('graph'), graphId: z.string().min(1) }),
  z.object({ renderer: z.literal('map'), presetId: z.string().min(1) }),
  z.object({ renderer: z.literal('table'), tableId: z.string().min(1) }),
]);

export interface EmulatedNodeConfig {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  readonly path: string;
  readonly mimeType?: string | undefined;
  readonly size?: number | undefined;
  readonly modifiedAt?: string | undefined;
  readonly iconHint?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly presentationProfileId?: string | undefined;
  readonly content?: z.infer<typeof emulatedFileContentSchema> | undefined;
  readonly children?: readonly EmulatedNodeConfig[] | undefined;
}

export const emulatedNodeSchema: z.ZodType<EmulatedNodeConfig> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('file'),
      name: z.string().trim().min(1),
      path: z.string().min(1),
      mimeType: z.string().trim().min(1),
      size: z.number().int().nonnegative(),
      modifiedAt: z.iso.datetime(),
      iconHint: z.string().optional(),
      tags: z.array(z.string()).optional(),
      content: emulatedFileContentSchema,
    }),
    z.object({
      kind: z.literal('directory'),
      name: z.string().trim().min(1),
      path: z.string().min(1),
      modifiedAt: z.iso.datetime().optional(),
      iconHint: z.string().optional(),
      tags: z.array(z.string()).optional(),
      presentationProfileId: z.string().optional(),
      children: z.array(emulatedNodeSchema),
    }),
  ]),
);

export const emulatedFilesystemSchema = z
  .object({
    version: z.literal(1),
    roots: z.array(emulatedNodeSchema),
  })
  .check((context) => {
    const paths = new Set<string>();
    for (const node of flattenConfigNodes(context.value.roots)) {
      let normalizedPath: string;
      try {
        normalizedPath = createVirtualPath(node.path);
      } catch {
        context.issues.push({
          code: 'custom',
          input: node.path,
          message: `Invalid virtual path: ${node.path}`,
          path: ['roots'],
        });
        continue;
      }

      if (paths.has(normalizedPath)) {
        context.issues.push({
          code: 'custom',
          input: normalizedPath,
          message: `Duplicate virtual path: ${normalizedPath}`,
          path: ['roots'],
        });
      }
      paths.add(normalizedPath);
    }
  });

export const virtualMountRuleSchema = z.object({
  sourceId: z.string().min(1),
  sourcePath: z.string(),
  virtualPath: virtualPathSchema,
  priority: z.number().int(),
});

export const fileDisplayOverrideSchema = z.object({
  sourceId: z.string().min(1),
  physicalPath: z.string().min(1),
  displayName: z.string().min(1).optional(),
  virtualPath: virtualPathSchema.optional(),
  hidden: z.boolean().optional(),
});

function flattenConfigNodes(nodes: readonly EmulatedNodeConfig[]): readonly EmulatedNodeConfig[] {
  const flattened: EmulatedNodeConfig[] = [];
  for (const node of nodes) {
    flattened.push(node);
    if (node.kind === 'directory' && node.children !== undefined) {
      flattened.push(...flattenConfigNodes(node.children));
    }
  }
  return flattened;
}
