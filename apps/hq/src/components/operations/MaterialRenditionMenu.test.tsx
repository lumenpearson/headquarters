// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import type {
  MaterialLibraryClient,
  MaterialRendition,
} from '@/infrastructure/materials/materialLibrary';

import { LocalMaterialPreview } from './LocalMaterialPreview';
import { MaterialRenditionMenu } from './MaterialRenditionMenu';

/*
 * Vidstack loads a provider against a real media element, which jsdom does not
 * implement. The stub renders the player's children so the quality menu the
 * preview passes into its transport row is in the tree to be driven, which is
 * the whole subject of these tests.
 */
vi.mock('@vidstack/react', async () => {
  const { createElement, forwardRef } = await import('react');
  return {
    isVideoProvider: () => false,
    MediaProvider: () => null,
    MediaPlayer: forwardRef(function MediaPlayerStub(
      props: { readonly children?: ReactNode; readonly 'aria-label'?: string },
      _ref: unknown,
    ) {
      return createElement('div', { 'aria-label': props['aria-label'] }, props.children);
    }),
    Controls: {
      Root: ({
        children,
        className,
      }: {
        readonly children?: ReactNode;
        readonly className?: string;
      }) => createElement('div', { className }, children),
      Group: ({
        children,
        className,
      }: {
        readonly children?: ReactNode;
        readonly className?: string;
      }) => createElement('div', { className }, children),
    },
    TimeSlider: {
      Root: (props: {
        readonly children?: ReactNode;
        readonly className?: string;
        readonly 'aria-label'?: string;
      }) =>
        createElement(
          'div',
          { className: props.className, 'aria-label': props['aria-label'] },
          props.children,
        ),
      Track: ({
        children,
        className,
      }: {
        readonly children?: ReactNode;
        readonly className?: string;
      }) => createElement('div', { className }, children),
      TrackFill: ({ className }: { readonly className?: string }) =>
        createElement('div', { className }),
      Progress: ({ className }: { readonly className?: string }) =>
        createElement('div', { className }),
      Thumb: ({ className }: { readonly className?: string }) =>
        createElement('div', { className }),
    },
  };
});

const ladder: readonly MaterialRendition[] = [
  { variant: '', label: 'ORIGINAL' },
  { variant: '1080p', label: '1080P' },
  { variant: '720p', label: '720P' },
];

const material: MaterialEntry = {
  materialId: '018f0f1a-8000-7000-8000-000000000000',
  displayName: 'camera-loop.mp4',
  mimeType: 'video/mp4',
  byteSize: 8n,
  contentHash: 'a'.repeat(64),
  createdAt: '2026-08-25T00:00:00.000Z',
};

/**
 * Opens the quality menu and picks one entry by the label it shows.
 *
 * The keyboard path, because it is the one jsdom can carry honestly: Base UI's
 * pointer handling reads coordinates and hit-testing that jsdom does not
 * compute, so a synthesized `click` on an item opens the popup and then
 * commits nothing. `Enter` on the item is the same commit an operator makes
 * with the keyboard, and it fails loudly if it stops working.
 */
async function chooseRendition(label: string): Promise<void> {
  const trigger = screen.getByLabelText('Качество воспроизведения');
  await act(async () => {
    fireEvent.click(trigger);
  });
  const text = await screen.findByText(label);
  const option = text.closest('[role="option"]') ?? text;
  await act(async () => {
    fireEvent.keyDown(option, { key: 'Enter' });
  });
}

describe('the quality menu', () => {
  it('sends the variant of the entry it displays', async () => {
    const chosen: string[] = [];
    render(
      <MaterialRenditionMenu
        renditions={ladder}
        variant=""
        onVariantChange={(variant) => chosen.push(variant)}
        outcome="pending"
      />,
    );

    await chooseRendition('720P');

    // The label an operator reads and the string that goes on the wire are
    // two halves of one entry; this is the assertion that they cannot drift.
    expect(chosen).toEqual(['720p']);
  });

  it('says there is no ladder rather than offering a menu of one', () => {
    render(
      <MaterialRenditionMenu
        renditions={[{ variant: '', label: 'ORIGINAL' }]}
        variant=""
        onVariantChange={() => undefined}
        outcome="pending"
      />,
    );

    expect(screen.getByText(/БЕЗ ЛЕСТНИЦЫ КАЧЕСТВА/u)).toBeTruthy();
    expect(screen.queryByLabelText('Качество воспроизведения')).toBeNull();
  });

  it('reports an answer that was the stored object rather than implying a change', () => {
    render(
      <MaterialRenditionMenu
        renditions={ladder}
        variant="720p"
        onVariantChange={() => undefined}
        outcome="original"
      />,
    );

    expect(screen.getByText(/ВАРИАНТ НЕ СОБРАН/u)).toBeTruthy();
  });
});

describe('the file viewer', () => {
  it('asks the library for the variant the menu displays', async () => {
    const asked: string[] = [];
    const client = fakeLibrary(asked);

    render(<LocalMaterialPreview material={material} client={client} />);
    // The stored object first: a bounded material is read as a blob, which
    // needs no grant at all.
    await waitFor(() => expect(screen.getByLabelText(/Локальный медиаплеер/u)).toBeTruthy());
    expect(asked).toEqual([]);

    // The quality menu moved into the player's settings popover
    // (t5-player-rework): it opens on the gear button rather than sitting in
    // a permanently visible transport row.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Настройки плеера'));
    });
    await chooseRendition('720P');

    await waitFor(() => expect(asked).toEqual(['720p']));
  });
});

function fakeLibrary(asked: string[]): MaterialLibraryClient {
  return {
    origin: 'group-library',
    withCategory() {
      return this as unknown as MaterialLibraryClient;
    },
    importFile: () => Promise.reject(new Error('not used')),
    list: () => Promise.resolve({ materials: [], nextCursor: '' }),
    renditions: () => ladder,
    openRendition: (_material: MaterialEntry, rendition: MaterialRendition) => {
      asked.push(rendition.variant);
      return Promise.resolve({
        grantId: 'grant',
        url: 'https://s3.example.test/key',
        mimeType: 'video/mp4',
        variant: rendition.variant,
        rendered: false,
      });
    },
    async *readChunks() {
      yield { data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
    },
    getPlaybackGrant: () =>
      Promise.resolve({ grantId: 'grant', url: 'https://s3.example.test/key' }),
    revokePlaybackGrant: () => Promise.resolve(false),
  } as unknown as MaterialLibraryClient;
}
