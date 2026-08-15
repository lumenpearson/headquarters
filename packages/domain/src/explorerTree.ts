import type { ExplorerIndex, ExplorerNode } from './explorer.js';
import type { VirtualPath } from './virtualPath.js';
import { getVirtualParent } from './virtualPath.js';

const russianCollator = new Intl.Collator('ru-RU', {
  numeric: true,
  sensitivity: 'base',
});

export interface ExplorerCollision {
  readonly path: VirtualPath;
  readonly visibleNodeId: string;
  readonly shadowedNodeId: string;
}

export interface ExplorerMergeResult {
  readonly nodes: readonly ExplorerNode[];
  readonly collisions: readonly ExplorerCollision[];
}

export function mergeExplorerNodes(
  groups: readonly (readonly ExplorerNode[])[],
): ExplorerMergeResult {
  const byPath = new Map<VirtualPath, ExplorerNode>();
  const collisions: ExplorerCollision[] = [];

  for (const group of groups) {
    for (const node of group) {
      const current = byPath.get(node.path);
      if (current === undefined) {
        byPath.set(node.path, node);
        continue;
      }

      const visible = chooseCollisionWinner(current, node);
      const shadowed = visible.id === current.id ? node : current;
      byPath.set(node.path, visible);
      collisions.push({
        path: node.path,
        visibleNodeId: visible.id,
        shadowedNodeId: shadowed.id,
      });
    }
  }

  return {
    nodes: sortExplorerNodes([...byPath.values()]),
    collisions,
  };
}

export function sortExplorerNodes(nodes: readonly ExplorerNode[]): readonly ExplorerNode[] {
  return [...nodes].sort((left, right) => {
    const pinnedDifference =
      (left.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.pinnedOrder ?? Number.MAX_SAFE_INTEGER);
    if (pinnedDifference !== 0) {
      return pinnedDifference;
    }

    const kindDifference = getNodeKindOrder(left) - getNodeKindOrder(right);
    if (kindDifference !== 0) {
      return kindDifference;
    }

    return russianCollator.compare(left.name, right.name);
  });
}

export function buildExplorerIndex(nodes: readonly ExplorerNode[]): ExplorerIndex {
  const byId = new Map<string, ExplorerNode>();
  const byPath = new Map<VirtualPath, ExplorerNode>();
  const mutableChildren = new Map<string, string[]>();

  for (const node of flattenNodes(nodes)) {
    byId.set(node.id, node);
    byPath.set(node.path, node);
  }

  for (const node of byId.values()) {
    const parentPath = getVirtualParent(node.path);
    if (parentPath === null) {
      continue;
    }

    const parent = byPath.get(parentPath);
    if (parent === undefined) {
      continue;
    }

    const children = mutableChildren.get(parent.id) ?? [];
    children.push(node.id);
    mutableChildren.set(parent.id, children);
  }

  const childrenById = new Map<string, readonly string[]>();
  for (const [parentId, childIds] of mutableChildren) {
    childrenById.set(parentId, childIds);
  }

  return { byId, byPath, childrenById };
}

function chooseCollisionWinner(left: ExplorerNode, right: ExplorerNode): ExplorerNode {
  if (isRealNode(left) && !isRealNode(right)) {
    return left;
  }

  if (isRealNode(right) && !isRealNode(left)) {
    return right;
  }

  return left;
}

function isRealNode(node: ExplorerNode): boolean {
  return node.kind === 'real-file' || node.kind === 'real-directory';
}

function getNodeKindOrder(node: ExplorerNode): number {
  switch (node.kind) {
    case 'mount':
      return 0;
    case 'real-directory':
    case 'emulated-directory':
      return 1;
    case 'real-file':
    case 'emulated-file':
      return 2;
  }
}

function flattenNodes(nodes: readonly ExplorerNode[]): readonly ExplorerNode[] {
  const flattened: ExplorerNode[] = [];

  for (const node of nodes) {
    flattened.push(node);
    if (node.kind === 'emulated-directory') {
      flattened.push(...flattenNodes(node.children));
    }
  }

  return flattened;
}
