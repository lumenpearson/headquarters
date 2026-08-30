// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useImperativeHandle, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { LocalMaterialPlayer } from './LocalMaterialPlayer';
import type { MaterialSubtitleTrack } from './materialSubtitleTracks';

/*
 * Same reasoning throughout: vidstack loads a real provider against a real
 * media element, which jsdom does not implement. The stubs below render the
 * player's children/overlay structure so the point under test -- what
 * `LocalMaterialPlayer` hands its own controls, and how it reacts to pointer
 * and focus -- is in the tree to be driven, not how vidstack itself renders.
 */
const fakeTextTrack = vi.hoisted(() => ({ kind: 'subtitles', mode: 'showing' }));

/** The one player instance the mock hands out, inspectable from a test. */
const mockPlayer = vi.hoisted(() => ({
  paused: true,
  duration: 0,
  muted: false,
  currentTime: 0,
  playbackRate: 1,
  volume: 1,
  textTracks: { getByKind: () => [fakeTextTrack] },
  play: () => Promise.resolve(),
  pause: () => Promise.resolve(),
  enterFullscreen: () => Promise.resolve(),
}));

/** The `onCanPlay`/`onTimeUpdate` callbacks the surface was last rendered with. */
const mockCallbacks = vi.hoisted(() => ({
  onCanPlay: undefined as ((detail: { duration: number }) => void) | undefined,
  onTimeUpdate: undefined as ((detail: { currentTime: number }) => void) | undefined,
}));

vi.mock('@vidstack/react', async () => {
  const { createElement, forwardRef: mockForwardRef } = await import('react');
  return {
    MediaProvider: ({ children }: { readonly children?: ReactNode }) =>
      createElement('div', null, children),
    Track: (props: {
      readonly src?: string;
      readonly label?: string;
      readonly lang?: string;
      readonly default?: boolean;
    }) =>
      createElement('div', {
        'data-testid': 'subtitle-track',
        'data-src': props.src,
        'data-label': props.label,
        'data-lang': props.lang,
        'data-default': props.default ?? false,
      }),
    MediaPlayer: mockForwardRef(function MediaPlayerStub(
      props: {
        readonly children?: ReactNode;
        readonly 'aria-label'?: string;
        readonly onPointerEnter?: () => void;
        readonly onPointerLeave?: () => void;
        readonly onFocus?: () => void;
        readonly onBlur?: () => void;
        readonly onCanPlay?: (detail: { duration: number }) => void;
        readonly onTimeUpdate?: (detail: { currentTime: number }) => void;
      },
      ref: unknown,
    ) {
      mockCallbacks.onCanPlay = props.onCanPlay;
      mockCallbacks.onTimeUpdate = props.onTimeUpdate;
      useImperativeHandle(ref as never, () => mockPlayer, []);
      return createElement(
        'div',
        {
          'aria-label': props['aria-label'],
          onPointerEnter: props.onPointerEnter,
          onPointerLeave: props.onPointerLeave,
          onFocus: props.onFocus,
          onBlur: props.onBlur,
        },
        props.children,
      );
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

const tracks: readonly MaterialSubtitleTrack[] = [
  { id: 'a', url: 'blob:english', label: 'EN', srcLang: 'en', default: true },
  { id: 'b', url: 'blob:russian', label: 'RU', srcLang: 'ru', default: false },
];

function surface(): HTMLElement {
  return screen.getByLabelText(/Локальный медиаплеер/u);
}

function hoverRow(): HTMLElement {
  const row = document.querySelector('.local-material-player__hover-row');
  if (row === null) throw new Error('hover row not rendered');
  return row as HTMLElement;
}

beforeEach(() => {
  operationsStore.getState().resetWorld();
  mockPlayer.muted = false;
  mockPlayer.playbackRate = 1;
  mockPlayer.volume = 1;
  mockPlayer.currentTime = 0;
});

describe('LocalMaterialPlayer subtitles', () => {
  it('renders one Track per resolved subtitle track', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" tracks={tracks} />);

    const rendered = screen.getAllByTestId('subtitle-track');
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.getAttribute('data-src')).toBe('blob:english');
    expect(rendered[0]?.getAttribute('data-lang')).toBe('en');
    expect(rendered[0]?.getAttribute('data-default')).toBe('true');
    expect(rendered[1]?.getAttribute('data-src')).toBe('blob:russian');
  });

  it('shows no caption toggle and no track for a material with none', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

    expect(screen.queryAllByTestId('subtitle-track')).toHaveLength(0);
    expect(screen.queryByText(/\[CC\]/u)).toBeNull();
  });

  it('toggles every subtitle/caption track off, then back on, from the settings menu', async () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" tracks={tracks} />);

    fireEvent.click(screen.getByLabelText('Настройки плеера'));
    const toggle = await screen.findByText('[CC] SUBS ON');
    fireEvent.click(toggle);
    expect(fakeTextTrack.mode).toBe('disabled');
    expect(await screen.findByText('[CC] SUBS OFF')).toBeTruthy();

    fireEvent.click(screen.getByText('[CC] SUBS OFF'));
    expect(fakeTextTrack.mode).toBe('showing');
  });
});

describe('LocalMaterialPlayer control-layer reveal', () => {
  it('hides every control but the progress bar and the settings button by default', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

    expect(hoverRow().getAttribute('data-revealed')).toBe('false');
    // Present, not merely visible: reachable by keyboard whether or not the
    // pointer has ever touched the surface.
    expect(screen.getByText('[▶] PLAY')).toBeTruthy();
    expect(screen.getByLabelText('Позиция воспроизведения')).toBeTruthy();
    expect(screen.getByLabelText('Настройки плеера')).toBeTruthy();
  });

  it('reveals on pointer over the viewing area', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

    fireEvent.pointerEnter(surface());
    expect(hoverRow().getAttribute('data-revealed')).toBe('true');

    fireEvent.pointerLeave(surface());
    // Not yet hidden -- `player.controlsHideDelayMs` holds it a while first.
    expect(hoverRow().getAttribute('data-revealed')).toBe('true');
  });

  it('reveals on focus within the control layer, independent of the pointer', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

    fireEvent.focus(screen.getByText('[▶] PLAY'));
    expect(hoverRow().getAttribute('data-revealed')).toBe('true');

    fireEvent.blur(screen.getByText('[▶] PLAY'));
    expect(hoverRow().getAttribute('data-revealed')).toBe('true');
  });

  describe('the configured hide delay', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('hides again only once neither the pointer nor focus remain, after the delay', () => {
      render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

      fireEvent.pointerEnter(surface());
      fireEvent.pointerLeave(surface());
      expect(hoverRow().getAttribute('data-revealed')).toBe('true');

      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(hoverRow().getAttribute('data-revealed')).toBe('false');
    });
  });
});

