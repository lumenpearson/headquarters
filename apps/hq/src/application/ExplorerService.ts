import {
  buildExplorerIndex,
  createVirtualPath,
  getVirtualParent,
  mergeExplorerNodes,
  type Disposable,
  type EmulatedFileNode,
  type ExplorerIndex,
  type ExplorerNode,
  type FileSourceListener,
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

  /**
   * Subscribes every capable source to `path` and forwards each
   * `FileSourceEvent` to `listener` unchanged -- the event still names its
   * `sourceId`, and this method dedupes nothing. Which source wins at a path
   * both watch is decided once, in the domain, by `mergeExplorerNodes` when
   * the caller re-lists; an event from a source `mergeExplorerNodes` would
   * currently shadow is still true (a deletion can change who wins), so it is
   * forwarded exactly like one from the visible source. Sources without the
   * optional member are skipped; a source that throws (`TauriFileSource.watch`
   * on a build with no Tauri runtime, on every call) does not stop the others,
   * the same degradation `list` gives a source whose `list` call fails. If
   * every source is skipped or fails, the returned `Disposable` disposes
   * nothing.
   *
   * Resolves once the fan-out has started, not once every source has finished
   * subscribing and never once an event has arrived: a source can take a
   * round trip to subscribe (`TauriFileSource.watch`'s native `invoke`, a
   * bridge mount's first `Watch` request) and a caller awaiting this
   * (`RuntimeController#watchActivePath`, itself awaited by `navigate`) must
   * not stall on the slowest one. That is also why the returned `Disposable`
   * can outlive a source's own subscribe call: `dispose()` reached before a
   * late source resolves disposes that source's watch on arrival instead of
   * leaving it open with nothing left listening. `RuntimeController` used to
   * guard exactly this by hand, for its one source; covering every source
   * that can watch is what moves it here.
   *
   * No error or close channel reaches `listener`: `FileSourcePort.watch`
   * declares neither, and adding one is a port change this method does not
   * make.
   */
  async watch(path: VirtualPath | string, listener: FileSourceListener): Promise<Disposable> {
    const normalizedPath = createVirtualPath(path);
    let disposed = false;
    const children = new Set<Disposable>();
    for (const source of this.sources) {
      if (source.watch === undefined) continue;
      try {
        void source
          .watch(normalizedPath, listener)
          .then(
            (child) => {
              if (disposed) {
                child.dispose();
                return;
              }
              children.add(child);
            },
            () => {
              // Degrades like `list`: a source that cannot watch this path
              // leaves every other source's subscription untouched.
            },
          )
          .catch(() => {
            // A late child's own `dispose()` throwing above must not escape as
            // an unhandled rejection: nothing here awaits this chain.
          });
      } catch {
        // `FileSourcePort.watch` is typed to return a promise, but nothing
        // stops an implementation from throwing synchronously instead of
        // rejecting one -- and a throw here would otherwise escape the loop
        // and skip every source after it.
      }
    }
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const child of children) child.dispose();
        children.clear();
      },
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
