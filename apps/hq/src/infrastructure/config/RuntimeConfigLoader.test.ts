import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadProjectConfiguration, loadRuntimeConfiguration } from './RuntimeConfigLoader';

const requiredRuntimeFiles = new Map([
  ['/runtime/project.default.json', 'project.default.json'],
  ['/runtime/assets_manifest.json', 'assets_manifest.json'],
  ['/runtime/filesystem.emulated.json', 'filesystem.emulated.json'],
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RuntimeConfigLoader', () => {
  it('treats the Tauri application-shell fallback as an absent optional override', async () => {
    vi.stubGlobal('fetch', createRuntimeFetch('<!DOCTYPE html><html><body>shell</body></html>'));

    const configuration = await loadRuntimeConfiguration();

    expect(configuration.project.projectName).toBe('Гремучая смесь — Оперативный штаб');
    expect(configuration.assets.assets.length).toBeGreaterThan(70);
    expect(configuration.emulatedRoots.length).toBeGreaterThan(0);
  });

  it('does not hide malformed optional JSON', async () => {
    vi.stubGlobal('fetch', createRuntimeFetch('{"version":'));

    await expect(loadRuntimeConfiguration()).rejects.toThrow(
      'Invalid JSON in runtime config: /runtime/project.override.json',
    );
  });

  it('ships no control plane address by default, so a fresh install is local-only', async () => {
    vi.stubGlobal('fetch', createRuntimeFetch(null));

    const project = await loadProjectConfiguration();

    expect(project.config.controlPlaneUrl).toBeUndefined();
    expect(project.override).toBeNull();
  });

  it('takes the control plane address from the project override', async () => {
    vi.stubGlobal(
      'fetch',
      createRuntimeFetch(
        JSON.stringify({
          version: 1,
          values: { controlPlaneUrl: 'http://192.168.10.5:4100' },
          assetOverrides: {},
        }),
      ),
    );

    const project = await loadProjectConfiguration();

    // The override is the file an operator edits on the shoot machine; the
    // default stays committed without an address on purpose.
    expect(project.config.controlPlaneUrl).toBe('http://192.168.10.5:4100');
  });

  it('reports an application-shell fallback for a required config as unavailable', async () => {
    vi.stubGlobal('fetch', createRuntimeFetch(null, new Set(['/runtime/project.default.json'])));

    await expect(loadRuntimeConfiguration()).rejects.toThrow(
      'Runtime config unavailable: /runtime/project.default.json resolved to the application shell',
    );
  });
});

function createRuntimeFetch(
  optionalOverride: string | null,
  htmlFallbacks: ReadonlySet<string> = new Set(),
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = getRequestUrl(input);
    if (htmlFallbacks.has(url)) return htmlResponse();
    if (url === '/runtime/project.override.json') {
      return optionalOverride === null
        ? new Response(null, { status: 404 })
        : new Response(optionalOverride, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
    }
    const filename = requiredRuntimeFiles.get(url);
    if (filename === undefined) return new Response(null, { status: 404 });
    return new Response(await readRuntimeFile(filename), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function htmlResponse(): Response {
  return new Response('<!DOCTYPE html><html><body>shell</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function readRuntimeFile(name: string): Promise<string> {
  const path = new URL(`../../../public/runtime/${name}`, import.meta.url);
  return readFile(path, 'utf8');
}
