import { describe, expect, it } from 'vitest';

import { emulatedFilesystemSchema } from './explorerSchemas.js';

const file = {
  kind: 'file',
  name: 'Иксанов Георгий.card',
  path: '/Дела/Картель/Объекты/Иксанов Георгий.card',
  mimeType: 'application/x-hq-person',
  size: 18_432,
  modifiedAt: '2026-09-09T10:41:00.000Z',
  content: { renderer: 'person-dossier', entityId: 'iksanov' },
};

describe('emulated filesystem schema', () => {
  it('accepts nested semantic files', () => {
    const result = emulatedFilesystemSchema.safeParse({
      version: 1,
      roots: [
        {
          kind: 'directory',
          name: 'Дела',
          path: '/Дела',
          children: [file],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate virtual paths anywhere in the tree', () => {
    const result = emulatedFilesystemSchema.safeParse({ version: 1, roots: [file, file] });
    expect(result.success).toBe(false);
  });

  it('rejects traversal in nested virtual paths', () => {
    const result = emulatedFilesystemSchema.safeParse({
      version: 1,
      roots: [{ ...file, path: '/Дела/%2e%2e/secret.card' }],
    });
    expect(result.success).toBe(false);
  });
});
