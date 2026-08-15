import { appSnapshotSchema } from '@gremuchaya/config';
import type { AppSnapshot } from '@gremuchaya/domain';
import * as z from 'zod';

import type { SnapshotPersistencePort } from '@/application/ports';

const storageKey = 'gremuchaya-hq:snapshots:v1';

export class LocalSnapshotPersistence implements SnapshotPersistencePort {
  async list(): Promise<readonly AppSnapshot[]> {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return [];
    return z.array(appSnapshotSchema).parse(JSON.parse(raw));
  }

  async save(snapshot: AppSnapshot): Promise<void> {
    const snapshots = await this.list();
    const next = [
      snapshot,
      ...snapshots.filter((candidate) => candidate.name !== snapshot.name),
    ].slice(0, 30);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  async remove(name: string): Promise<void> {
    const snapshots = await this.list();
    localStorage.setItem(
      storageKey,
      JSON.stringify(snapshots.filter((snapshot) => snapshot.name !== name)),
    );
  }
}
