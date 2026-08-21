import { describe, expect, it } from 'vitest';

import type { EmulatedFileNode, RealFileNode } from './explorer.js';
import { buildExplorerIndex, mergeExplorerNodes, sortExplorerNodes } from './explorerTree.js';
import { createVirtualPath } from './virtualPath.js';

const sharedPath = createVirtualPath('/Дела/Картель/Фото/Шигорев.jpg');

const emulated: EmulatedFileNode = {
  id: 'emulated-photo',
  name: 'Шигорев.jpg',
  path: sharedPath,
  kind: 'emulated-file',
  mimeType: 'image/jpeg',
  emulation: { renderer: 'text', body: 'placeholder' },
};

const real: RealFileNode = {
  id: 'real-photo',
  name: 'Шигорев.jpg',
  path: sharedPath,
  kind: 'real-file',
  sourceId: 'production',
  mimeType: 'image/jpeg',
  byteSize: 1024,
};

describe('explorer tree', () => {
  it('lets a real file shadow an emulated placeholder at the same virtual path', () => {
    const result = mergeExplorerNodes([[emulated], [real]]);
    expect(result.nodes).toEqual([real]);
    expect(result.collisions).toEqual([
      {
        path: sharedPath,
        visibleNodeId: 'real-photo',
        shadowedNodeId: 'emulated-photo',
      },
    ]);
  });

  it('sorts pinned entries, directories, then files using Russian numeric collation', () => {
    const nodes = sortExplorerNodes([
      { ...real, id: 'file-10', name: 'Кадр 10.jpg', path: createVirtualPath('/Кадр 10.jpg') },
      { ...real, id: 'file-2', name: 'Кадр 2.jpg', path: createVirtualPath('/Кадр 2.jpg') },
      {
        id: 'directory',
        name: 'Архив',
        path: createVirtualPath('/Архив'),
        kind: 'emulated-directory',
        children: [],
      },
      { ...real, id: 'pinned', name: 'Сводка', path: createVirtualPath('/Сводка'), pinnedOrder: 1 },
    ]);

    expect(nodes.map((node) => node.id)).toEqual(['pinned', 'directory', 'file-2', 'file-10']);
  });

  it('builds id and path indexes without duplicating node data', () => {
    const root = {
      id: 'root',
      name: 'Дела',
      path: createVirtualPath('/Дела'),
      kind: 'emulated-directory' as const,
      children: [emulated],
    };
    const index = buildExplorerIndex([root]);
    expect(index.byId.get('emulated-photo')).toBe(emulated);
    expect(index.byPath.get(sharedPath)).toBe(emulated);
  });
});
