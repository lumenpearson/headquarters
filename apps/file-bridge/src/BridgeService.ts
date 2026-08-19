import { readdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { BridgeConfig, BridgeEntry } from '@gremuchaya/config';
import { createVirtualPath, joinVirtualPath, type VirtualPath } from '@gremuchaya/domain';

import { mimeForPath } from './mime.js';
import { PathSecurityError, resolveExistingSafePath } from './pathSecurity.js';

export class BridgeService {
  constructor(readonly config: BridgeConfig) {}

  getMount(mountId: string) {
    const mount = this.config.mounts.find((candidate) => candidate.id === mountId);
    if (mount === undefined) throw new Error(`Unknown mount: ${mountId}`);
    return mount;
  }

  async list(mountId: string, requestedPath: string): Promise<readonly BridgeEntry[]> {
    const mount = this.getMount(mountId);
    assertPublicPath(requestedPath);
    const safe = await resolveExistingSafePath(mount.root, requestedPath);
    const directory = await stat(safe.path);
    if (!directory.isDirectory()) throw new Error('Requested path is not a directory.');
    const entries = await readdir(safe.path, { withFileTypes: true });
    const result: BridgeEntry[] = [];
    for (const entry of entries) {
      if (
        entry.name === '.hq' ||
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile())
      )
        continue;
      const childVirtualPath = joinVirtualPath(safe.virtualPath, entry.name);
      const child = await resolveExistingSafePath(mount.root, childVirtualPath);
      const metadata = await stat(child.path);
      result.push({
        name: entry.name,
        path: childVirtualPath,
        kind: entry.isDirectory() ? 'directory' : 'file',
        modifiedAt: metadata.mtime.toISOString(),
        ...(entry.isFile() ? { mimeType: mimeForPath(entry.name), byteSize: metadata.size } : {}),
      });
    }
    return result.sort((left, right) =>
      left.kind === right.kind
        ? left.name.localeCompare(right.name, 'ru-RU', { numeric: true })
        : left.kind === 'directory'
          ? -1
          : 1,
    );
  }

  async resolveFile(
    mountId: string,
    requestedPath: string,
  ): Promise<{
    readonly path: string;
    readonly name: string;
    readonly mimeType: string;
    readonly size: number;
    readonly virtualPath: VirtualPath;
  }> {
    const mount = this.getMount(mountId);
    assertPublicPath(requestedPath);
    const safe = await resolveExistingSafePath(mount.root, requestedPath);
    const metadata = await stat(safe.path);
    if (!metadata.isFile()) throw new Error('Requested path is not a file.');
    return {
      path: safe.path,
      name: basename(safe.path),
      mimeType: mimeForPath(safe.path),
      size: metadata.size,
      virtualPath: createVirtualPath(requestedPath),
    };
  }
}

function assertPublicPath(requestedPath: string): void {
  const segments = requestedPath.replaceAll('\\', '/').split('/').filter(Boolean);
  if (segments.includes('.hq')) {
    throw new PathSecurityError('Bridge internal material paths are not exposed.');
  }
}
