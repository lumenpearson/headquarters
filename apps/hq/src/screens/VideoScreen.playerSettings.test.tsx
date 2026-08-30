// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import type { ReactNode, Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '../state/operationsStore.js';
import { VideoScreen } from './VideoScreen.js';

/*
 * C20: `player.defaultRate` and `performance.inactiveDecode` were rendered,
 * validated and saved by the settings editor and read by nothing. These tests
 * hold the video surface to what the two definitions promise -- the rate the
 * player starts at, and a stream that stops decoding once nobody can see it.
 *
 * The player itself is stubbed rather than mounted. Vidstack loads a provider
 * against a real media element, which jsdom does not implement; the stub keeps
 * the properties the screen writes (`playbackRate`, `paused`) so an assertion
 * can read back what the screen asked the player to do.
 */
const media = vi.hoisted(() => {
  interface StubPlayer {
    el: HTMLElement | null;
    playbackRate: number;
    loop: boolean;
    volume: number;
    muted: boolean;
    paused: boolean;
    currentTime: number;
    duration: number;
    provider: null;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    startLoading: () => void;
    enterFullscreen: () => Promise<void>;
    enterPictureInPicture: () => Promise<void>;
  }

  const players: StubPlayer[] = [];

  const createPlayer = (): StubPlayer => {
    const player: StubPlayer = {
      el: null,
      playbackRate: 1,
      loop: false,
      volume: 1,
      muted: false,
      paused: true,
      currentTime: 0,
      duration: 18,
      provider: null,
      play: () => {
        player.paused = false;
        return Promise.resolve();
      },
      pause: () => {
        player.paused = true;
        return Promise.resolve();
      },
      startLoading: () => undefined,
      enterFullscreen: () => Promise.resolve(),
      enterPictureInPicture: () => Promise.resolve(),
    };
    players.push(player);
    return player;
  };

  return { createPlayer, players };
});

vi.mock('@vidstack/react', async () => {
  const { createElement, forwardRef, useImperativeHandle, useRef } = await import('react');
  return {
    isVideoProvider: () => false,
    MediaProvider: () => null,
    MediaPlayer: forwardRef(function MediaPlayerStub(
      props: {
        readonly className?: string;
        readonly children?: ReactNode;
        readonly loop?: boolean;
        readonly volume?: number;
        readonly playbackRate?: number;
        readonly muted?: boolean;
      },
      ref: Ref<unknown>,
    ) {
      const playerRef = useRef<ReturnType<typeof media.createPlayer> | null>(null);
      playerRef.current ??= media.createPlayer();
      const player = playerRef.current;
      // `loop`, `volume`, `playbackRate` and `muted` are controlled
      // `<MediaPlayer>` props, not written onto the instance imperatively --
      // the real player re-applies them from its own props on every render
      // (and, in particular, re-applies its own 1/1/false defaults on every
      // can-play if a caller never passes them). Mirroring that here is what
      // makes a source change that leaves an imperative-only assignment
      // stranded show up as a failure instead of passing by construction.
      player.loop = props.loop === true;
      player.volume = props.volume ?? 1;
      player.playbackRate = props.playbackRate ?? 1;
      player.muted = props.muted ?? false;
      useImperativeHandle(ref, () => player, [player]);
      return createElement(
        'div',
        {
          className: props.className,
          // The gate observes the player's host element, so the stub has to
          // own a real one for the observer to be given anything to watch.
          ref: (node: HTMLDivElement | null) => {
            player.el = node;
          },
        },
        props.children,
      );
    }),
  };
});

// VideoScreen calls useRouter() from next/navigation, which throws outside an
// App Router tree. Nothing in these tests navigates.
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

/**
 * jsdom implements no layout and therefore no `IntersectionObserver`. The stub
 * reports only what a test states, which is the point: an observer that
 * invented a box would have these tests asserting a visibility jsdom never
 * computed.
 */
