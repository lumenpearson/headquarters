import { AppError } from './errors.js';

export type VirtualPath = string & { readonly __brand: 'VirtualPath' };

const maximumVirtualPathLength = 2048;

export function createVirtualPath(value: string): VirtualPath {
  const decoded = decodePath(value).normalize('NFKC').replaceAll('\\', '/');

  if (decoded.includes('\0') || decoded.length > maximumVirtualPathLength) {
    throw new AppError('Virtual path contains invalid characters', 'INVALID_VIRTUAL_PATH', {
      context: { path: value },
    });
  }

  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) {
    throw new AppError('Parent traversal is not allowed', 'INVALID_VIRTUAL_PATH', {
      context: { path: value },
    });
  }

  const normalizedSegments = segments.filter((segment) => segment !== '.');
  const normalized = `/${normalizedSegments.join('/')}`;
  return normalized as VirtualPath;
}

export function joinVirtualPath(parent: VirtualPath, child: string): VirtualPath {
  if (child.includes('/') || child.includes('\\')) {
    throw new AppError('A virtual path child must be a single segment', 'INVALID_VIRTUAL_PATH', {
      context: { parent, child },
    });
  }

  return createVirtualPath(`${parent}/${child}`);
}

export function getVirtualParent(path: VirtualPath): VirtualPath | null {
  if (path === '/') {
    return null;
  }

  const separatorIndex = path.lastIndexOf('/');
  return createVirtualPath(separatorIndex <= 0 ? '/' : path.slice(0, separatorIndex));
}

export function getVirtualPathSegments(path: VirtualPath): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error: unknown) {
    throw new AppError('Virtual path encoding is invalid', 'INVALID_VIRTUAL_PATH', {
      cause: error,
      context: { path: value },
    });
  }
}
