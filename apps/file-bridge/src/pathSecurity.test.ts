import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PathSecurityError, resolveCandidate, resolveExistingSafePath } from './pathSecurity.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('path security', () => {
  it('rejects encoded parent traversal before touching the filesystem', () => {
    expect(() => resolveCandidate('C:/safe', '/%2e%2e/secrets.txt')).toThrow();
    expect(() => resolveCandidate('C:/safe', '/..\\secrets.txt')).toThrow();
  });

  it('resolves ordinary files inside the mount', async () => {
    const root = await createTemporaryRoot();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'report.txt'), 'safe', 'utf8');
    await expect(resolveExistingSafePath(root, '/nested/report.txt')).resolves.toMatchObject({
      virtualPath: '/nested/report.txt',
    });
  });

  it('rejects symbolic links even when their target exists', async () => {
    const root = await createTemporaryRoot();
    const outside = await createTemporaryRoot();
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, join(root, 'escape'), 'junction');
    await expect(resolveExistingSafePath(root, '/escape/secret.txt')).rejects.toBeInstanceOf(
      PathSecurityError,
    );
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gremuchaya-bridge-'));
  temporaryDirectories.push(root);
  return root;
}
