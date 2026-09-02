// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import type { ReactNode, Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initialConnectionState } from '../application/sync/connection';
import { operationsStore } from '../state/operationsStore';
import { VideoScreen } from './VideoScreen';

/*
 * R27: `TimeSync` measured the clock offset every minute, two surfaces printed
 * it, and nothing applied it. `PlaybackSyncCoordinator` proves what the offset
 * does to two screens; this proves that the offset reaches it at all, which is
 * the wire that was missing. Nothing here mocks the coordinator: the screen
 * builds a real one over the browser transport, and the assertion reads the
 * instant that transport actually put on the wire.
 */
const publishedKeyPrefix = '__gremuchaya_playback_sync_v1__:';
/*
 * A lead the operator set, rather than the one `performance.playbackLeadMs`
 * defaults to. Zero would let an instant that carried no lead at all pass, and
 * a non-zero one puts both quantities on the same command: the lead is added
 * once, the offset is applied once, and they compose instead of standing in
 * for each other.
 */
const configuredLeadMs = 200;

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

let writes: ReturnType<typeof vi.spyOn<Storage, 'setItem'>>;
let snapshot = operationsStore.getState();

beforeEach(() => {
  snapshot = operationsStore.getState();
  // Called through rather than replaced: the transport's own write is what is
  // being read, and everything else this screen stores has to keep working.
  writes = vi.spyOn(Storage.prototype, 'setItem');
  act(() => {
    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'performance.playbackLeadMs', value: configuredLeadMs }]);
  });
});

afterEach(() => {
  writes.mockRestore();
  act(() => {
    operationsStore.getState().patchConnection(initialConnectionState);
    operationsStore.setState({ personalization: snapshot.personalization });
  });
});

/** The instant the browser transport actually published, off the wire. */
function publishedExecuteAtMs(): number {
  const frames = writes.mock.calls.filter(([key]) => String(key).startsWith(publishedKeyPrefix));
  const last = frames.at(-1);
  if (last === undefined) throw new Error('the screen published no playback command');
  const frame: unknown = JSON.parse(String(last[1]));
  const executeAtMs = (frame as { command?: { executeAtMs?: unknown } }).command?.executeAtMs;
  if (typeof executeAtMs !== 'number') throw new Error('the published frame carried no instant');
  return executeAtMs;
}

/*
 * `[●] ЭФИР` rather than a seek button: `seekBy` needs a media element to read
 * a position from, and this stub deliberately mounts none. `goLive` reaches
 * the same `requestPlaybackAction`, which is the only part of the path these
 * tests are about.
 */
function commandOnce(getByText: (text: string) => HTMLElement): {
  before: number;
  after: number;
} {
  const before = Date.now();
  act(() => {
    fireEvent.click(getByText('[●] ЭФИР'));
  });
  return { before, after: Date.now() };
}

describe('the playback instant this screen publishes', () => {
  it('is stamped on the group clock when TimeSync has measured an offset', () => {
    /*
     * Four seconds is far outside the lead, so this range cannot be reached by
     * a screen stamping its own clock -- which is the whole failure R27 named.
     * The bound is a window rather than an equality because the coordinator
     * reads `Date.now()` between the two readings taken here.
     */
    const offsetMs = 4_000;
    act(() => {
      operationsStore
        .getState()
        .patchConnection({ clock: { offsetMs, latencyMs: 12, sampledAt: '2026-08-27T00:00:00Z' } });
    });
    const { getByText } = render(<VideoScreen mode="live" />);

    const { before, after } = commandOnce(getByText);

    expect(publishedExecuteAtMs()).toBeGreaterThanOrEqual(before + offsetMs + configuredLeadMs);
    expect(publishedExecuteAtMs()).toBeLessThanOrEqual(after + offsetMs + configuredLeadMs);
  });

  it('is stamped on this machine when no offset has been measured', () => {
    /*
     * The single machine, which is every installation until a control plane is
     * configured: the estimate is zero, the conversion is an identity, and the
     * instant is exactly what it was before the offset was wired through.
     */
    const { getByText } = render(<VideoScreen mode="live" />);

    const { before, after } = commandOnce(getByText);

    expect(publishedExecuteAtMs()).toBeGreaterThanOrEqual(before + configuredLeadMs);
    expect(publishedExecuteAtMs()).toBeLessThanOrEqual(after + configuredLeadMs);
  });
});