describe('LocalMaterialPlayer settings wiring', () => {
  it('applies player.startMuted, player.defaultRate and player.defaultVolume on mount', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

    // Factory defaults: player.startMuted=true, player.defaultRate=1,
    // player.defaultVolume=35.
    expect(mockPlayer.muted).toBe(true);
    expect(mockPlayer.playbackRate).toBe(1);
    expect(mockPlayer.volume).toBeCloseTo(0.35);
  });

  it('lets a mute toggle on the surface outlive the configured default', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

    expect(mockPlayer.muted).toBe(true);
    fireEvent.click(screen.getByText('[M] MUTED'));
    expect(mockPlayer.muted).toBe(false);
  });
});

describe('LocalMaterialPlayer position-preserving rendition switch', () => {
  it('captures the current position before a source swap and seeks back once the new source can play', () => {
    const { rerender } = render(
      <LocalMaterialPlayer sourceUrl="blob:variant-a" title="clip.mp4" />,
    );

    act(() => {
      mockCallbacks.onTimeUpdate?.({ currentTime: 42 });
    });

    rerender(<LocalMaterialPlayer sourceUrl="blob:variant-b" title="clip.mp4" />);
    mockPlayer.currentTime = 0;

    act(() => {
      mockCallbacks.onCanPlay?.({ duration: 120 });
    });

    expect(mockPlayer.currentTime).toBe(42);
  });

  it('does not seek anywhere for a fresh mount with nothing played yet', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:variant-a" title="clip.mp4" />);
    mockPlayer.currentTime = 0;

    act(() => {
      mockCallbacks.onCanPlay?.({ duration: 120 });
    });

    expect(mockPlayer.currentTime).toBe(0);
  });
});

describe('LocalMaterialPlayer remembered position', () => {
  it('seeks to initialTime once, on the source that was ready when it was passed', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" initialTime={17} />);

    act(() => {
      mockCallbacks.onCanPlay?.({ duration: 120 });
    });

    expect(mockPlayer.currentTime).toBe(17);
  });
});
