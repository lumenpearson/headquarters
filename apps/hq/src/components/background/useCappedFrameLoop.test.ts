// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCappedFrameLoop } from './useCappedFrameLoop';

/**
 * A controllable stand-in for `requestAnimationFrame`/`cancelAnimationFrame`.
 * jsdom's own timers never call a real rAF callback, and letting the browser
 * decide when a frame runs is exactly what would make "no frame is
 * scheduled" unprovable -- these count and can cancel every call the hook
 * makes instead.
 */
function installFrameMocks() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const requestSpy = vi.fn((callback: FrameRequestCallback) => {
    nextId += 1;
    pending.set(nextId, callback);
    return nextId;
  });
  const cancelSpy = vi.fn((handle: number) => {
    pending.delete(handle);
  });
  vi.stubGlobal('requestAnimationFrame', requestSpy);
  vi.stubGlobal('cancelAnimationFrame', cancelSpy);
  return {
    requestSpy,
    cancelSpy,
    pendingCount: () => pending.size,
    flush(now: number) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(now);
    },
  };
}

/** A controllable stand-in for `window.matchMedia`, so a test can flip the OS preference mid-run. */
function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  let changeListener: (() => void) | null = null;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_event: string, listener: () => void) => {
        changeListener = listener;
      },
      removeEventListener: () => {
        changeListener = null;
      },
    })),
  );
  return {
    setMatches(next: boolean) {
      matches = next;
      changeListener?.();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useCappedFrameLoop', () => {
  it('schedules no animation frame while paused, and none again once it resumes into pause', () => {
    const frames = installFrameMocks();
    const { rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useCappedFrameLoop({ paused, speed: 1, maxFps: 24 }),
      { initialProps: { paused: true } },
    );

    expect(frames.requestSpy).not.toHaveBeenCalled();

    act(() => rerender({ paused: false }));
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    act(() => rerender({ paused: true }));
    // Cancels the frame the running state had pending, rather than letting it
    // land and reschedule on its own -- and does not immediately ask for a
    // replacement, which a merely-cosmetic pause would still do.
    expect(frames.cancelSpy).toHaveBeenCalled();
    expect(frames.pendingCount()).toBe(0);
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    // Nothing brings the loop back on its own: advancing the same clock the
    // capped loop paces itself with must not produce a new call either.
    act(() => vi.advanceTimersByTime(1000));
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling once the operating system asks for reduced motion, independent of the setting', () => {
    const frames = installFrameMocks();
    const media = installMatchMedia(false);
    renderHook(() => useCappedFrameLoop({ paused: false, speed: 1, maxFps: 24 }));

    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    act(() => media.setMatches(true));
    expect(frames.cancelSpy).toHaveBeenCalled();
    // The flip itself must not immediately ask for a replacement frame.
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling while the document is hidden, and resumes once it is visible again', () => {
    const frames = installFrameMocks();
    renderHook(() => useCappedFrameLoop({ paused: false, speed: 1, maxFps: 24 }));
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(frames.cancelSpy).toHaveBeenCalled();
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(frames.requestSpy).toHaveBeenCalledTimes(2);
  });

  it('paces the next scheduled frame to the requested ceiling rather than to every animation frame', () => {
    const frames = installFrameMocks();
    renderHook(() => useCappedFrameLoop({ paused: false, speed: 1, maxFps: 10 })); // 10fps = 100ms apart

    expect(frames.requestSpy).toHaveBeenCalledTimes(1);
    // Commits the first paint, which is what schedules the next one -- the
    // cap lives in the delay before that scheduling, not in a check inside
    // the paint itself.
    act(() => frames.flush(0));

    // Short of the 100ms interval: no new frame requested yet.
    act(() => vi.advanceTimersByTime(60));
    expect(frames.requestSpy).toHaveBeenCalledTimes(1);

    // Past it: exactly one more.
    act(() => vi.advanceTimersByTime(60));
    expect(frames.requestSpy).toHaveBeenCalledTimes(2);
  });
});
