import {
  assetManifestSchema,
  emulatedFilesystemSchema,
  projectConfigSchema,
  productionOverrideSchema,
  type AssetManifest,
  type EmulatedNodeConfig,
  type ProjectConfig,
} from '@gremuchaya/config';

export interface RuntimeConfiguration {
  readonly project: ProjectConfig;
  readonly assets: AssetManifest;
  readonly emulatedRoots: readonly EmulatedNodeConfig[];
}

export async function loadRuntimeConfiguration(
  signal?: AbortSignal,
): Promise<RuntimeConfiguration> {
  const [project, assets, filesystem] = await Promise.all([
    loadProjectConfiguration(signal),
    loadJson('/runtime/assets_manifest.json', signal),
    loadJson('/runtime/filesystem.emulated.json', signal),
  ]);
  const parsedAssets = assetManifestSchema.parse(assets);
  return {
    project: project.config,
    assets:
      project.override === null
        ? parsedAssets
        : applyAssetOverrides(parsedAssets, project.override.assetOverrides),
    emulatedRoots: emulatedFilesystemSchema.parse(filesystem).roots,
  };
}

interface LoadedProjectConfiguration {
  readonly config: ProjectConfig;
  readonly override: ReturnType<typeof productionOverrideSchema.parse> | null;
}

/**
 * The project configuration alone, with its override applied.
 *
 * Split out of {@link loadRuntimeConfiguration} because the control-plane
 * runtime mounts on every route and needs one field of it -- the control
 * plane's address -- where the scene runtime, which mounts on the scene routes
 * only, needs the asset manifest and the emulated filesystem as well. Loading
 * all three for an address would be paying for two documents nobody reads.
 */
export async function loadProjectConfiguration(
  signal?: AbortSignal,
): Promise<LoadedProjectConfiguration> {
  const [project, override] = await Promise.all([
    loadJson('/runtime/project.default.json', signal),
    loadOptionalJson('/runtime/project.override.json', signal),
  ]);
  const parsedProject = projectConfigSchema.parse(project);
  const parsedOverride = override === null ? null : productionOverrideSchema.parse(override);
  return {
    config:
      parsedOverride === null
        ? parsedProject
        : projectConfigSchema.parse({ ...parsedProject, ...parsedOverride.values }),
    override: parsedOverride,
  };
}

async function loadJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`Runtime config unavailable: ${url} (${response.status})`);
  const body = await response.text();
  if (isHtmlDocument(body)) {
    throw new Error(`Runtime config unavailable: ${url} resolved to the application shell`);
  }
  return parseJson(body, url);
}

async function loadOptionalJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Runtime override unavailable: ${url} (${response.status})`);
  const body = await response.text();
  if (isHtmlDocument(body)) return null;
  return parseJson(body, url);
}

function isHtmlDocument(body: string): boolean {
  const normalized = body.trimStart().toLowerCase();
  return normalized.startsWith('<!doctype html') || normalized.startsWith('<html');
}

function parseJson(body: string, url: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    throw new Error(`Invalid JSON in runtime config: ${url}`, { cause });
  }
}

function applyAssetOverrides(
  manifest: AssetManifest,
  overrides: ReturnType<typeof productionOverrideSchema.parse>['assetOverrides'],
): AssetManifest {
  return {
    ...manifest,
    assets: manifest.assets.map((asset) => {
      const override = overrides[asset.id];
      if (override === undefined) return asset;
      const location =
        override.kind === 'projected-file'
          ? { kind: 'projected-file' as const, nodeId: `virtual:${override.virtualPath}` }
          : override;
      return { ...asset, location };
    }),
  };
}
