import { appSnapshotSchema } from '@gremuchaya/config';
import type { AppSnapshot } from '@gremuchaya/domain';

import type { SnapshotPersistencePort } from '@/application/ports';

const storageKey = 'gremuchaya-hq:snapshots:v1';

export class LocalSnapshotPersistence implements SnapshotPersistencePort {
  async list(): Promise<readonly AppSnapshot[]> {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON at all: nothing here can ever become snapshots again.
      localStorage.removeItem(storageKey);
      return [];
    }
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(storageKey);
      return [];
    }
    // localStorage is a trust boundary: a blob from an older build, another tab
    // or the devtools console must not be able to wedge the store. Dropping
    // only the entries that no longer validate keeps the rest listable -- and,
    // because `save` reads through `list`, keeps saving possible at all.
    return parsed.flatMap((entry) => {
      const result = appSnapshotSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
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
