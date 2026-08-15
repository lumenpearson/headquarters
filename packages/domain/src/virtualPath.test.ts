import { describe, expect, it } from 'vitest';

import { AppError } from './errors.js';
import { createVirtualPath, getVirtualParent, joinVirtualPath } from './virtualPath.js';

describe('virtual paths', () => {
  it('normalizes separators and preserves a single rooted namespace', () => {
    const path = createVirtualPath('Дела\\Картель//Фото');
    expect(path).toBe('/Дела/Картель/Фото');
    expect(getVirtualParent(path)).toBe('/Дела/Картель');
    expect(joinVirtualPath(path, 'Кадр 01.jpg')).toBe('/Дела/Картель/Фото/Кадр 01.jpg');
  });

  it.each(['../secret', '/Дела/%2e%2e/secret', '/Дела/..\\secret'])(
    'rejects parent traversal: %s',
    (value) => {
      expect(() => createVirtualPath(value)).toThrowError(AppError);
    },
  );

  it('rejects a child containing path separators', () => {
    expect(() => joinVirtualPath(createVirtualPath('/Дела'), '../secret')).toThrowError(AppError);
  });
});
