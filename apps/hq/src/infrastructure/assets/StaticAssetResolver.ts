import type { AssetDefinition, AssetId, AssetLocation, PreloadResult } from '@gremuchaya/domain';
import type { AssetManifest } from '@gremuchaya/config';

import type { AssetResolverPort } from '@/application/ports';

export class StaticAssetResolver implements AssetResolverPort {
  readonly #byId: ReadonlyMap<AssetId, AssetDefinition>;

  constructor(manifest: AssetManifest) {
    this.#byId = new Map(
      manifest.assets.map((asset): [AssetId, AssetDefinition] => [
        asset.id,
        {
          id: asset.id,
          type: asset.type,
          status: asset.status,
          location: asset.location,
          expectedMimeType: asset.expectedMimeType,
          ...(asset.notes === undefined ? {} : { notes: asset.notes }),
        },
      ]),
    );
  }

  async resolve(assetId: AssetId): Promise<AssetLocation | null> {
    return this.#byId.get(assetId)?.location ?? null;
  }

  getDefinition(assetId: AssetId): AssetDefinition | null {
    return this.#byId.get(assetId) ?? null;
  }

  async preload(assetIds: readonly AssetId[], signal?: AbortSignal): Promise<PreloadResult> {
    const ready: AssetId[] = [];
    const failed: AssetId[] = [];
    await Promise.all(
      assetIds.map(async (assetId) => {
        if (signal?.aborted === true) return;
        const definition = this.#byId.get(assetId);
        if (definition === undefined || definition.status === 'missing') {
          failed.push(assetId);
          return;
        }
        if (definition.location.kind !== 'static') {
          ready.push(assetId);
          return;
        }
        try {
          const response = await fetch(definition.location.url, {
            method: 'GET',
            ...(signal === undefined ? {} : { signal }),
          });
          (response.ok ? ready : failed).push(assetId);
        } catch {
          failed.push(assetId);
        }
      }),
    );
    return { ready, failed };
  }
}
