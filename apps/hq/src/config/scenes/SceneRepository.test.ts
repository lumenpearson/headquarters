import { describe, expect, it } from 'vitest';

import { SceneRepository } from './SceneRepository';

describe('SceneRepository', () => {
  it('contains exactly 52 unique September scene definitions', async () => {
    const repository = new SceneRepository();
    const scenes = await repository.all();
    expect(scenes).toHaveLength(52);
    expect(new Set(scenes.map((scene) => scene.id)).size).toBe(52);
    expect(scenes.every((scene) => scene.shootDate.startsWith('2026-09-'))).toBe(true);
  });

  it('loads a scene through its small date group', async () => {
    const repository = new SceneRepository();
    await expect(repository.find('s02-58')).resolves.toMatchObject({
      title: 'КамАЗ / потеря спутника',
    });
    await expect(repository.find('s99-99')).resolves.toBeNull();
  });

  it('contains the required critical scene transitions', async () => {
    const repository = new SceneRepository();
    const lossScene = await repository.find('s02-58');
    const silverScene = await repository.find('s08-31');
    expect(lossScene?.cues.map((cue) => cue.id)).toEqual([
      'clean',
      'light',
      'heavy',
      'lost',
      'tracker',
    ]);
    expect(silverScene?.cues.map((cue) => cue.id)).toEqual([
      'zoom',
      'search',
      'results',
      'profile',
      'photo',
    ]);
  });
});