class StubIntersectionObserver {
  static readonly instances: StubIntersectionObserver[] = [];
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    StubIntersectionObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  report(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const nativeIntersectionObserver = globalThis.IntersectionObserver as
  typeof IntersectionObserver | undefined;

function setDocumentVisibility(visibility: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
}

function latestPlayer(): ReturnType<typeof media.createPlayer> {
  const player = media.players.at(-1);
  if (player === undefined) throw new Error('the media player stub was never rendered');
  return player;
}

function latestObserver(): StubIntersectionObserver {
  const observer = StubIntersectionObserver.instances.at(-1);
  if (observer === undefined) throw new Error('the decode gate observed nothing');
  return observer;
}

function patchSetting(id: string, value: number | boolean | string): void {
  act(() => {
    operationsStore.getState().applySettingsPatch([{ id, value }]);
  });
}

let snapshot = operationsStore.getState();

beforeEach(() => {
  snapshot = operationsStore.getState();
  media.players.length = 0;
  StubIntersectionObserver.instances.length = 0;
  globalThis.IntersectionObserver =
    StubIntersectionObserver as unknown as typeof IntersectionObserver;
  setDocumentVisibility('visible');
});

afterEach(() => {
  act(() => {
    operationsStore.setState({ personalization: snapshot.personalization, ui: snapshot.ui });
  });
  if (nativeIntersectionObserver === undefined) {
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  } else {
    globalThis.IntersectionObserver = nativeIntersectionObserver;
  }
  setDocumentVisibility('visible');
});

describe('player.defaultRate', () => {
  it('starts the player at the rate the schema defaults to', () => {
    render(<VideoScreen mode="live" />);

    expect(latestPlayer().playbackRate).toBe(1);
  });

  it('starts the player at the rate the setting names', () => {
    patchSetting('player.defaultRate', 1.5);

    render(<VideoScreen mode="live" />);

    expect(latestPlayer().playbackRate).toBe(1.5);
  });

  it('re-seeds the transport when the setting moves under a mounted screen', () => {
    render(<VideoScreen mode="live" />);
    expect(latestPlayer().playbackRate).toBe(1);

    patchSetting('player.defaultRate', 0.5);

    expect(latestPlayer().playbackRate).toBe(0.5);
  });
});

describe('player.defaultVolume', () => {
  it('opens the surface at the volume the setting names, and lets the screen win after', () => {
    patchSetting('player.defaultVolume', 80);
    render(<VideoScreen mode="live" />);

    // Stored as a percentage: `numberWithin` takes its step from the bounds, so
    // a 0..1 range would ship a slider stepping by whole units.
    expect(latestPlayer().volume).toBeCloseTo(0.8, 5);
  });

  it('re-seeds a screen nobody touched when the setting moves', () => {
    render(<VideoScreen mode="live" />);
    expect(latestPlayer().volume).toBeCloseTo(0.35, 5);

    patchSetting('player.defaultVolume', 10);

    expect(latestPlayer().volume).toBeCloseTo(0.1, 5);
  });
});

/*
 * A camera switch changes `src` and re-renders the surface without touching
 * `player.defaultRate`/`player.defaultVolume` themselves -- the exact
 * source-change Vidstack's own `ready()` re-applies its `<MediaPlayer>`
 * props on, defaulting to 1 when a caller does not pass them as props. An
 * imperative `player.volume = x`/`player.playbackRate = x` assignment whose
 * effect dependency list does not include the source loses this race: the
 * effect does not re-run just because the camera changed, so the value
 * Vidstack's reset leaves behind (1) stands unless the value reaches the
 * provider as a controlled prop instead (t5-player-rework, R-defect).
 */
describe('player.defaultRate and player.defaultVolume across a source change', () => {
  it('keeps the configured rate and volume after a camera switch instead of resetting to the Vidstack default', () => {
    patchSetting('player.defaultRate', 1.5);
    patchSetting('player.defaultVolume', 80);
    render(<VideoScreen mode="live" />);
    expect(latestPlayer().playbackRate).toBe(1.5);
    expect(latestPlayer().volume).toBeCloseTo(0.8, 5);

    act(() => {
      operationsStore.getState().selectCamera('CAM-02');
    });

    expect(latestPlayer().playbackRate).toBe(1.5);
    expect(latestPlayer().volume).toBeCloseTo(0.8, 5);
  });
});

describe('player.loopDemo', () => {
  it('stops repeating a finite source when the operator switches it off', () => {
    render(<VideoScreen mode="live" />);
    // The demo surveillance clip is finite, so it loops by default.
    expect(latestPlayer().loop).toBe(true);

    patchSetting('player.loopDemo', false);

    expect(latestPlayer().loop).toBe(false);
  });
});

describe('player.seekStep', () => {
  it('names its own step on the control, so the button cannot promise one figure and move another', () => {
    const { getByText } = render(<VideoScreen mode="live" />);
    expect(getByText('[◀] -10S')).toBeTruthy();
    expect(getByText('[▶] +10S')).toBeTruthy();

    patchSetting('player.seekStep', 30);

    expect(getByText('[◀] -30S')).toBeTruthy();
    expect(getByText('[▶] +30S')).toBeTruthy();
  });

  /*
   * What this does not prove, said rather than left to be assumed: the distance
   * playback actually travels. `seekBy` reaches `requestPlaybackAction`, which
   * publishes to the playback sync coordinator and returns before touching the
   * player whenever a sync target exists -- which it does on this surface. The
   * local position is therefore unchanged in this harness at every step size,
   * and an assertion on it would pass for both 5 and 10 and prove nothing. The
   * label above is a real consumer and the same variable feeds both it and the
   * handler; the travelled distance belongs to a Playwright case against the
   * real coordinator.
   */
});

describe('cameras.ptzStep', () => {
  it('moves the pad by the degrees the setting names', () => {
    // The pad is only mounted on the camera wall, not the live surface.
    const { getByText } = render(<VideoScreen mode="cameras" />);
    expect(operationsStore.getState().ui.ptz.tilt).toBe(0);

    act(() => {
      fireEvent.click(getByText('▲'));
    });
    // Up is a negative tilt, and the schema default is 5.
    expect(operationsStore.getState().ui.ptz.tilt).toBe(-5);

    patchSetting('cameras.ptzStep', 20);
    act(() => {
      fireEvent.click(getByText('▲'));
    });
    expect(operationsStore.getState().ui.ptz.tilt).toBe(-25);
  });
});

describe('performance.inactiveDecode', () => {
  it('stops decoding while the document is hidden and decodes again when it returns', () => {
    render(<VideoScreen mode="live" />);
    const player = latestPlayer();
    // ui.videoPlaying is on in the seeded runtime, so the surface starts live.
    expect(player.paused).toBe(false);

    act(() => {
      setDocumentVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(player.paused).toBe(true);

    act(() => {
      setDocumentVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(player.paused).toBe(false);
  });

  it('stops decoding while the surface itself is off screen', () => {
    render(<VideoScreen mode="live" />);
    const player = latestPlayer();

    act(() => {
      latestObserver().report(false);
    });
    expect(player.paused).toBe(true);

    act(() => {
      latestObserver().report(true);
    });
    expect(player.paused).toBe(false);
  });

  it('keeps an invisible stream decoding while the setting is off', () => {
    patchSetting('performance.inactiveDecode', false);

    render(<VideoScreen mode="live" />);
    const player = latestPlayer();
    expect(player.paused).toBe(false);

    act(() => {
      setDocumentVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(player.paused).toBe(false);

    // The other signal is ignored just as squarely: the gate keeps listening
    // so that turning the setting back on decides on what the browser reports
    // then, and reports arriving meanwhile change nothing.
    act(() => {
      latestObserver().report(false);
    });

    expect(player.paused).toBe(false);
  });

  it('leaves a paused stream paused when the surface comes back', () => {
    render(<VideoScreen mode="live" />);
    const player = latestPlayer();

    act(() => {
      operationsStore.getState().setVideoPlaying(false);
    });
    expect(player.paused).toBe(true);

    act(() => {
      setDocumentVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      setDocumentVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(player.paused).toBe(true);
  });
});
