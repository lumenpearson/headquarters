import {
  buildExplorerIndex,
  createVirtualPath,
  getVirtualParent,
  mergeExplorerNodes,
  type EmulatedFileNode,
  type ExplorerIndex,
  type ExplorerNode,
  type FileSourcePort,
  type VirtualPath,
  type WorkspaceDocument,
} from '@gremuchaya/domain';

export interface ExplorerView {
  readonly path: VirtualPath;
  readonly nodes: readonly ExplorerNode[];
  readonly index: ExplorerIndex;
  readonly collisions: ReturnType<typeof mergeExplorerNodes>['collisions'];
  readonly sourceStatuses: Readonly<Record<string, 'online' | 'offline' | 'empty'>>;
}

export class ExplorerService {
  constructor(private readonly sources: readonly FileSourcePort[]) {}

  async list(path: VirtualPath | string, signal?: AbortSignal): Promise<ExplorerView> {
    const normalizedPath = createVirtualPath(path);
    const settled = await Promise.all(
      this.sources.map(async (source) => {
        try {
          const nodes = await source.list(normalizedPath, signal);
          return {
            source,
            nodes,
            status: nodes.length === 0 ? ('empty' as const) : ('online' as const),
          };
        } catch {
          return { source, nodes: [] as readonly ExplorerNode[], status: 'offline' as const };
        }
      }),
    );
    const merged = mergeExplorerNodes(settled.map((result) => result.nodes));
    return {
      path: normalizedPath,
      nodes: merged.nodes,
      index: buildExplorerIndex(merged.nodes),
      collisions: merged.collisions,
      sourceStatuses: Object.fromEntries(
        settled.map((result) => [result.source.id, result.status]),
      ),
    };
  }

  parent(path: VirtualPath): VirtualPath {
    return getVirtualParent(path) ?? createVirtualPath('/');
  }

  toDocument(node: ExplorerNode): WorkspaceDocument {
    if (node.kind !== 'emulated-file')
      return { kind: 'metadata', id: `doc:${node.id}`, node, title: node.name };
    return emulatedDocument(node);
  }
}

function emulatedDocument(node: EmulatedFileNode): WorkspaceDocument {
  const base = { id: `doc:${node.id}`, title: node.name };
  switch (node.emulation.renderer) {
    case 'person-dossier':
      return { ...base, kind: 'person', entityId: node.emulation.entityId };
    case 'vehicle-dossier':
      return { ...base, kind: 'vehicle', entityId: node.emulation.entityId };
    case 'image':
      return { ...base, kind: 'image', assetId: node.emulation.assetId };
    case 'video':
      return { ...base, kind: 'video', assetId: node.emulation.assetId };
    case 'map':
      return { ...base, kind: 'map', presetId: node.emulation.presetId };
    case 'graph':
      return { ...base, kind: 'graph', graphId: node.emulation.graphId };
    case 'text':
      return { ...base, kind: 'text', body: node.emulation.body };
    case 'table':
      return { ...base, kind: 'metadata', node, title: node.name };
  }
}
