import { readFile } from 'node:fs/promises';

import {
  assetManifestSchema,
  emulatedFilesystemSchema,
  projectConfigSchema,
} from '@gremuchaya/config';
import { describe, expect, it } from 'vitest';

import { sceneRepository } from './scenes';

describe('runtime configuration', () => {
  it('validates the production defaults and emulated filesystem', async () => {
    const [project, assets, filesystem] = await Promise.all([
      readJson('project.default.json'),
      readJson('assets_manifest.json'),
      readJson('filesystem.emulated.json'),
    ]);
    expect(projectConfigSchema.parse(project).screenWindows).toHaveLength(9);
    expect(assetManifestSchema.parse(assets).assets.length).toBeGreaterThan(70);
    expect(emulatedFilesystemSchema.parse(filesystem).roots.length).toBeGreaterThan(0);
  });

  it('has a manifest entry for every scene asset', async () => {
    const manifest = assetManifestSchema.parse(await readJson('assets_manifest.json'));
    const defined = new Set(manifest.assets.map((asset) => asset.id));
    const scenes = await sceneRepository.all();
    const referenced = new Set(
      scenes.flatMap((scene) => [...scene.requiredAssetIds, ...scene.optionalAssetIds]),
    );
    expect([...referenced].filter((assetId) => !defined.has(assetId))).toEqual([]);
  });
});

async function readJson(name: string): Promise<unknown> {
  const path = new URL(`../../public/runtime/${name}`, import.meta.url);
  return JSON.parse(await readFile(path, 'utf8'));
}
