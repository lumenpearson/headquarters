import type { AssetId, EntityId } from './ids.js';

export interface PersonEntity {
  readonly id: EntityId;
  readonly displayName: string;
  readonly fullName?: string;
  readonly aliases?: readonly string[];
  readonly role?: string;
  readonly status?: string;
  readonly portraitAssets: readonly AssetId[];
  readonly facts: readonly string[];
  readonly sourceLevel: 'kpp' | 'script' | 'derived';
}

export interface VehicleEntity {
  readonly id: EntityId;
  readonly label: string;
  readonly make?: string;
  readonly model?: string;
  readonly plate?: string;
  readonly photoAssets?: readonly AssetId[];
  readonly lastLocationId?: EntityId;
  readonly sourceLevel: 'kpp' | 'script' | 'derived';
}

export interface LocationEntity {
  readonly id: EntityId;
  readonly name: string;
  readonly region?: string;
  readonly mapAsset: AssetId;
  readonly x: number;
  readonly y: number;
  readonly sourceLevel: 'kpp' | 'script' | 'derived';
}
