import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createVirtualPath, getVirtualPathSegments, type VirtualPath } from '@gremuchaya/domain';
import { BridgeFailure } from '@gremuchaya/protocol';

import { BridgeFailureError, type BridgeFailureCode } from './errors.js';

/**
 * A containment refusal, carrying the code it crosses the wire with.
 *
 * It is a `BridgeFailureError` so that the refusal decides its own code here,
 * where the reason is known, rather than at the transport boundary, where every
 * refusal looked alike and had nothing to send but its message. The message is
 * for this process's logs; only the code is shown to anyone.
 */
export class PathSecurityError extends BridgeFailureError {
  constructor(code: BridgeFailureCode, message: string) {
    super(code, message);
    this.name = 'PathSecurityError';
  }
}

export function resolveCandidate(
  root: string,
  requestedPath: string,
): { readonly root: string; readonly virtualPath: VirtualPath; readonly candidate: string } {
  const virtualPath = createVirtualPath(requestedPath);
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...getVirtualPathSegments(virtualPath));
  assertContained(resolvedRoot, candidate);
  return { root: resolvedRoot, virtualPath, candidate };
}

export async function resolveExistingSafePath(
  root: string,
  requestedPath: string,
): Promise<{
  readonly virtualPath: VirtualPath;
  readonly path: string;
  readonly canonicalRoot: string;
}> {
  const resolved = resolveCandidate(root, requestedPath);
  const canonicalRoot = await realpath(resolved.root);
  await assertNoSymlink(resolved.root, getVirtualPathSegments(resolved.virtualPath));
  const canonicalTarget = await realpath(resolved.candidate);
  assertContained(canonicalRoot, canonicalTarget);
  return { virtualPath: resolved.virtualPath, path: canonicalTarget, canonicalRoot };
}

export function assertContained(root: string, target: string): void {
  const difference = relative(root, target);
  if (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  )
    return;
  throw new PathSecurityError(
    BridgeFailure.PATH_ESCAPES_MOUNT,
    'Requested path escapes the configured mount.',
  );
}

async function assertNoSymlink(root: string, segments: readonly string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink())
      throw new PathSecurityError(
        BridgeFailure.SYMLINK_REFUSED,
        'Symbolic links are not exposed by the bridge.',
      );
  }
}
