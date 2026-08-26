// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode, Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cameraMaterialAssignmentsStorageKey } from '../infrastructure/media/cameraMaterialAssignments';
import { operationsStore } from '../state/operationsStore';
import { VideoScreen } from './VideoScreen';

/*
 * C25: `Camera.codec` and `Camera.bitrate` were declared in the domain and
 * printed on the overlay while no playback call read either, so choosing a
 * camera with a different codec changed nothing about what streamed. This
 * holds the screen to the one route the material contract gives those two
 * fields -- `GetPreviewGrant.variant` -- and to the honest report of what came
 * back.
 *
 * The seed's `K-17` is index 0: `H.265` at `4.0 Mbit/s`.
 */
const declaredVariant = 'h-265@4-0-mbit-s';

const library = vi.hoisted(() => ({
  asked: [] as string[],
  materialId: '018f0f1a-8000-7000-8000-000000000000',
  /** When set, a grant is withheld until the test releases it. */
  hold: null as null | (() => void),
  /** The bridge serves one stored object and offers no ladder at all. */
  onlyOriginal: false,
}));
const materialId = library.materialId;

vi.mock('@vidstack/react', async () => {
  const { createElement, forwardRef } = await import('react');
  return {
    isVideoProvider: () => false,
    MediaProvider: () => null,
    MediaPlayer: forwardRef(function MediaPlayerStub(
      props: { readonly children?: ReactNode },
      _ref: Ref<unknown>,
    ) {
      return createElement('div', null, props.children);
    }),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/infrastructure/materials/BridgeMaterialClient', () => {
  const material = {
    materialId: library.materialId,
    displayName: 'camera-loop.mp4',
    mimeType: 'video/mp4',
    byteSize: 64n * 1024n * 1024n,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-25T00:00:00.000Z',
  };
  class FakeBridgeMaterialClient {
    readonly origin = 'group-library';
    withCategory(): FakeBridgeMaterialClient {
      return this;
    }
    list(): Promise<{
      readonly materials: readonly (typeof material)[];
      readonly nextCursor: string;
    }> {
      return Promise.resolve({ materials: [material], nextCursor: '' });
    }
    // A ladder with more than one entry, which is what makes the declared
    // rendition worth prepending rather than being the whole menu.
    renditions(): readonly { readonly variant: string; readonly label: string }[] {
      if (library.onlyOriginal) return [{ variant: '', label: 'ORIGINAL' }];
      return [
        { variant: '', label: 'ORIGINAL' },
        { variant: '1080p', label: '1080P' },
        { variant: '720p', label: '720P' },
      ];
    }
    openRendition(
      _material: unknown,
      rendition: { readonly variant: string },
    ): Promise<{
      readonly grantId: string;
      readonly url: string;
      readonly mimeType: string;
      readonly variant: string;
      readonly rendered: boolean;
    }> {
      library.asked.push(rendition.variant);
      const grant = {
        grantId: `grant-${rendition.variant}`,
        url: `https://s3.example.test/${rendition.variant}`,
        mimeType: 'video/mp4',
        variant: rendition.variant,
        // No deployment in this repository builds a rendition ladder, so the
        // grant that comes back describes the stored object.
        rendered: false,
      };
      if (library.hold === null) return Promise.resolve(grant);
      return new Promise((resolve) => {
        library.hold = () => resolve(grant);
      });
    }
    getPlaybackGrant(): Promise<{ readonly grantId: string; readonly url: string }> {
      return Promise.resolve({ grantId: 'grant', url: 'https://s3.example.test/original' });
    }
    revokePlaybackGrant(): Promise<boolean> {
      return Promise.resolve(false);
    }
  }
  return { BridgeMaterialClient: FakeBridgeMaterialClient };
});

class StubIntersectionObserver {
  constructor(_callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const nativeIntersectionObserver = globalThis.IntersectionObserver as
  typeof IntersectionObserver | undefined;

describe('the declared codec and bitrate of a camera (C25)', () => {
  beforeEach(() => {
    library.asked.length = 0;
    library.hold = null;
    library.onlyOriginal = false;
    localStorage.clear();
    localStorage.setItem(
      cameraMaterialAssignmentsStorageKey,
      JSON.stringify({ 'K-17': materialId }),
    );
    globalThis.IntersectionObserver =
      StubIntersectionObserver as unknown as typeof IntersectionObserver;
    operationsStore.getState().resetWorld();
  });

  afterEach(() => {
    if (nativeIntersectionObserver === undefined) {
      Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    } else {
      globalThis.IntersectionObserver = nativeIntersectionObserver;
    }
  });

  it('reaches the grant request as the variant the channel opens on', async () => {
    render(<VideoScreen mode="cameras" />);
    // The assignments are read on a task rather than during render, so the
    // material is not assigned to the channel until it has run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(library.asked).toContain(declaredVariant));
    // And it is asked for once rather than in a loop of re-opened grants.
    expect(library.asked.filter((variant) => variant === declaredVariant)).toHaveLength(1);
  });

  it('says the deployment served the stored object rather than implying a rendition', async () => {
    const { container } = render(<VideoScreen mode="cameras" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(library.asked).toContain(declaredVariant));
    await waitFor(() =>
      expect(
        container.querySelector('.material-rendition-menu__outcome')?.getAttribute('data-outcome'),
      ).toBe('original'),
    );
  });

  it('stops presenting the previous rendition the moment another is chosen', async () => {
    const { container } = render(<VideoScreen mode="cameras" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(cameraMaterialStatus(container)).toContain('RANGE STREAM READY'));

    // The next grant is withheld, which is the state the operator is in for as
    // long as the request is in flight.
    library.hold = () => undefined;
    const trigger = screen.getByLabelText('Качество воспроизведения');
    await act(async () => {
      fireEvent.click(trigger);
    });
    const option = (await screen.findByText('1080P')).closest('[role="option"]');
    await act(async () => {
      fireEvent.keyDown(option ?? screen.getByText('1080P'), { key: 'Enter' });
    });

    // The channel used to keep playing the rendition it had while the menu
    // named a different one, because a source was identified by its camera and
    // material alone.
    expect(library.asked).toContain('1080p');
    await waitFor(() => expect(cameraMaterialStatus(container)).toContain('LOADING'));
  });
});

describe('a library that offers no ladder', () => {
  beforeEach(() => {
    library.asked.length = 0;
    library.hold = null;
    library.onlyOriginal = true;
    localStorage.clear();
    localStorage.setItem(
      cameraMaterialAssignmentsStorageKey,
      JSON.stringify({ 'K-17': materialId }),
    );
    globalThis.IntersectionObserver =
      StubIntersectionObserver as unknown as typeof IntersectionObserver;
    operationsStore.getState().resetWorld();
  });

  afterEach(() => {
    if (nativeIntersectionObserver === undefined) {
      delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    } else {
      globalThis.IntersectionObserver = nativeIntersectionObserver;
    }
  });

  it('opens the channel on the original instead of waiting for a variant nobody serves', async () => {
    const { container } = render(<VideoScreen />);

    // The declared codec named a variant the library does not offer. Seeding it
    // anyway left the channel loading forever, because the grant that came back
    // always described the original and never matched what was asked for.
    await waitFor(() => expect(cameraMaterialStatus(container)).toContain('READY'));
    // The original travels the plain grant path, so no variant is asked for at
    // all -- and in particular not the declared one, which nothing would serve.
    expect(library.asked).toEqual([]);
  });
});

function cameraMaterialStatus(container: HTMLElement): string {
  return container.querySelector('.camera-material-status')?.textContent ?? '';
}
