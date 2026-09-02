// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MaterialAnnotationsPanel } from './MaterialAnnotationsPanel';
import { materialAnnotationsStorageKey } from './materialAnnotations';

describe('MaterialAnnotationsPanel', () => {
  it('adds a note at the current time and persists it', () => {
    window.localStorage.clear();
    render(<MaterialAnnotationsPanel materialId="material-1" currentTime={65} />);

    expect(screen.getByText('ЗАМЕТОК НЕТ')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Текст новой аннотации'), {
      target: { value: 'проверка света' },
    });
    fireEvent.click(screen.getByText('[+] ДОБАВИТЬ НА 01:05'));

    expect(screen.getByText('проверка света')).toBeTruthy();
    const stored = JSON.parse(window.localStorage.getItem(materialAnnotationsStorageKey) ?? '{}');
    expect(stored['material-1']).toHaveLength(1);
    expect(stored['material-1'][0].timestampSeconds).toBe(65);
  });

  it('restores notes already on disk for this material', async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      materialAnnotationsStorageKey,
      JSON.stringify({
        'material-1': [
          {
            id: 'id-1',
            materialId: 'material-1',
            timestampSeconds: 12,
            text: 'restored note',
            createdAt: '2026-08-29T00:00:00.000Z',
          },
        ],
      }),
    );

    render(<MaterialAnnotationsPanel materialId="material-1" currentTime={0} />);

    // The initial read is deferred out of the effect body (a synchronous
    // `setState` there is disallowed), so it lands a tick after mount.
    expect(await screen.findByText('restored note')).toBeTruthy();
  });

  it("calls back with the note's timestamp when its row is chosen", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      materialAnnotationsStorageKey,
      JSON.stringify({
        'material-1': [
          {
            id: 'id-1',
            materialId: 'material-1',
            timestampSeconds: 42,
            text: 'jump here',
            createdAt: '2026-08-29T00:00:00.000Z',
          },
        ],
      }),
    );
    const seeks: number[] = [];

    render(
      <MaterialAnnotationsPanel
        materialId="material-1"
        currentTime={0}
        onSeek={(seconds) => seeks.push(seconds)}
      />,
    );

    fireEvent.click(await screen.findByText('00:42'));

    expect(seeks).toEqual([42]);
  });

  it('removes a note', async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      materialAnnotationsStorageKey,
      JSON.stringify({
        'material-1': [
          {
            id: 'id-1',
            materialId: 'material-1',
            timestampSeconds: 1,
            text: 'remove me',
            createdAt: '2026-08-29T00:00:00.000Z',
          },
        ],
      }),
    );

    render(<MaterialAnnotationsPanel materialId="material-1" currentTime={0} />);
    fireEvent.click(await screen.findByLabelText('Удалить аннотацию'));

    expect(screen.queryByText('remove me')).toBeNull();
    expect(screen.getByText('ЗАМЕТОК НЕТ')).toBeTruthy();
  });
});
